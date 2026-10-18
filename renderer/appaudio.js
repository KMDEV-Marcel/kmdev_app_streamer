/*
 * Anwendungsaudio im Renderer: macht aus dem PCM-Ton des Hilfsprogramms
 * (siehe audio.js / native/kmdev-audio.cpp) eine normale Audiospur, die wie
 * eine Mikrofon- oder Loopback-Spur an WebRTC geht.
 */

export class AppAudio extends EventTarget {
  constructor() {
    super();
    this.status = { state: 'off' };
    this.apps = [];
    this.ctx = null;
    this.node = null;
    this.track = null;
    this.portReady = null;

    window.api.onAudioStatus((s) => {
      this.status = s;
      this.dispatchEvent(new CustomEvent('status', { detail: s }));
    });
    window.api.onAudioApps((apps) => {
      this.apps = apps;
      this.dispatchEvent(new CustomEvent('apps', { detail: apps }));
    });
    // Der MessagePort kommt vom Preload-Skript per window.postMessage.
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data !== 'kmdev:audio-port' || !e.ports[0]) return;
      this.attachPort(e.ports[0]);
    });
  }

  get available() {
    return ['starting', 'ready'].includes(this.status.state);
  }

  async ensureContext() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('audio-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'kmdev-pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
    const dest = this.ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    this.node.connect(dest);
    this.track = dest.stream.getAudioTracks()[0];
    this.track.contentHint = 'music';
  }

  async attachPort(port) {
    await this.ensureContext();
    this.node.port.postMessage({ port }, [port]);
  }

  // Startet das Hilfsprogramm; liefert true, wenn Anwendungsaudio geht.
  async start(config) {
    await this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    this.status = await window.api.audioStart();
    if (config) await this.configure(config);
    return this.available;
  }

  async configure({ mode, master, selected, volumes }) {
    await window.api.audioConfig({ mode, master, selected, volumes });
  }

  refreshList() {
    window.api.audioList();
  }

  stop() {
    window.api.audioStop();
  }
}
