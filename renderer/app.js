import {
  RESOLUTIONS, FPS_OPTIONS, AUDIO_BITRATES, PRESETS, PRESET_LABELS,
  BITRATE_MIN, BITRATE_MAX, BITRATE_STEP, matchPreset, videoConstraints
} from './presets.js';
import { Signaling, HostSession, ViewerSession } from './rtc.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let settings = null;
let captureStream = null;   // aktueller MediaStream der Quelle
let host = null;            // { sig, session, room }
let viewer = null;          // { sig, session }
let updateState = { state: 'idle' };

/* ---------- Hilfen ---------- */

function toast(text, ms = 2500) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.saveSettings(settings), 300);
}

function displayName() {
  return settings.displayName || 'Gast';
}

/* ---------- Segment-Buttons ---------- */

function buildSeg(el, options, getValue, onPick) {
  el.innerHTML = '';
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.dataset.v = value;
    b.textContent = label;
    el.appendChild(b);
  }
  wireSeg(el, getValue, onPick);
}

function wireSeg(el, getValue, onPick) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    onPick(b.dataset.v);
  });
  el._getValue = getValue;
}

function refreshSeg(el) {
  const v = String(el._getValue());
  for (const b of el.querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === v);
}

/* ---------- Einstellungs-Panel ---------- */

const segs = {};

function initPanel() {
  segs.preset = $('#segPreset');
  buildSeg(segs.preset, Object.keys(PRESETS).map((k) => [k, PRESET_LABELS[k]]),
    () => settings.preset ?? '', (v) => {
      settings.preset = v;
      Object.assign(settings, PRESETS[v]);
      onSettingsChanged({ constraints: true });
    });

  segs.resolution = $('#segResolution');
  buildSeg(segs.resolution, Object.keys(RESOLUTIONS).map((k) => [k, k === 'source' ? 'Quelle' : k]),
    () => settings.resolution, (v) => { settings.resolution = v; onSettingsChanged({ constraints: true, represet: true }); });

  segs.fps = $('#segFps');
  buildSeg(segs.fps, FPS_OPTIONS.map((f) => [f, String(f)]),
    () => settings.fps, (v) => { settings.fps = Number(v); onSettingsChanged({ constraints: true, represet: true }); });

  segs.audioBitrate = $('#segAudioBitrate');
  buildSeg(segs.audioBitrate, AUDIO_BITRATES.map((b) => [b, String(b)]),
    () => settings.audioBitrate, (v) => { settings.audioBitrate = Number(v); onSettingsChanged(); });

  segs.privacy = $('#segPrivacy');
  wireSeg(segs.privacy, () => settings.privacy, (v) => { settings.privacy = v; onSettingsChanged({ room: true }); });

  segs.codec = $('#segCodec');
  wireSeg(segs.codec, () => settings.codec, (v) => {
    settings.codec = v;
    onSettingsChanged();
    if (host) toast('Codec gilt für neu verbundene Zuschauer.');
  });

  segs.mode = $('#segMode');
  wireSeg(segs.mode, () => settings.connectionMode, (v) => { settings.connectionMode = v; onSettingsChanged(); });

  $('#chkAppAudio').addEventListener('change', async (e) => {
    settings.appAudio = e.target.checked;
    // Ohne Audiospur in der Aufnahme muss neu aufgenommen werden.
    if (settings.appAudio && captureStream && !captureStream.getAudioTracks().length) await recapture();
    onSettingsChanged();
  });

  const bitrate = $('#inpBitrate');
  const setBitrate = (v) => {
    settings.bitrate = Math.min(BITRATE_MAX, Math.max(BITRATE_MIN, Math.round(Number(v) || 0)));
    onSettingsChanged({ represet: true });
  };
  bitrate.addEventListener('change', () => setBitrate(bitrate.value));
  $('#bitrateMinus').addEventListener('click', () => setBitrate(settings.bitrate - BITRATE_STEP));
  $('#bitratePlus').addEventListener('click', () => setBitrate(settings.bitrate + BITRATE_STEP));

  const limit = $('#inpLimit');
  const setLimit = (v) => {
    settings.viewerLimit = Math.min(50, Math.max(0, Math.round(Number(v) || 0)));
    onSettingsChanged({ room: true });
  };
  limit.addEventListener('change', () => setLimit(limit.value));
  $('#limitMinus').addEventListener('click', () => setLimit(settings.viewerLimit - 1));
  $('#limitPlus').addEventListener('click', () => setLimit(settings.viewerLimit + 1));

  $('#inpPassword').addEventListener('change', (e) => {
    // Passwort bewusst nicht speichern – gilt nur fuer diese Sitzung.
    if (host) host.sig.send({ type: 'host-update', password: e.target.value });
  });
  $('#inpTitle').addEventListener('change', (e) => {
    settings.title = e.target.value;
    onSettingsChanged({ room: true });
  });

  const toggle = $('#toggleAdvanced');
  toggle.addEventListener('click', () => {
    const adv = $('#advanced');
    adv.hidden = !adv.hidden;
    toggle.classList.toggle('collapsed', adv.hidden);
  });
}

function renderPanel() {
  for (const el of Object.values(segs)) refreshSeg(el);
  $('#chkAppAudio').checked = !!settings.appAudio;
  $('#inpBitrate').value = settings.bitrate;
  $('#inpLimit').value = settings.viewerLimit;
  $('#inpTitle').value = settings.title || '';
  renderUploadEstimate();
}

async function onSettingsChanged({ constraints = false, represet = false, room = false } = {}) {
  if (represet) settings.preset = matchPreset(settings);
  renderPanel();
  persist();

  if (constraints && captureStream) {
    const track = captureStream.getVideoTracks()[0];
    if (track) {
      track.contentHint = settings.preset === 'presentation' ? 'detail' : 'motion';
      try {
        await track.applyConstraints(videoConstraints(settings));
      } catch (e) {
        console.warn('applyConstraints', e);
      }
    }
  }
  if (host) {
    await host.session.updateSettings(settings);
    if (room) {
      host.sig.send({
        type: 'host-update',
        title: settings.title,
        privacy: settings.privacy,
        viewerLimit: settings.viewerLimit
      });
    }
  }
}

function renderUploadEstimate() {
  const el = $('#uploadEst');
  const n = host ? host.session.peers.size : 0;
  const perViewer = settings.bitrate + (settings.appAudio ? settings.audioBitrate : 0);
  const total = (perViewer * Math.max(n, 1)) / 1000;
  el.textContent = n
    ? `Upload ca. ${total.toFixed(1)} Mbit/s (${n} × ${(perViewer / 1000).toFixed(1)} Mbit/s)`
    : `Pro Zuschauer ca. ${(perViewer / 1000).toFixed(1)} Mbit/s Upload`;
  el.classList.toggle('warn', n > 0 && total > 40);
}

/* ---------- Quellen-Auswahl ---------- */

let sourceType = 'screen';
let sources = [];

async function openSourcePicker() {
  $('#sourceModal').hidden = false;
  $('#sourceGrid').innerHTML = '<p class="muted">Lade Quellen…</p>';
  sources = await window.api.getSources();
  renderSources();
}

function renderSources() {
  for (const b of $$('#sourceTabs button')) b.classList.toggle('active', b.dataset.type === sourceType);
  const list = sources.filter((s) => s.type === sourceType);
  const grid = $('#sourceGrid');
  if (!list.length) {
    grid.innerHTML = '<p class="muted">Keine Quellen gefunden.</p>';
    return;
  }
  grid.innerHTML = list.map((s) => `
    <button class="source" data-id="${esc(s.id)}">
      ${s.thumbnail ? `<img class="thumb" src="${s.thumbnail}" alt="">` : '<div class="thumb"></div>'}
      <div class="name">${s.icon ? `<img src="${s.icon}" alt="">` : ''}<span>${esc(s.name)}</span></div>
    </button>`).join('');
}

async function pickSource(id) {
  $('#sourceModal').hidden = true;
  await window.api.selectSource(id);
  await recapture();
}

async function recapture() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints(settings),
      audio: !!settings.appAudio
    });
  } catch (e) {
    toast('Aufnahme fehlgeschlagen: ' + e.message, 4000);
    return;
  }
  const track = stream.getVideoTracks()[0];
  track.contentHint = settings.preset === 'presentation' ? 'detail' : 'motion';
  // Fenster geschlossen / Bildschirm getrennt -> Quelle ist weg.
  track.addEventListener('ended', () => {
    if (captureStream === stream) {
      toast('Die geteilte Quelle wurde beendet.', 4000);
      if (host) stopHosting();
      setCaptureStream(null);
    }
  });

  const old = captureStream;
  setCaptureStream(stream);
  if (host) await host.session.replaceStream(stream);
  if (old) old.getTracks().forEach((t) => t.stop());
}

function setCaptureStream(stream) {
  captureStream = stream;
  $('#preview').srcObject = stream;
  $('#previewEmpty').hidden = !!stream;
  $('#btnChangeSource').disabled = !stream;
  $('#btnStart').disabled = !stream || !!host;
}

/* ---------- Senden ---------- */

async function startHosting() {
  if (!captureStream || host || !requireServer()) return;
  $('#btnStart').disabled = true;
  $('#sendStatus').textContent = 'Verbinde mit Server…';
  const sig = new Signaling(settings.serverUrl);
  try {
    await sig.connect();
    const res = await sig.request({
      type: 'host',
      name: displayName(),
      title: settings.title,
      privacy: settings.privacy,
      password: $('#inpPassword').value,
      viewerLimit: settings.viewerLimit
    }, 'hosted');

    const session = new HostSession({ signaling: sig, iceServers: res.iceServers, stream: captureStream, settings });
    host = { sig, session, room: res.room };
    session.addEventListener('change', renderViewers);
    sig.on('disconnected', () => {
      if (!host || host.sig !== sig) return;
      // Bestehende P2P-Verbindungen laufen weiter, nur neue Zuschauer gehen nicht.
      $('#sendStatus').textContent = '⚠ Server-Verbindung verloren – neue Zuschauer können nicht beitreten.';
    });

    $('#roomCode').textContent = res.room;
    $('#roomBox').hidden = false;
    $('#liveBadge').hidden = false;
    $('#btnStart').hidden = true;
    $('#btnStop').hidden = false;
    $('#sendStatus').textContent = '';
    window.api.setStreaming(true);
    renderViewers();
    renderUpdateUi();
  } catch (e) {
    sig.close();
    $('#sendStatus').textContent = '';
    $('#btnStart').disabled = false;
    toast('Start fehlgeschlagen: ' + e.message, 5000);
  }
}

function stopHosting() {
  if (!host) return;
  host.session.stop();
  host.sig.close();
  host = null;
  $('#roomBox').hidden = true;
  $('#liveBadge').hidden = true;
  $('#btnStart').hidden = false;
  $('#btnStop').hidden = true;
  $('#btnStart').disabled = !captureStream;
  $('#sendStatus').textContent = '';
  window.api.setStreaming(false);
  renderViewers();
  renderUpdateUi();
}

function renderViewers() {
  const list = host ? host.session.viewerList() : [];
  $('#viewerCount').textContent = list.length;
  $('#noViewers').hidden = list.length > 0;
  $('#viewerTable').hidden = list.length === 0;
  $('#viewerTable tbody').innerHTML = list.map((v) => {
    const s = v.stats || {};
    const stateCls = v.state === 'verbunden' ? 'ok' : (v.state === 'fehlgeschlagen' ? 'bad' : '');
    const limit = s.limit && s.limit !== 'none' ? ` <span class="muted" title="Qualität begrenzt durch ${esc(s.limit)}">(${s.limit === 'bandwidth' ? 'Bandbreite' : s.limit === 'cpu' ? 'CPU' : esc(s.limit)})</span>` : '';
    return `<tr>
      <td>${esc(v.name)}</td>
      <td class="${stateCls}">${esc(v.state)}</td>
      <td>${s.width ? `${s.width}×${s.height}` : '–'}${limit}</td>
      <td>${s.fps ?? '–'}</td>
      <td>${s.kbps != null ? `${s.kbps} kbps` : '–'}${s.codec ? ` <span class="muted">${esc(s.codec)}</span>` : ''}</td>
      <td>${s.rtt != null ? `${s.rtt} ms` : '–'}</td>
      <td>${s.relay ? 'TURN' : (s.rtt != null ? 'direkt' : '–')}</td>
      <td><button class="ghost" data-kick="${esc(v.id)}" title="Entfernen">✕</button></td>
    </tr>`;
  }).join('');
  renderUploadEstimate();
}

/* ---------- Zuschauen ---------- */

async function refreshRooms() {
  const box = $('#roomList');
  if (!settings.serverUrl) {
    box.innerHTML = '<p class="muted">Keine Server-Adresse eingetragen (⚙).</p>';
    return;
  }
  box.innerHTML = '<p class="muted">Lade…</p>';
  const sig = new Signaling(settings.serverUrl);
  try {
    await sig.connect();
    const res = await sig.request({ type: 'list' }, 'rooms');
    box.innerHTML = res.rooms.length
      ? res.rooms.map((r) => `
        <div class="room-item">
          <div style="flex:1;min-width:0">
            <div class="title">${esc(r.title || 'Ohne Titel')} ${r.hasPassword ? '🔒' : ''}</div>
            <div class="meta">${esc(r.hostName)} · ${r.viewers}/${r.viewerLimit} Zuschauer · seit ${new Date(r.since).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
          <button class="primary" data-join="${esc(r.code)}" data-pw="${r.hasPassword ? 1 : 0}">Ansehen</button>
        </div>`).join('')
      : '<p class="muted">Gerade keine öffentlichen Streams.</p>';
  } catch (e) {
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  } finally {
    sig.close();
  }
}

async function joinRoom(code, password) {
  if (viewer || !requireServer()) return;
  $('#joinError').textContent = '';
  const sig = new Signaling(settings.serverUrl);
  try {
    await sig.connect();
    const res = await sig.request({ type: 'join', room: code, password, name: displayName() }, 'joined');
    const session = new ViewerSession({ signaling: sig, iceServers: res.iceServers, hostId: res.hostId });
    viewer = { sig, session };

    $('#watchLobby').hidden = true;
    $('#player').hidden = false;
    $('#playerOverlay').hidden = false;
    $('#playerOverlay').textContent = 'Verbinde…';
    $('#playerTitle').textContent = `${res.title || 'Stream'} – ${res.hostName}`;
    const video = $('#remoteVideo');
    video.volume = Number($('#volume').value);

    session.addEventListener('track', (e) => {
      video.srcObject = e.detail;
      video.play().catch(() => {});
    });
    session.addEventListener('state', (e) => {
      const st = e.detail;
      $('#playerOverlay').hidden = st === 'connected';
      if (st === 'failed') $('#playerOverlay').textContent = 'Verbindung fehlgeschlagen (evtl. Firewall/NAT – TURN nötig).';
      else if (st === 'disconnected') $('#playerOverlay').textContent = 'Verbindung unterbrochen…';
    });
    session.addEventListener('stats', (e) => {
      const s = e.detail;
      $('#playerStats').textContent = [
        s.width ? `${s.width}×${s.height}` : null,
        s.fps != null ? `${s.fps} fps` : null,
        s.kbps != null ? `${(s.kbps / 1000).toFixed(1)} Mbit/s` : null,
        s.codec || null,
        s.rtt != null ? `${s.rtt} ms` : null,
        s.relay ? 'TURN' : null
      ].filter(Boolean).join(' · ');
    });
    sig.on('host-left', () => { toast('Der Stream wurde beendet.', 4000); leaveRoom(); });
    sig.on('kicked', () => { toast('Du wurdest vom Host entfernt.', 4000); leaveRoom(); });
  } catch (e) {
    sig.close();
    $('#joinError').textContent = e.message;
  }
}

function leaveRoom() {
  if (!viewer) return;
  viewer.session.stop();
  viewer.sig.close();
  viewer = null;
  if (document.fullscreenElement) document.exitFullscreen();
  $('#remoteVideo').srcObject = null;
  $('#player').hidden = true;
  $('#watchLobby').hidden = false;
  $('#playerStats').textContent = '';
  refreshRooms();
}

/* ---------- Auto-Update ---------- */

function renderUpdateUi() {
  const s = updateState;
  const badge = $('#updateBadge');
  const banner = $('#updateBanner');
  const text = {
    dev: 'Entwicklungsversion – kein Auto-Update',
    checking: 'Suche nach Updates…',
    none: 'Du hast die aktuelle Version.',
    available: `Version ${s.version} gefunden – wird geladen…`,
    downloading: `Update wird geladen… ${s.percent ?? 0} %`,
    ready: `Version ${s.version} ist bereit.`,
    error: `Update-Fehler: ${s.message}`,
    idle: ''
  }[s.state] || '';
  $('#updateStateText').textContent = text;

  badge.hidden = !['available', 'downloading'].includes(s.state);
  badge.textContent = s.state === 'downloading' ? `Update ${s.percent ?? 0} %` : 'Update wird geladen';

  banner.hidden = s.state !== 'ready';
  if (s.state === 'ready') {
    const live = !!host;
    $('#updateBannerText').textContent = live
      ? `Version ${s.version} ist bereit – Installation nach dem Stream (oder beim Beenden).`
      : `Version ${s.version} ist bereit.`;
    $('#btnInstallUpdate').disabled = live;
  }
}

/* ---------- App-Einstellungen ---------- */

async function openAppSettings() {
  const info = await window.api.appInfo();
  $('#appVersion').textContent = info.version;
  $('#inpName').value = settings.displayName || '';
  $('#inpServer').value = settings.serverUrl || '';
  renderUpdateUi();
  $('#appSettingsModal').hidden = false;
}

// Erlaubt auch die Kurzform "stream.example.com" -> wss://stream.example.com/ws
function normalizeServerUrl(input) {
  let v = String(input || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) v = v.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(v)) v = 'wss://' + v;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

// Ohne eingetragenen Server geht nichts – dann direkt die Einstellungen oeffnen.
function requireServer() {
  if (settings.serverUrl) return true;
  toast('Bitte zuerst die Server-Adresse eintragen.', 3500);
  openAppSettings();
  return false;
}

async function saveAppSettings() {
  const server = normalizeServerUrl($('#inpServer').value);
  if (server === null) {
    toast('Ungültige Server-Adresse.');
    return;
  }
  if (!server) {
    toast('Ohne Server-Adresse kann nicht gestreamt werden.');
    return;
  }
  settings.displayName = $('#inpName').value.trim();
  settings.serverUrl = server;
  settings = await window.api.saveSettings(settings);
  $('#appSettingsModal').hidden = true;
  toast('Gespeichert.');
}

/* ---------- Verdrahtung ---------- */

function wire() {
  for (const b of $$('#mainTabs button')) {
    b.addEventListener('click', () => {
      for (const x of $$('#mainTabs button')) x.classList.toggle('active', x === b);
      for (const t of $$('.tab')) t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`);
      if (b.dataset.tab === 'watch' && !viewer) refreshRooms();
    });
  }

  $('#btnPickSource').addEventListener('click', openSourcePicker);
  $('#btnChangeSource').addEventListener('click', openSourcePicker);
  $('#sourceTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    sourceType = b.dataset.type;
    renderSources();
  });
  $('#sourceGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.source');
    if (b) pickSource(b.dataset.id);
  });

  $('#btnStart').addEventListener('click', startHosting);
  $('#btnStop').addEventListener('click', stopHosting);
  $('#btnCopyCode').addEventListener('click', () => {
    navigator.clipboard.writeText(host ? host.room : '');
    toast('Code kopiert.');
  });
  $('#viewerTable').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kick]');
    if (b && host) host.session.kick(b.dataset.kick);
  });

  $('#btnJoin').addEventListener('click', () => joinRoom($('#inpJoinCode').value.trim(), $('#inpJoinPassword').value));
  $('#inpJoinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });
  $('#inpJoinPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });
  $('#btnRefreshRooms').addEventListener('click', refreshRooms);
  $('#roomList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-join]');
    if (!b) return;
    if (b.dataset.pw === '1') {
      $('#inpJoinCode').value = b.dataset.join;
      $('#inpJoinPassword').focus();
      $('#joinError').textContent = 'Dieser Stream braucht ein Passwort.';
      return;
    }
    joinRoom(b.dataset.join, '');
  });
  $('#btnLeave').addEventListener('click', leaveRoom);
  $('#volume').addEventListener('input', (e) => { $('#remoteVideo').volume = Number(e.target.value); });
  $('#btnFullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('#player').requestFullscreen();
  });
  $('#remoteVideo').addEventListener('dblclick', () => $('#btnFullscreen').click());

  $('#btnSettings').addEventListener('click', openAppSettings);
  $('#btnSaveAppSettings').addEventListener('click', saveAppSettings);
  $('#btnCheckUpdate').addEventListener('click', async () => {
    updateState = await window.api.checkUpdate();
    renderUpdateUi();
  });
  $('#btnInstallUpdate').addEventListener('click', () => window.api.installUpdate());
  $('#updateBadge').addEventListener('click', openAppSettings);

  for (const m of $$('.modal')) {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const m of $$('.modal')) m.hidden = true;
  });

  window.api.onUpdate((s) => {
    updateState = s;
    renderUpdateUi();
  });
}

async function init() {
  settings = await window.api.getSettings();
  settings.codec = settings.codec || 'h264';
  if (settings.preset !== null && !PRESETS[settings.preset]) settings.preset = matchPreset(settings);
  initPanel();
  wire();
  renderPanel();
  renderViewers();
  updateState = await window.api.updateStatus();
  renderUpdateUi();
  const info = await window.api.appInfo();
  document.title = `KM-DEV Stream ${info.version}`;
  if (!settings.displayName || !settings.serverUrl) setTimeout(openAppSettings, 300);
}

init();
