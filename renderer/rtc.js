/*
 * Signaling-Client + WebRTC-Sitzungen fuer Host (Sender) und Zuschauer.
 *
 * P2P-Modus = Mesh: Der Host baut zu jedem Zuschauer eine eigene
 * RTCPeerConnection auf und sendet ihm einen eigenen Stream. Upload des
 * Hosts ~ Bitrate x Zuschauer.
 */

/* ---------- Signaling ---------- */

export class Signaling extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.peerId = null;
    this.pingTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(new Error(`Ungültige Server-Adresse: ${this.url}`));
        return;
      }
      this.ws = ws;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error('Server antwortet nicht.'));
      }, 8000);

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'welcome' && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.peerId = msg.peerId;
          this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25000);
          resolve(msg);
        }
        this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Verbindung zum Server fehlgeschlagen.'));
      };
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        this.dispatchEvent(new CustomEvent('disconnected'));
      };
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // Schickt eine Anfrage und wartet auf den passenden Antwort-Typ oder einen Fehler.
  request(msg, okType) {
    return new Promise((resolve, reject) => {
      const onOk = (e) => { cleanup(); resolve(e.detail); };
      const onErr = (e) => { cleanup(); reject(Object.assign(new Error(e.detail.message), { code: e.detail.code })); };
      const cleanup = () => {
        this.removeEventListener(okType, onOk);
        this.removeEventListener('error', onErr);
      };
      this.addEventListener(okType, onOk);
      this.addEventListener('error', onErr);
      this.send(msg);
    });
  }

  on(type, fn) {
    this.addEventListener(type, (e) => fn(e.detail));
  }

  close() {
    clearInterval(this.pingTimer);
    if (this.ws) {
      this.send({ type: 'leave' });
      this.ws.close();
    }
  }
}

/* ---------- SDP-Helfer ---------- */

// Opus auf Stereo und hohe Zielrate stellen. Die tatsaechliche Rate begrenzt
// danach sender.setParameters(maxBitrate) – das laesst sich live aendern,
// ohne neu zu verhandeln.
function tuneOpus(sdp) {
  const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!m) return sdp;
  const pt = m[1];
  const extra = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000', usedtx: '0', cbr: '0' };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) {
    return sdp.replace(re, (_all, params) => {
      const map = new Map(params.split(';').filter(Boolean).map((p) => p.trim().split('=')));
      for (const [k, v] of Object.entries(extra)) map.set(k, v);
      return `a=fmtp:${pt} ` + [...map].map(([k, v]) => `${k}=${v}`).join(';');
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ` + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(';'));
}

const CODEC_MIME = { h264: 'video/H264', vp9: 'video/VP9', av1: 'video/AV1', vp8: 'video/VP8' };

function applyCodecPreference(transceiver, codec) {
  // Chromium prueft setCodecPreferences gegen die EMPFANGS-Faehigkeiten –
  // mit der Sender-Liste (andere H.264-Profile) wirft es InvalidModificationError.
  const caps = RTCRtpReceiver.getCapabilities('video');
  if (!caps || !transceiver.setCodecPreferences) return;
  const wanted = CODEC_MIME[codec];
  if (!wanted) return;
  const preferred = caps.codecs.filter((c) => c.mimeType.toLowerCase() === wanted.toLowerCase());
  if (!preferred.length) return; // Codec nicht verfuegbar -> Browser-Standard
  const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== wanted.toLowerCase());
  try { transceiver.setCodecPreferences([...preferred, ...rest]); } catch { /* ignorieren */ }
}

/* ---------- Host ---------- */

export class HostSession extends EventTarget {
  constructor({ signaling, iceServers, stream, settings }) {
    super();
    this.sig = signaling;
    this.iceServers = iceServers;
    this.stream = stream;
    this.settings = settings;
    this.peers = new Map(); // peerId -> { pc, name, video, audio, pending, stats }
    this.statsTimer = setInterval(() => this.collectStats(), 1000);

    this.sig.on('viewer-joined', (m) => this.addViewer(m.peerId, m.name));
    this.sig.on('viewer-left', (m) => this.removeViewer(m.peerId));
    this.sig.on('signal', (m) => this.onSignal(m.from, m.data));
  }

  emitChange() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  async addViewer(peerId, name) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = { pc, name, pending: [], remoteSet: false, stats: {}, prev: null, state: 'verbinde' };
    this.peers.set(peerId, peer);

    // Transceiver immer fuer Bild UND Ton anlegen – so kann Ton spaeter per
    // replaceTrack ein-/ausgeschaltet werden, ohne neu zu verhandeln.
    peer.video = pc.addTransceiver('video', { direction: 'sendonly' });
    peer.audio = pc.addTransceiver('audio', { direction: 'sendonly' });
    applyCodecPreference(peer.video, this.settings.codec);
    await this.attachTracks(peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.sig.send({ type: 'signal', to: peerId, data: { candidate: e.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => {
      const map = { new: 'verbinde', connecting: 'verbinde', connected: 'verbunden', disconnected: 'unterbrochen', failed: 'fehlgeschlagen', closed: 'getrennt' };
      peer.state = map[pc.connectionState] || pc.connectionState;
      if (pc.connectionState === 'connected') this.applyEncoding(peer);
      // Bei 'failed' einmal ICE neu starten (z. B. Netzwechsel beim Zuschauer).
      if (pc.connectionState === 'failed' && !peer.restarted) {
        peer.restarted = true;
        this.negotiate(peerId, { iceRestart: true });
      }
      this.emitChange();
    };

    await this.negotiate(peerId);
    this.emitChange();
  }

  async negotiate(peerId, opts = {}) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const offer = await peer.pc.createOffer(opts);
    offer.sdp = tuneOpus(offer.sdp);
    await peer.pc.setLocalDescription(offer);
    this.sig.send({ type: 'signal', to: peerId, data: { sdp: peer.pc.localDescription.toJSON() } });
  }

  async onSignal(from, data) {
    const peer = this.peers.get(from);
    if (!peer) return;
    if (data.sdp && data.sdp.type === 'answer') {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: tuneOpus(data.sdp.sdp) });
      peer.remoteSet = true;
      for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate) {
      if (peer.remoteSet) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pending.push(data.candidate);
    }
  }

  removeViewer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(peerId);
    this.emitChange();
  }

  kick(peerId) {
    this.sig.send({ type: 'kick', peerId });
    this.removeViewer(peerId);
  }

  async attachTracks(peer) {
    const v = this.stream.getVideoTracks()[0] || null;
    const a = this.settings.appAudio ? this.stream.getAudioTracks()[0] || null : null;
    await peer.video.sender.replaceTrack(v);
    await peer.audio.sender.replaceTrack(a);
  }

  // Neue Quelle (anderer Bildschirm/Fenster) ohne Neuverbindung uebernehmen.
  async replaceStream(stream) {
    this.stream = stream;
    for (const peer of this.peers.values()) await this.attachTracks(peer);
  }

  async updateSettings(settings) {
    this.settings = settings;
    for (const peer of this.peers.values()) {
      await this.attachTracks(peer);
      await this.applyEncoding(peer);
    }
  }

  async applyEncoding(peer) {
    const s = this.settings;
    const presentation = s.preset === 'presentation';
    try {
      const vp = peer.video.sender.getParameters();
      if (!vp.encodings || !vp.encodings.length) vp.encodings = [{}];
      vp.encodings[0].maxBitrate = s.bitrate * 1000;
      vp.encodings[0].maxFramerate = s.fps;
      // Praesentation: lieber Bilder auslassen als unscharf werden.
      vp.degradationPreference = presentation ? 'maintain-resolution' : (s.fps >= 60 ? 'maintain-framerate' : 'balanced');
      await peer.video.sender.setParameters(vp);
    } catch (e) {
      console.warn('Video-Parameter', e);
    }
    try {
      const ap = peer.audio.sender.getParameters();
      if (!ap.encodings || !ap.encodings.length) ap.encodings = [{}];
      ap.encodings[0].maxBitrate = s.audioBitrate * 1000;
      await peer.audio.sender.setParameters(ap);
    } catch (e) {
      console.warn('Audio-Parameter', e);
    }
  }

  async collectStats() {
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState !== 'connected') continue;
      const report = await peer.pc.getStats();
      let video = null;
      let pair = null;
      const byId = new Map();
      report.forEach((r) => {
        byId.set(r.id, r);
        if (r.type === 'outbound-rtp' && r.kind === 'video') video = r;
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      });
      const now = performance.now();
      const st = {};
      if (video) {
        if (peer.prev) {
          st.kbps = Math.round(((video.bytesSent - peer.prev.bytes) * 8) / (now - peer.prev.t));
        }
        peer.prev = { bytes: video.bytesSent, t: now };
        st.fps = Math.round(video.framesPerSecond || 0);
        st.width = video.frameWidth;
        st.height = video.frameHeight;
        st.limit = video.qualityLimitationReason;
        const codec = video.codecId && byId.get(video.codecId);
        st.codec = codec ? codec.mimeType.replace('video/', '') : '';
      }
      if (pair) {
        st.rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
        const local = byId.get(pair.localCandidateId);
        const remote = byId.get(pair.remoteCandidateId);
        st.relay = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
      }
      peer.stats = st;
    }
    this.emitChange();
  }

  viewerList() {
    return [...this.peers].map(([id, p]) => ({ id, name: p.name, state: p.state, stats: p.stats }));
  }

  stop() {
    clearInterval(this.statsTimer);
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear();
  }
}

/* ---------- Zuschauer ---------- */

export class ViewerSession extends EventTarget {
  constructor({ signaling, iceServers, hostId }) {
    super();
    this.sig = signaling;
    this.hostId = hostId;
    this.pending = [];
    this.remoteSet = false;
    this.prev = null;
    this.stats = {};
    this.stream = new MediaStream();

    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.ontrack = (e) => {
      this.stream.addTrack(e.track);
      this.dispatchEvent(new CustomEvent('track', { detail: this.stream }));
    };
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sig.send({ type: 'signal', to: this.hostId, data: { candidate: e.candidate.toJSON() } });
    };
    this.pc.onconnectionstatechange = () => {
      this.dispatchEvent(new CustomEvent('state', { detail: this.pc.connectionState }));
    };
    this.sig.on('signal', (m) => m.from === this.hostId && this.onSignal(m.data));
    this.statsTimer = setInterval(() => this.collectStats(), 1000);
  }

  async onSignal(data) {
    if (data.sdp && data.sdp.type === 'offer') {
      await this.pc.setRemoteDescription(data.sdp);
      this.remoteSet = true;
      for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      const answer = await this.pc.createAnswer();
      answer.sdp = tuneOpus(answer.sdp);
      await this.pc.setLocalDescription(answer);
      this.sig.send({ type: 'signal', to: this.hostId, data: { sdp: this.pc.localDescription.toJSON() } });
    } else if (data.candidate) {
      if (this.remoteSet) await this.pc.addIceCandidate(data.candidate).catch(() => {});
      else this.pending.push(data.candidate);
    }
  }

  async collectStats() {
    if (this.pc.connectionState !== 'connected') return;
    const report = await this.pc.getStats();
    let video = null;
    let audio = null;
    let pair = null;
    const byId = new Map();
    report.forEach((r) => {
      byId.set(r.id, r);
      if (r.type === 'inbound-rtp' && r.kind === 'video') video = r;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') audio = r;
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
    });
    const now = performance.now();
    const st = {};
    if (video) {
      const bytes = video.bytesReceived + (audio ? audio.bytesReceived : 0);
      if (this.prev) st.kbps = Math.round(((bytes - this.prev.bytes) * 8) / (now - this.prev.t));
      this.prev = { bytes, t: now };
      st.fps = Math.round(video.framesPerSecond || 0);
      st.width = video.frameWidth;
      st.height = video.frameHeight;
      st.lost = video.packetsLost;
      const codec = video.codecId && byId.get(video.codecId);
      st.codec = codec ? codec.mimeType.replace('video/', '') : '';
    }
    if (pair) {
      st.rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
      const local = byId.get(pair.localCandidateId);
      st.relay = local && local.candidateType === 'relay';
    }
    this.stats = st;
    this.dispatchEvent(new CustomEvent('stats', { detail: st }));
  }

  stop() {
    clearInterval(this.statsTimer);
    this.pc.close();
  }
}
