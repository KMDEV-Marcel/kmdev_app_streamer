import {
  RESOLUTIONS, FPS_OPTIONS, AUDIO_BITRATES, PRESETS,
  BITRATE_MIN, BITRATE_MAX, BITRATE_STEP, matchPreset, videoConstraints
} from './presets.js';
import { Signaling, HostSession, SFU_ID } from './rtc.js';
import { parseInvite, setupInvite, watchUrl, joinLink } from './invite.js';
import { TileManager } from './tiles.js';
import { AppAudio } from './appaudio.js';
import { icon, hydrateIcons } from './icons.js';
import { Lobby, POLL_FAST, POLL_SLOW } from './lobby.js';
import { changesBetween } from './changelog.js';
import { playJoinChime, playEndChime, playLiveChime } from './sounds.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const CODE_LEN = 6;
const JOIN_HINT = 'Oder einfach einen Einladungslink einfügen, mit Strg + V.';
const PRIVATE_HINT = 'Stream gefunden. Er ist privat, deshalb brauchst du das Passwort.';

// Die vier Qualitaetsstufen der Oberflaeche. Weitere Aufloesungen gibt es unter „Erweitert“.
const QUALITY = [['720', 'Flüssig'], ['1080', 'Scharf'], ['source', 'Maximal'], ['presentation', 'Präsentation']];

let settings = null;
let captureStream = null;   // aktueller MediaStream der Quelle
let host = null;            // { sig, session, room, since }
let appFocused = document.hasFocus(); // hat ein Fenster der App den Fokus?
let tiles = null;           // TileManager (Zuschauen)
let updateState = { state: 'idle' };
let browsing = false;       // Zuschauen: Startseite trotz offener Streams zeigen
let rooms = [];             // zuletzt geladene Stream-Liste
let knownRooms = null;      // Codes der bekannten Streams (fuer Benachrichtigungen)
const lobby = new Lobby();
let joinCode = '';
let joinPwNeeded = false;
const appAudio = new AppAudio();

const preview = document.createElement('video');
preview.autoplay = true;
preview.muted = true;
preview.playsInline = true;

/* ---------- Hilfen ---------- */

// action: { label, onClick } – optionaler Knopf im Hinweis.
function toast(text, ms = 2500, action = null) {
  const t = $('#toast');
  t.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-btn';
    b.textContent = action.label;
    b.addEventListener('click', () => { t.hidden = true; action.onClick(); });
    t.append(b);
  }
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

// Feste Farbe pro Name (fuer Avatare).
function colorFor(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 60%, 66%)`;
}

function initial(name) {
  return esc(String(name || '?').slice(0, 1).toUpperCase());
}

function qualitySub(key) {
  const p = PRESETS[key];
  if (key === 'presentation') return `Text · ${p.fps} fps`;
  return `${p.resolution === 'source' ? 'Quelle' : `${p.resolution}p`} · ${p.fps}`;
}

// Umschalter mit .active an Tabs (Panel, Einstellungen).
function wireTabs(tabsEl, panes, attr = 'tab') {
  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-' + attr + ']');
    if (b) selectTab(tabsEl, panes, b.dataset[attr], attr);
  });
}

function selectTab(tabsEl, panes, name, attr = 'tab') {
  for (const b of tabsEl.querySelectorAll('button')) b.classList.toggle('active', b.dataset[attr] === name);
  for (const p of panes) p.classList.toggle('active', p.dataset.pane === name);
}

/* ---------- Navigation ---------- */

function currentPage() {
  return $('.page.active').id.replace('page-', '');
}

function showPage(page) {
  for (const b of $$('#nav .nav-item')) b.classList.toggle('active', b.dataset.page === page);
  for (const p of $$('.page')) p.classList.toggle('active', p.id === `page-${page}`);
  if (page === 'watch') renderWatch();
  if (page === 'send' && !host) loadSources();
}

function renderNav() {
  $('#navLive').hidden = !host;
  const n = tiles ? tiles.size : 0;
  $('#navTiles').hidden = n === 0;
  $('#navTiles').textContent = n;
  $('#btnCloseAll').disabled = n === 0;
  for (const el of $$('#roomList .room-card')) el.classList.toggle('open', !!tiles && tiles.has(el.dataset.code));
  renderWatch();
}

function renderUser(state, text) {
  const av = $('#avatar');
  av.textContent = displayName().slice(0, 1).toUpperCase();
  av.style.background = colorFor(displayName());
  av.title = `${displayName()} – Einstellungen`;
  if (state !== undefined) {
    const el = $('#userStatus');
    el.classList.toggle('ok', state === 'ok');
    el.classList.toggle('bad', state === 'bad');
    el.lastElementChild.textContent = text;
  }
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

// Liste mit Radiopunkt, Titel und Zusatz (Qualitaet).
function buildRadio(el, options, getValue, onPick) {
  el.innerHTML = options.map(([value, title, sub]) =>
    `<button data-v="${esc(value)}"><span class="radio"></span><span class="rt">${esc(title)}</span>${sub ? `<span class="rs">${esc(sub)}</span>` : ''}</button>`
  ).join('');
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
  const pickPreset = (v) => {
    settings.preset = v;
    Object.assign(settings, PRESETS[v]);
    onSettingsChanged({ constraints: true });
  };
  segs.preset = $('#segPreset');
  buildRadio(segs.preset, QUALITY.map(([k, t]) => [k, t, qualitySub(k)]), () => settings.preset ?? '', pickPreset);
  segs.presetS = $('#segPresetS');
  buildSeg(segs.presetS, QUALITY, () => settings.preset ?? '', pickPreset);

  segs.resolution = $('#segResolution');
  buildSeg(segs.resolution, Object.keys(RESOLUTIONS).map((k) => [k, k === 'source' ? 'Quelle' : k]),
    () => settings.resolution, (v) => { settings.resolution = v; onSettingsChanged({ constraints: true, represet: true }); });

  segs.fps = $('#segFps');
  buildSeg(segs.fps, FPS_OPTIONS.map((f) => [f, String(f)]),
    () => settings.fps, (v) => { settings.fps = Number(v); onSettingsChanged({ constraints: true, represet: true }); });

  const pickAudioBitrate = (v) => { settings.audioBitrate = Number(v); onSettingsChanged(); };
  segs.audioBitrate = $('#segAudioBitrate');
  buildSeg(segs.audioBitrate, AUDIO_BITRATES.map((b) => [b, String(b)]), () => settings.audioBitrate, pickAudioBitrate);
  segs.audioBitrateS = $('#segAudioBitrateS');
  buildSeg(segs.audioBitrateS, AUDIO_BITRATES.map((b) => [b, String(b)]), () => settings.audioBitrate, pickAudioBitrate);

  const pickPrivacy = (v) => { settings.privacy = v; onSettingsChanged({ room: true }); };
  segs.privacy = $('#segPrivacy');
  wireSeg(segs.privacy, () => settings.privacy, pickPrivacy);
  segs.privacyS = $('#segPrivacyS');
  wireSeg(segs.privacyS, () => settings.privacy, pickPrivacy);

  const pickCodec = (v) => {
    settings.codec = v;
    onSettingsChanged();
    if (host) toast('Codec gilt für neu verbundene Zuschauer.');
  };
  segs.codec = $('#segCodec');
  wireSeg(segs.codec, () => settings.codec, pickCodec);
  segs.codecS = $('#segCodecS');
  wireSeg(segs.codecS, () => settings.codec, pickCodec);

  const pickMode = (v) => {
    settings.connectionMode = v;
    onSettingsChanged();
    if (host && host.session.mode !== v) toast('Der Verbindungsmodus gilt ab dem nächsten Streamstart.', 3500);
  };
  segs.mode = $('#segMode');
  wireSeg(segs.mode, () => settings.connectionMode, pickMode);
  segs.modeS = $('#segModeS');
  wireSeg(segs.modeS, () => settings.connectionMode, pickMode);

  segs.audioMode = $('#segAudioMode');
  wireSeg(segs.audioMode, () => settings.audioMode, (v) => {
    settings.audioMode = v;
    onAudioConfigChanged();
  });

  for (const id of ['#chkAppAudio', '#chkAppAudioS']) {
    $(id).addEventListener('change', async (e) => {
      settings.appAudio = e.target.checked;
      await applyAppAudio();
      onSettingsChanged();
    });
  }

  $('#chkPauseOnBlur').addEventListener('change', (e) => {
    settings.pauseOnBlur = e.target.checked;
    persist();
    applyPause();
  });
  $('#chkJoinSound').addEventListener('change', (e) => {
    settings.joinSound = e.target.checked;
    persist();
    if (e.target.checked) playJoinChime();
  });
  $('#chkEndSound').addEventListener('change', (e) => {
    settings.endSound = e.target.checked;
    persist();
    if (e.target.checked) playEndChime();
  });
  $('#chkNotifyLive').addEventListener('change', (e) => {
    settings.notifyLive = e.target.checked;
    persist();
  });
  $('#chkAutostart').addEventListener('change', async (e) => {
    const st = await window.api.setAutostart(e.target.checked);
    e.target.checked = st.enabled;
  });

  $('#audioMaster').addEventListener('input', (e) => {
    settings.audioMaster = Number(e.target.value);
    onAudioConfigChanged();
  });

  // „hörbar“/„stumm“ antippen nimmt das Programm in die Auswahl auf oder heraus.
  $('#appList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sel]');
    if (!b || b.disabled) return;
    const exe = b.dataset.sel;
    const sel = new Set(settings.audioSelected);
    if (sel.has(exe)) sel.delete(exe);
    else sel.add(exe);
    settings.audioSelected = [...sel];
    onAudioConfigChanged();
  });
  $('#appList').addEventListener('input', (e) => {
    const exe = e.target.dataset.vol;
    if (!exe) return;
    settings.audioVolumes = { ...settings.audioVolumes, [exe]: Number(e.target.value) };
    e.target.title = `Lautstärke ${Math.round(Number(e.target.value) * 100)} %`;
    onAudioConfigChanged({ list: false });
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

  wireTabs($('#panelTabs'), $$('#settingsPanel .pane'));
}

function renderPanel() {
  for (const el of Object.values(segs)) refreshSeg(el);
  $('#chkAppAudio').checked = !!settings.appAudio;
  $('#chkAppAudioS').checked = !!settings.appAudio;
  $('#chkPauseOnBlur').checked = settings.pauseOnBlur !== false;
  $('#chkJoinSound').checked = settings.joinSound !== false;
  $('#chkEndSound').checked = settings.endSound !== false;
  $('#chkNotifyLive').checked = settings.notifyLive !== false;
  $('#inpBitrate').value = settings.bitrate;
  $('#inpLimit').value = settings.viewerLimit;
  if (document.activeElement !== $('#inpTitle')) $('#inpTitle').value = settings.title || '';
  $('#audioMaster').value = settings.audioMaster;
  $('#audioMasterVal').textContent = `${Math.round(settings.audioMaster * 100)} %`;
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
      pushThumb();
    }
  }
}

function renderUploadEstimate() {
  const el = $('#uploadEst');
  const info = $('#liveInfo');
  const perViewer = settings.bitrate + (settings.appAudio ? settings.audioBitrate : 0);
  const mbit = (v) => (v / 1000).toFixed(1).replace('.', ',');
  const serverMode = host ? host.session.mode === 'server' : settings.connectionMode === 'server';
  if (serverMode) {
    // Im Server-Modus wird nur einmal hochgeladen, egal wie viele zuschauen.
    el.textContent = `Upload ca. ${mbit(perViewer)} Mbit/s · Server verteilt`;
    info.textContent = `↑ ${mbit(perViewer)} Mbit/s · Server`;
    el.classList.remove('warn');
    info.classList.remove('warn');
    return;
  }
  const n = host ? host.session.uploadStreams : 0;
  const total = perViewer * Math.max(n, 1);
  const warn = n > 0 && total / 1000 > 40;
  el.textContent = n
    ? `Upload ca. ${mbit(total)} Mbit/s (${n} × ${mbit(perViewer)})`
    : `ca. ${mbit(perViewer)} Mbit/s pro Zuschauer`;
  info.textContent = n ? `↑ ${mbit(total)} Mbit/s · P2P` : 'P2P';
  el.classList.toggle('warn', warn);
  info.classList.toggle('warn', warn);
}

/* ---------- Anwendungsaudio ---------- */

function audioConfig() {
  return {
    mode: settings.audioMode,
    master: settings.audioMaster,
    selected: settings.audioSelected,
    volumes: settings.audioVolumes
  };
}

function onAudioConfigChanged({ list = true } = {}) {
  renderPanel();
  if (list) renderAppList();
  persist();
  if (appAudio.available) appAudio.configure(audioConfig());
}

// Startet/stoppt das Hilfsprogramm und haengt die Tonspur an die Aufnahme.
async function applyAppAudio() {
  if (settings.appAudio) {
    await appAudio.start(audioConfig());
    if (captureStream) {
      if (appAudio.available) {
        // Systemton-Spur (Rueckfall) durch die Anwendungsaudio-Spur ersetzen.
        for (const t of captureStream.getAudioTracks()) {
          if (t !== appAudio.track) { captureStream.removeTrack(t); t.stop(); }
        }
        if (!captureStream.getAudioTracks().length) captureStream.addTrack(appAudio.track);
      } else if (!captureStream.getAudioTracks().length) {
        await recapture(); // Rueckfall: Systemton ueber getDisplayMedia
      }
    }
  } else {
    appAudio.stop();
  }
  renderAppList();
}

function renderAppList() {
  const box = $('#appAudioBox');
  const st = appAudio.status.state;
  box.hidden = !settings.appAudio;
  const note = $('#audioNote');
  const unsupported = st === 'unsupported' || st === 'missing' || st === 'error';
  segs.audioMode.hidden = unsupported;
  $('#appList').hidden = unsupported;
  $('.vol-row.master').hidden = unsupported;
  if (unsupported) {
    note.textContent = `${appAudio.status.message || 'Anwendungsaudio nicht verfügbar.'} Es wird der gesamte Systemton übertragen.`;
    return;
  }
  const mode = settings.audioMode;
  note.textContent = mode === 'all'
    ? 'Alle Programme sind zu hören. Lautstärke pro Programm einstellbar.'
    : 'Tippe auf „hörbar“ bzw. „stumm“, um ein Programm umzuschalten.';

  // Laufende Programme mit Ton + (bei „Nur ausgewaehlte“) ausgewaehlte, die
  // gerade nicht laufen. Stumm geschaltete, die nicht laufen, sind egal.
  const apps = [...appAudio.apps];
  if (mode === 'include') {
    for (const exe of settings.audioSelected) {
      if (!apps.some((a) => a.exe === exe)) apps.push({ exe, name: exe.replace(/\.exe$/i, ''), icon: null, gone: true });
    }
  }
  apps.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const selected = new Set(settings.audioSelected);

  // Das Hilfsprogramm meldet jede Sekunde neue Pegel. Hat sich sonst nichts
  // geaendert, nur die Pegelbalken nachziehen - ein Neuaufbau wuerde sonst
  // gerade gezogene Regler zuruecksetzen.
  const signature = JSON.stringify([mode, settings.audioSelected, apps.map((a) => [a.exe, !!a.gone, !!a.icon])]);
  const list = $('#appList');
  if (list.dataset.signature === signature) {
    for (const a of apps) {
      const bar = list.querySelector(`.app-meter[data-exe="${CSS.escape(a.exe)}"] i`);
      if (bar) bar.style.width = `${Math.round(Math.min(1, a.peak || 0) * 100)}%`;
    }
    return;
  }
  list.dataset.signature = signature;
  list.innerHTML = apps.length
    ? apps.map((a) => {
      const vol = settings.audioVolumes[a.exe] ?? 1;
      const isSel = selected.has(a.exe);
      const audible = mode === 'all' || (mode === 'include' ? isSel : !isSel);
      return `<div class="app-item ${audible ? '' : 'off'}" title="${esc(a.exe)}">
        ${a.icon ? `<img src="${a.icon}" alt="">` : '<span class="app-noicon"></span>'}
        <span class="app-name"><span>${esc(a.name)}${a.gone ? ' <span class="muted">(nicht aktiv)</span>' : ''}</span>
          <span class="app-meter" data-exe="${esc(a.exe)}"><i style="width:${Math.round(Math.min(1, a.peak || 0) * 100)}%"></i></span></span>
        <input type="range" min="0" max="1.5" step="0.01" value="${vol}" data-vol="${esc(a.exe)}" title="Lautstärke ${Math.round(vol * 100)} %">
        <button class="app-pill" data-sel="${esc(a.exe)}" ${mode === 'all' ? 'disabled' : ''}>${icon(audible ? 'volume_up' : 'volume_off')}${audible ? 'hörbar' : 'stumm'}</button>
      </div>`;
    }).join('')
    : '<p class="muted small">Gerade spielt kein Programm Ton ab.</p>';
}

/* ---------- Quellen ---------- */

let sources = [];
let selectedSourceId = null;
let modalSourceType = 'screen';

let setupSourceType = 'screen';

function sourceCard(s) {
  return `<button class="source ${s.id === selectedSourceId ? 'sel' : ''}" data-id="${esc(s.id)}" title="${esc(s.name)}">
    <div class="thumb">${s.thumbnail ? `<img src="${s.thumbnail}" alt="">` : ''}
      <span class="kind">${s.type === 'screen' ? 'Bildschirm' : 'Fenster'}</span>
      <span class="radio"></span></div>
    <span class="name">${s.icon ? `<img src="${s.icon}" alt="">` : ''}<span>${esc(s.name)}</span></span>
  </button>`;
}

async function loadSources() {
  const grid = $('#sourceGrid');
  if (!sources.length) grid.innerHTML = '<p class="source-empty">Lade Quellen…</p>';
  sources = await window.api.getSources();
  renderSourceGrid();
}

function renderSourceGrid() {
  for (const b of $$('#setupSourceTabs button')) b.classList.toggle('active', b.dataset.type === setupSourceType);
  const list = sources.filter((s) => s.type === setupSourceType);
  $('#sourceGrid').innerHTML = list.length
    ? list.map(sourceCard).join('')
    : `<p class="source-empty">${setupSourceType === 'screen' ? 'Keine Bildschirme gefunden.' : 'Keine Fenster gefunden.'}</p>`;
  placePreview();
}

// Sprach-Chats sind standardmaessig stumm, egal welche Quelle.
const VOICE_APPS = ['discord.exe', 'discordptb.exe', 'discordcanary.exe', 'ts3client_win64.exe', 'ts3client_win32.exe', 'teamspeak.exe'];

// Vorauswahl beim Wechsel der Quelle: Fenster -> nur der Ton dieses Programms,
// Bildschirm -> alle Programme ausser Sprach-Chats. Danach frei aenderbar.
async function applyAudioDefaults(source) {
  if (!source) return;
  let exe = null;
  if (source.type === 'window') exe = await window.api.windowExe(source.id).catch(() => null);
  if (exe && !VOICE_APPS.includes(exe)) {
    settings.audioMode = 'include';
    settings.audioSelected = [exe];
  } else {
    settings.audioMode = 'exclude';
    settings.audioSelected = [...VOICE_APPS];
  }
  onAudioConfigChanged();
}

async function openSourceModal() {
  $('#sourceModal').hidden = false;
  $('#sourceModalGrid').innerHTML = '<p class="source-empty">Lade Quellen…</p>';
  sources = await window.api.getSources();
  renderSourceModal();
}

function renderSourceModal() {
  for (const b of $$('#sourceTabs button')) b.classList.toggle('active', b.dataset.type === modalSourceType);
  const list = sources.filter((s) => s.type === modalSourceType);
  $('#sourceModalGrid').innerHTML = list.length ? list.map(sourceCard).join('') : '<p class="source-empty">Keine Quellen gefunden.</p>';
}

async function pickSource(id) {
  $('#sourceModal').hidden = true;
  selectedSourceId = id;
  const source = sources.find((s) => s.id === id);
  if (source) setupSourceType = source.type;
  renderSourceGrid();
  await window.api.selectSource(id);
  applyAudioDefaults(source);
  await recapture();
}

// Die eine Vorschau wandert zwischen ausgewaehlter Quellen-Karte und Live-Buehne.
function placePreview() {
  const target = host
    ? $('#liveStage')
    : $(`#sourceGrid .source.sel .thumb`);
  if (!captureStream || !target) {
    preview.remove();
    return;
  }
  if (preview.parentElement !== target) {
    target.prepend(preview);
    preview.play().catch(() => {});
  }
}

async function recapture() {
  // Mit Anwendungsaudio kommt der Ton vom Hilfsprogramm, sonst als Rueckfall
  // der gesamte Systemton ueber getDisplayMedia.
  const helper = settings.appAudio && appAudio.available;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints(settings),
      audio: !!settings.appAudio && !helper
    });
  } catch (e) {
    toast('Aufnahme fehlgeschlagen: ' + e.message, 4000);
    return;
  }
  if (helper) stream.addTrack(appAudio.track);
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
  // Die Anwendungsaudio-Spur wird weiterverwendet, nicht stoppen.
  if (old) old.getTracks().forEach((t) => { if (t !== appAudio.track) t.stop(); });
}

function setCaptureStream(stream) {
  captureStream = stream;
  preview.srcObject = stream;
  applyPause();
  $('#btnStart').disabled = !stream || !!host;
  if (!stream) {
    selectedSourceId = null;
    renderSourceGrid();
  }
  placePreview();
}

/* ---------- Senden ---------- */

// Waehrend des Sendens pausiert der Stream (Einstellung pauseOnBlur), sobald ein Fenster ausserhalb der
// App benutzt wird: Die Spuren werden abgeschaltet (Zuschauer sehen Schwarz,
// hoeren Stille), bis die App wieder angeklickt wird. Ohne Neuverhandlung.
function applyPause() {
  const paused = !!host && !appFocused && settings.pauseOnBlur !== false;
  if (captureStream) captureStream.getTracks().forEach((t) => { t.enabled = !paused; });
  $('#livePaused').hidden = !paused;
  if (host && host.paused !== paused) {
    host.paused = paused;
    if (!paused) setTimeout(pushThumb, 1000); // Vorschaubild auffrischen
  }
}

let liveTimer = null;

function renderLiveTimer() {
  const s = host ? Math.floor((Date.now() - host.since) / 1000) : 0;
  const pad = (n) => String(n).padStart(2, '0');
  $('#liveTimer').textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function renderSendView() {
  const live = !!host;
  $('#sendSetup').hidden = live;
  $('#sendLive').hidden = !live;
  $('#panelFoot').hidden = live;
  if (!live) {
    $('#viewerPop').hidden = true;
    $('#btnViewers').classList.remove('open');
  }
  clearInterval(liveTimer);
  if (live) liveTimer = setInterval(renderLiveTimer, 1000);
  renderLiveTimer();
  placePreview();
}

async function startHosting() {
  if (!captureStream || host || !requireServer()) return;
  const btn = $('#btnStart');
  btn.disabled = true;
  btn.lastChild.textContent = 'Verbinde…';
  const sig = new Signaling(settings.serverUrl);
  try {
    await sig.connect();
    const res = await sig.request({
      type: 'host',
      key: settings.accessKey,
      mode: settings.connectionMode,
      name: displayName(),
      title: settings.title,
      privacy: settings.privacy,
      password: $('#inpPassword').value,
      viewerLimit: settings.viewerLimit
    }, 'hosted');

    const session = new HostSession({ signaling: sig, iceServers: res.iceServers, stream: captureStream, settings, mode: res.mode });
    host = { sig, session, room: res.room, since: Date.now() };
    sig.on('sfu-lost', () => {
      if (!host || host.sig !== sig) return;
      toast('Verbindung zum Medien-Server verloren. Bitte den Stream neu starten.', 6000);
      stopHosting();
    });
    session.addEventListener('change', renderViewers);
    sig.on('disconnected', () => {
      if (!host || host.sig !== sig) return;
      // Bestehende P2P-Verbindungen laufen weiter, nur neue Zuschauer gehen nicht.
      const msg = 'Server-Verbindung verloren – neue Zuschauer können nicht beitreten.';
      $('#sendStatus').textContent = '⚠ ' + msg;
      toast(msg, 5000);
    });

    $('#roomCode').textContent = res.room;
    $('#sendStatus').textContent = '';
    host.thumbTimer = setInterval(pushThumb, THUMB_MS);
    setTimeout(pushThumb, 1500); // erstes Bild, sobald die Aufnahme laeuft
    window.api.setStreaming(true);
    applyPause();
    renderSendView();
    renderViewers();
    renderUpdateUi();
    renderNav();
    setTimeout(refreshRooms, 500);
  } catch (e) {
    sig.close();
    btn.disabled = false;
    toast('Start fehlgeschlagen: ' + e.message, 5000);
    if (e.code === 'bad_key') openAppSettings('connection');
  } finally {
    btn.lastChild.textContent = 'Live gehen';
  }
}

function stopHosting() {
  if (!host) return;
  clearInterval(host.thumbTimer);
  host.session.stop();
  host.sig.close();
  host = null;
  $('#btnStart').disabled = !captureStream;
  $('#sendStatus').textContent = '';
  window.api.setStreaming(false);
  applyPause();
  renderSendView();
  renderViewers();
  renderUpdateUi();
  renderNav();
  setTimeout(refreshRooms, 500);
}

/* ---------- Vorschaubild fuer die Stream-Liste ---------- */

const THUMB_MS = 30000;
const thumbCanvas = document.createElement('canvas');
thumbCanvas.width = 384;
thumbCanvas.height = 216;

// Nur oeffentliche Streams ohne Passwort zeigen ein Vorschaubild – bei allen
// anderen verlaesst kein Bild den Rechner.
async function pushThumb() {
  if (!host || !captureStream || host.paused) return;
  if (settings.privacy !== 'public' || $('#inpPassword').value) {
    if (host.thumbSent) host.sig.send({ type: 'host-update', thumb: null });
    host.thumbSent = false;
    return;
  }
  const track = captureStream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') return;
  let frame = null;
  try {
    frame = await new ImageCapture(track).grabFrame();
  } catch {
    frame = preview.videoWidth ? preview : null; // Rueckfall: laufende Vorschau
  }
  if (!frame || !host) return;
  const fw = frame.width || frame.videoWidth;
  const fh = frame.height || frame.videoHeight;
  const ctx = thumbCanvas.getContext('2d');
  const { width: W, height: H } = thumbCanvas;
  ctx.fillStyle = '#090c0b';
  ctx.fillRect(0, 0, W, H);
  const k = Math.min(W / fw, H / fh);
  ctx.drawImage(frame, (W - fw * k) / 2, (H - fh * k) / 2, fw * k, fh * k);
  if (frame.close) frame.close();
  let data = thumbCanvas.toDataURL('image/jpeg', 0.72);
  if (data.length > 46000) data = thumbCanvas.toDataURL('image/jpeg', 0.5);
  host.sig.send({ type: 'host-update', thumb: data });
  host.thumbSent = true;
}

let knownViewers = new Set();

function renderViewers() {
  const list = host ? host.session.viewerList() : [];
  const ids = list.filter((v) => !v.server).map((v) => v.id);
  if (host && settings.joinSound !== false && ids.some((id) => !knownViewers.has(id))) playJoinChime();
  knownViewers = new Set(ids);
  const n = host ? host.session.viewerCount : 0;
  $('#viewerCount').textContent = `${n} ${n === 1 ? 'schaut' : 'schauen'} zu`;
  $('#viewerFaces').innerHTML = list.filter((v) => !v.server).slice(0, 3)
    .map((v) => `<span class="face" style="background:${colorFor(v.name)}">${initial(v.name)}</span>`).join('');
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
      <td>${v.server ? '' : `<button class="icon-btn" data-kick="${esc(v.id)}" title="Entfernen">${icon('close')}</button>`}</td>
    </tr>`;
  }).join('');
  renderUploadEstimate();
}

/* ---------- Zuschauen: Startseite ---------- */

function renderWatch() {
  const n = tiles ? tiles.size : 0;
  if (n === 0) browsing = false;
  const stage = n > 0 && !browsing;
  $('#watchHome').hidden = stage;
  $('#watchStage').hidden = !stage;
  $('#btnBackToTiles').hidden = n === 0;
  if (stage && currentPage() === 'watch') tiles.arrange();
  updateLobbySpeed();
}

// Live-Liste im Blick -> alle 5 s auffrischen, sonst gemaechlich.
function updateLobbySpeed() {
  const visible = !document.hidden && currentPage() === 'watch' && !$('#watchHome').hidden;
  lobby.setPollInterval(visible ? POLL_FAST : POLL_SLOW);
}

function setHint(text, error = false) {
  const el = $('#joinError');
  el.textContent = text || JOIN_HINT;
  el.classList.toggle('error', !!error);
}

function renderCodeBoxes() {
  const boxes = [];
  for (let i = 0; i < CODE_LEN; i++) {
    const ch = joinCode[i] || '';
    const cur = i === joinCode.length;
    boxes.push(`<div class="code-box-c ${ch ? 'filled' : ''} ${cur ? 'cur' : ''}">${ch ? esc(ch) : (cur ? '<span class="caret"></span>' : '')}</div>`);
  }
  $('#codeBoxes').innerHTML = boxes.join('');
}

function setJoinCode(code) {
  joinCode = code;
  $('#inpJoinCode').value = code;
  if (code.length < CODE_LEN) joinPwNeeded = false;
  renderCodeBoxes();
  renderJoinCard();
}

function renderJoinCard() {
  const card = $('#joinCard');
  const ready = joinCode.length === CODE_LEN;
  card.hidden = !ready;
  if (!ready) {
    if (!$('#joinError').classList.contains('error')) setHint();
    return;
  }
  const r = rooms.find((x) => x.code === joinCode);
  $('#joinTitle').textContent = r ? (r.title || 'Ohne Titel') : `Stream ${joinCode}`;
  $('#joinMeta').textContent = r
    ? `${r.hostName} · ${r.viewers} ${r.viewers === 1 ? 'schaut' : 'schauen'} zu`
    : 'Nicht in der öffentlichen Liste';
  const pw = joinPwNeeded || !!(r && r.hasPassword);
  $('#joinPwBox').hidden = !pw;
  if (pw) setHint(PRIVATE_HINT);
}

function onCodeInput() {
  const raw = $('#inpJoinCode').value;
  if (/[:/]/.test(raw)) {
    if (parseInvite(raw)) {
      setJoinCode('');
      handleInvite(raw);
    } else {
      setJoinCode('');
      setHint('Das ist kein gültiger Einladungslink.', true);
    }
    return;
  }
  setHint();
  setJoinCode(raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN));
}

function joinNow() {
  if (joinCode.length !== CODE_LEN) return;
  openStream(joinCode, $('#inpJoinPassword').value);
}

function refreshRooms() {
  if (!settings.serverUrl) {
    lobby.configure('', '');
    renderRooms();
    return;
  }
  if (!lobby.configure(settings.serverUrl, settings.accessKey)) lobby.refresh();
}

function sinceText(ts) {
  const min = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (min < 1) return 'gerade eben';
  if (min < 60) return `${min} Min`;
  return `${Math.floor(min / 60)} Std ${min % 60} Min`;
}

function faces(names, max = 3) {
  const shown = names.slice(0, max).map((n) => `<span class="face" style="background:${colorFor(n)}">${initial(n)}</span>`).join('');
  const more = names.length > max ? `<span class="face more">+${names.length - max}</span>` : '';
  return shown + more;
}

function roomCard(r) {
  const title = r.title || 'Ohne Titel';
  const names = r.viewerNames || [];
  const thumb = typeof r.thumb === 'string' && r.thumb.startsWith('data:image/') ? r.thumb : null;
  const watchers = names.length ? `Es schauen: ${names.join(', ')}` : 'Noch niemand schaut zu';
  return `
    <button class="room-card" data-code="${esc(r.code)}" title="${esc(title)} · Code ${esc(r.code)}">
      <div class="rc-thumb">
        ${thumb
          ? `<img src="${esc(thumb)}" alt="">`
          : `<div class="rc-ph">${r.hasPassword ? icon('lock') : `<span class="rc-ph-av" style="background:${colorFor(r.hostName)}">${initial(r.hostName)}</span>`}</div>`}
        <span class="rc-badges"><span class="rc-live">LIVE</span><span class="rc-open">GEÖFFNET</span></span>
        <span class="rc-time" data-since="${Number(r.since) || 0}">${esc(sinceText(r.since))}</span>
        <span class="rc-viewers" title="${esc(watchers)}">${icon('visibility')}${r.viewers}</span>
        <span class="rc-play">${icon(r.hasPassword ? 'lock' : 'play_arrow')}${r.hasPassword ? 'Passwort eingeben' : 'Ansehen'}</span>
      </div>
      <div class="rc-info">
        <span class="rc-av" style="background:${colorFor(r.hostName)}">${initial(r.hostName)}</span>
        <span class="rc-text"><span class="rc-title">${esc(title)}</span><span class="rc-name">${esc(r.hostName)}${r.hasPassword ? ' · mit Passwort' : ''}</span></span>
        ${names.length ? `<span class="rc-faces" title="${esc(watchers)}">${faces(names)}</span>` : ''}
      </div>
    </button>`;
}

function renderRooms(error = null) {
  const box = $('#roomList');
  if (!settings.serverUrl) {
    box.innerHTML = '<div class="room-empty">Kein Server eingerichtet – öffne die Einstellungen und füge eine Einladung ein.</div>';
  } else if (error) {
    box.innerHTML = `<div class="room-empty error">${esc(error.message)}</div>`;
  } else {
    // Der eigene Stream gehoert nicht in „bei Freunden“.
    const list = rooms.filter((r) => !host || r.code !== host.room);
    box.innerHTML = list.length
      ? list.map(roomCard).join('')
      : '<div class="room-empty">Gerade ist niemand öffentlich live.</div>';
  }
  renderNav();
}

// Laufzeit auf den Karten jede Minute nachziehen.
setInterval(() => {
  for (const el of $$('#roomList .rc-time')) el.textContent = sinceText(Number(el.dataset.since));
}, 60000);

function onRooms(list) {
  rooms = list;
  renderRooms();
  renderUser('ok', 'verbunden');
  renderJoinCard();
  notifyNewRooms(list);
}

// Meldet Streams, die seit der letzten Liste neu (oeffentlich) sind. Die erste
// Liste nach dem Start zaehlt nicht – sonst kaeme jeder laufende Stream.
async function notifyNewRooms(list) {
  const codes = new Set(list.map((r) => r.code));
  const fresh = knownRooms ? list.filter((r) => !knownRooms.has(r.code) && (!host || r.code !== host.room)) : [];
  knownRooms = codes;
  if (!fresh.length || settings.notifyLive === false) return;
  const r = fresh[0];
  const title = fresh.length > 1 ? `${fresh.length} Freunde sind jetzt live` : `${r.hostName} ist jetzt live`;
  const body = fresh.length > 1 ? fresh.map((x) => x.hostName).join(', ') : (r.title || 'Ohne Titel');
  // Immer als Windows-Benachrichtigung; ist das Fenster vorne, zusaetzlich
  // ein Hinweis mit „Ansehen“ direkt in der App.
  const shown = await window.api.notify({
    title,
    body,
    room: fresh.length > 1 ? null : r.code,
    link: fresh.length > 1 ? null : joinLink(settings.serverUrl, r.code)
  }).catch(() => false);
  if (!shown) playLiveChime();
  if (!shown || document.hasFocus()) {
    toast(`${title} – ${body}`, 8000, fresh.length > 1 ? null : { label: 'Ansehen', onClick: () => joinFromList(r.code) });
  }
}

// Wie ein Klick auf die Karte: Passwort-Streams brauchen erst die Eingabe.
function joinFromList(code) {
  const r = rooms.find((x) => x.code === code);
  showPage('watch');
  if (tiles.has(code)) {
    browsing = false;
    renderWatch();
    return;
  }
  if (r && r.hasPassword) {
    browsing = true;
    renderWatch();
    setJoinCode(code);
    joinPwNeeded = true;
    renderJoinCard();
    $('#inpJoinPassword').focus();
    return;
  }
  openStream(code);
}

async function openStream(room, password = '', serverUrl = settings.serverUrl) {
  if (!serverUrl && !requireServer()) return;
  const code = String(room || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return;
  browsing = false;
  showPage('watch');
  try {
    await tiles.open({ serverUrl, room: code, password, name: displayName() });
    setJoinCode('');
    $('#inpJoinPassword').value = '';
    setHint();
  } catch (e) {
    // Zurueck auf die Startseite, damit Fehler bzw. Passwortfeld sichtbar sind.
    browsing = true;
    if (e.code === 'bad_password') {
      joinPwNeeded = true;
      joinCode = code.slice(0, CODE_LEN);
      $('#inpJoinCode').value = joinCode;
      renderCodeBoxes();
      renderJoinCard();
      setHint(password ? e.message : PRIVATE_HINT, !!password);
      $('#inpJoinPassword').focus();
    } else {
      setHint(e.message, true);
      toast(e.message, 3500);
    }
  }
  renderNav();
}

// Ein Pop-out kommt zurueck ins Hauptfenster.
async function dockStream(d) {
  showPage('watch');
  browsing = false;
  try {
    const tile = await tiles.open({ serverUrl: d.serverUrl || settings.serverUrl, room: d.room, password: d.password, name: displayName() });
    tile.setVolume(d.volume ?? 1);
    tile.setMuted(!!d.muted);
  } catch (e) {
    toast('Andocken fehlgeschlagen: ' + e.message, 4000);
  }
  renderNav();
}

function popOut(tile) {
  window.api.openPopout({
    serverUrl: tile.serverUrl,
    room: tile.room,
    password: tile.password,
    name: displayName(),
    endSound: settings.endSound !== false,
    title: `${tile.title} – ${tile.hostName}`,
    volume: tile.volume,
    muted: tile.muted
  });
  tiles.remove(tile);
}

/* ---------- Auto-Update ---------- */

// Nach einem Update einmal zeigen, was neu ist. Beim allerersten Start nicht.
function showWhatsNew(version) {
  const last = settings.lastVersion;
  if (last !== version) {
    settings.lastVersion = version;
    persist();
  }
  if (!last || last === version) return;
  const changes = changesBetween(last, version);
  if (!changes.length) return;
  $('#whatsNewTitle').textContent = `Aktualisiert auf Version ${version}`;
  $('#whatsNewList').innerHTML = changes.map((c) => `
    <section>
      <h3>Neu in ${esc(c.version)}</h3>
      <ul>${c.items.map((i) => `<li>${icon('check')}<span>${esc(i)}</span></li>`).join('')}</ul>
    </section>`).join('');
  $('#whatsNewModal').hidden = false;
}

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
  badge.textContent = s.state === 'downloading' ? `Update ${s.percent ?? 0} %` : 'Update';

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

async function openAppSettings(tab = 'account') {
  const info = await window.api.appInfo();
  $('#appVersion').textContent = info.version;
  $('#inpName').value = settings.displayName || '';
  $('#inpServer').value = settings.serverUrl || '';
  $('#inpAccessKey').value = settings.accessKey || '';
  $('#inpInvite').value = '';
  $('#btnCopyInvite').disabled = !settings.serverUrl;
  window.api.getAutostart().then((st) => {
    $('#chkAutostart').checked = st.enabled;
    $('#chkAutostart').disabled = !st.available;
    $('#autostartHint').textContent = st.available
      ? 'Startet minimiert im Hintergrund, damit du Benachrichtigungen bekommst.'
      : 'Nur in der installierten App verfügbar.';
  });
  selectTab($('#settingsTabs'), $$('#appSettingsModal .spane'), tab);
  renderPanel();
  renderUpdateUi();
  $('#appSettingsModal').hidden = false;
  checkServer();
}

// Zeigt, ob Server und Zugangsschluessel passen und ob der Server-Modus geht.
async function checkServer() {
  const el = $('#serverState');
  if (!settings.serverUrl) {
    el.textContent = 'Noch kein Server eingerichtet.';
    renderUser('bad', 'kein Server');
    return;
  }
  el.textContent = 'Prüfe Server…';
  const sig = new Signaling(settings.serverUrl);
  try {
    await sig.connect();
    const res = await sig.request({ type: 'info', key: settings.accessKey }, 'info');
    el.textContent = !res.keyOk
      ? '⚠ Zugangsschlüssel fehlt oder ist falsch.'
      : `✓ Server verbunden${res.sfu ? ', Server-Modus verfügbar' : ', nur P2P'}`;
    renderUser(res.keyOk ? 'ok' : 'bad', res.keyOk ? 'verbunden' : 'Schlüssel fehlt');
  } catch (e) {
    el.textContent = '⚠ ' + e.message;
    renderUser('bad', 'nicht erreichbar');
  } finally {
    sig.close();
  }
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
  toast('Bitte zuerst den Server einrichten (Einladung einfügen).', 3500);
  openAppSettings('connection');
  return false;
}

async function saveAppSettings() {
  const inviteText = $('#inpInvite').value.trim();
  if (inviteText) {
    const inv = parseInvite(inviteText);
    if (!inv || inv.kind !== 'setup') {
      toast('Das ist keine gültige Einladung.');
      return;
    }
    $('#inpServer').value = inv.server;
    $('#inpAccessKey').value = inv.key || '';
  }
  const server = normalizeServerUrl($('#inpServer').value);
  if (server === null) {
    toast('Ungültige Server-Adresse.');
    selectTab($('#settingsTabs'), $$('#appSettingsModal .spane'), 'connection');
    return;
  }
  if (!server) {
    toast('Ohne Server kann nicht gestreamt werden.');
    selectTab($('#settingsTabs'), $$('#appSettingsModal .spane'), 'connection');
    return;
  }
  settings.displayName = $('#inpName').value.trim();
  settings.serverUrl = server;
  settings.accessKey = $('#inpAccessKey').value.trim();
  settings = await window.api.saveSettings(settings);
  $('#appSettingsModal').hidden = true;
  toast('Gespeichert.');
  renderUser();
  refreshRooms();
}

/* ---------- Einladungen (kmdev-stream://...) ---------- */

async function handleInvite(text) {
  const inv = parseInvite(text);
  if (!inv) return;
  if (inv.kind === 'setup') {
    settings.serverUrl = inv.server;
    settings.accessKey = inv.key || '';
    settings = await window.api.saveSettings(settings);
    toast('Server aus Einladung eingerichtet.', 3500);
    refreshRooms();
    if (!settings.displayName) openAppSettings('account');
  } else if (inv.kind === 'join') {
    // Wer noch keinen Server hat, uebernimmt den aus dem Link (ohne Schluessel:
    // zum Zuschauen reicht der Stream-Code).
    if (!settings.serverUrl) {
      settings.serverUrl = inv.server;
      settings = await window.api.saveSettings(settings);
    }
    openStream(inv.room, '', inv.server);
  }
}

/* ---------- Verdrahtung ---------- */

function wire() {
  for (const b of $$('#nav .nav-item')) b.addEventListener('click', () => showPage(b.dataset.page));

  // Quellen
  $('#btnRefreshSources').addEventListener('click', loadSources);
  $('#setupSourceTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setupSourceType = b.dataset.type;
    renderSourceGrid();
  });
  $('#sourceGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.source');
    if (b && b.dataset.id !== selectedSourceId) pickSource(b.dataset.id);
  });
  $('#btnChangeSource').addEventListener('click', openSourceModal);
  $('#sourceTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    modalSourceType = b.dataset.type;
    renderSourceModal();
  });
  $('#sourceModalGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.source');
    if (b) pickSource(b.dataset.id);
  });

  // Senden
  $('#btnStart').addEventListener('click', startHosting);
  $('#btnStop').addEventListener('click', stopHosting);
  $('#btnCopyCode').addEventListener('click', () => {
    navigator.clipboard.writeText(host ? host.room : '');
    toast('Code kopiert.');
  });
  $('#btnCopyLink').addEventListener('click', () => {
    if (!host) return;
    navigator.clipboard.writeText(watchUrl(settings.serverUrl, host.room));
    toast('Link kopiert – öffnet den Stream im Browser oder in der App.', 3500);
  });
  $('#btnViewers').addEventListener('click', () => {
    const pop = $('#viewerPop');
    pop.hidden = !pop.hidden;
    $('#btnViewers').classList.toggle('open', !pop.hidden);
  });
  $('#viewerTable').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kick]');
    if (b && host && b.dataset.kick !== SFU_ID) host.session.kick(b.dataset.kick);
  });

  // Zuschauen: Code oder eingefuegter Link
  const code = $('#inpJoinCode');
  code.addEventListener('input', onCodeInput);
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinNow(); });
  code.addEventListener('focus', () => $('.code-entry').classList.add('focus'));
  code.addEventListener('blur', () => $('.code-entry').classList.remove('focus'));
  $('#inpJoinPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinNow(); });
  $('#btnJoin').addEventListener('click', joinNow);
  // Strg + V irgendwo auf der Startseite: Link oder Code uebernehmen.
  document.addEventListener('paste', (e) => {
    if (currentPage() !== 'watch' || $('#watchHome').hidden) return;
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    code.value = text.trim();
    onCodeInput();
    code.focus();
  });

  $('#btnRefreshRooms').addEventListener('click', refreshRooms);
  $('#roomList').addEventListener('click', (e) => {
    const item = e.target.closest('.room-card');
    if (item) joinFromList(item.dataset.code);
  });
  lobby.addEventListener('rooms', (e) => onRooms(e.detail));
  lobby.addEventListener('error', (e) => {
    const err = e.detail;
    if (err.code === 'bad_key') {
      rooms = [];
      renderRooms(err);
      renderUser('bad', 'Schlüssel fehlt');
    } else if (!lobby.connected) {
      renderRooms(err);
      renderUser('bad', 'nicht erreichbar');
    }
  });
  // Klick auf eine Windows-Benachrichtigung
  window.api.onPopoutDock(dockStream);
  window.api.onAppFocus((on) => { appFocused = on; applyPause(); });
  window.api.onNotifyOpen((room) => (room ? joinFromList(room) : showPage('watch')));
  $('#btnBackToTiles').addEventListener('click', () => {
    browsing = false;
    renderWatch();
  });
  $('#btnAddStream').addEventListener('click', () => {
    browsing = true;
    renderWatch();
    refreshRooms();
    $('#inpJoinCode').focus();
  });

  const pickLayout = (v) => {
    settings.watchLayout = v;
    tiles.setLayout(v);
    refreshSeg(segs.layout);
    refreshSeg(segs.layoutS);
    persist();
  };
  segs.layout = $('#segLayout');
  wireSeg(segs.layout, () => settings.watchLayout, pickLayout);
  segs.layoutS = $('#segLayoutS');
  wireSeg(segs.layoutS, () => settings.watchLayout, pickLayout);
  $('#btnCloseAll').addEventListener('click', () => tiles.closeAll());

  // Steuerleiste ausblenden, wenn die Maus ruht.
  const stage = $('#watchStage');
  let idleTimer = null;
  stage.addEventListener('pointermove', () => {
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stage.classList.add('idle'), 2500);
  });
  stage.addEventListener('pointerleave', () => stage.classList.remove('idle'));

  // Einstellungen
  $('#btnSettings').addEventListener('click', () => openAppSettings());
  $('#avatar').addEventListener('click', () => openAppSettings('account'));
  wireTabs($('#settingsTabs'), $$('#appSettingsModal .spane'));
  $('#btnSaveAppSettings').addEventListener('click', saveAppSettings);
  $('#btnCopyInvite').addEventListener('click', () => {
    if (!settings.serverUrl) return;
    navigator.clipboard.writeText(setupInvite(settings.serverUrl, settings.accessKey));
    toast('Einladung kopiert. Enthält den Zugangsschlüssel – nur an Vertraute geben.', 4500);
  });
  $('#btnCheckUpdate').addEventListener('click', async () => {
    updateState = await window.api.checkUpdate();
    renderUpdateUi();
  });
  $('#btnInstallUpdate').addEventListener('click', () => window.api.installUpdate());
  $('#updateBadge').addEventListener('click', () => openAppSettings('about'));
  window.api.onInvite(handleInvite);

  for (const m of $$('.modal')) {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const m of $$('.modal')) m.hidden = true;
    $('#viewerPop').hidden = true;
    $('#btnViewers').classList.remove('open');
  });
  document.addEventListener('visibilitychange', () => {
    updateLobbySpeed();
    if (!document.hidden) refreshRooms();
  });
  // Fenster schliessen beendet den eigenen Stream sauber (Zuschauer bekommen
  // sofort „Stream beendet“ statt auf den Verbindungsabbruch zu warten).
  window.addEventListener('beforeunload', () => { if (host) stopHosting(); });

  window.api.onUpdate((s) => {
    updateState = s;
    renderUpdateUi();
  });

  appAudio.addEventListener('apps', renderAppList);
  appAudio.addEventListener('status', renderAppList);
}

function initTiles() {
  tiles = new TileManager($('#tiles'));
  tiles.setLayout(settings.watchLayout || 'grid');
  tiles.addEventListener('change', renderNav);
  tiles.addEventListener('popout', (e) => popOut(e.detail));
  tiles.addEventListener('ended', (e) => {
    if (settings.endSound !== false) playEndChime();
    toast(`${e.detail.tile.hostName || 'Stream'}: ${e.detail.message}`, 4000);
  });
  // Fokus per Doppelklick schaltet die Anordnung um -> Auswahl mitziehen.
  tiles.addEventListener('layout', (e) => {
    settings.watchLayout = e.detail;
    refreshSeg(segs.layout);
    refreshSeg(segs.layoutS);
    persist();
  });
}

async function init() {
  hydrateIcons();
  settings = await window.api.getSettings();
  settings.codec = settings.codec || 'h264';
  if (settings.preset !== null && !PRESETS[settings.preset]) settings.preset = matchPreset(settings);
  initPanel();
  initTiles();
  wire();
  renderPanel();
  renderCodeBoxes();
  renderSendView();
  renderViewers();
  renderNav();
  renderUser();
  updateState = await window.api.updateStatus();
  renderUpdateUi();
  const info = await window.api.appInfo();
  document.title = `KM-DEV Stream ${info.version}`;
  showWhatsNew(info.version);
  if (settings.appAudio) applyAppAudio();
  else renderAppList();
  loadSources();
  refreshRooms();
  if (!settings.displayName || !settings.serverUrl) {
    setTimeout(() => openAppSettings(settings.displayName ? 'connection' : 'account'), 300);
  }
}

init();
