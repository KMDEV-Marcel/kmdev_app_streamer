/*
 * Anwendungsaudio (Ausbaustufe 3): steuert native/kmdev-audio.exe.
 *
 * Das Hilfsprogramm nimmt den Ton einzelner Programme per WASAPI Process
 * Loopback auf, mischt ihn und liefert PCM (Float32, Stereo, 48 kHz). Der Ton
 * geht ueber einen MessagePort direkt an den AudioWorklet im Renderer, ohne
 * Umweg ueber IPC-Nachrichten pro Paket.
 */
const { app, MessageChannelMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const EXE = app.isPackaged
  ? path.join(process.resourcesPath, 'kmdev-audio.exe')
  : path.join(__dirname, 'native', 'bin', 'kmdev-audio.exe');

let proc = null;
let port = null;        // MessagePortMain -> Renderer
let lastConfig = null;
let status = { state: 'off' }; // off | starting | ready | unsupported | missing | error
let onStatus = () => {};
let onApps = () => {};
const iconCache = new Map(); // Pfad -> data-URL

function setStatus(s) {
  status = s;
  onStatus(s);
}

async function iconFor(file) {
  if (!file) return null;
  if (iconCache.has(file)) return iconCache.get(file);
  let url = null;
  try {
    url = (await app.getFileIcon(file, { size: 'small' })).toDataURL();
  } catch { /* kein Symbol */ }
  iconCache.set(file, url);
  return url;
}

async function handleJson(msg) {
  if (msg.type === 'ready') setStatus({ state: 'ready' });
  else if (msg.type === 'unsupported') setStatus({ state: 'unsupported', message: msg.message });
  else if (msg.type === 'apps') {
    const apps = await Promise.all(msg.apps.map(async (a) => ({ ...a, icon: await iconFor(a.path) })));
    onApps(apps);
  }
}

function sendConfig() {
  if (!proc || !lastConfig) return;
  const { mode, master, selected, volumes } = lastConfig;
  const clean = (s) => String(s).replace(/[\t\r\n,;=]/g, '');
  const sel = (selected || []).map(clean).join(',');
  const vols = Object.entries(volumes || {}).map(([exe, v]) => `${clean(exe)}=${Number(v).toFixed(3)}`).join(';');
  proc.stdin.write(`config\t${mode}\t${Number(master).toFixed(3)}\t${sel}\t${vols}\n`);
}

// Startet das Hilfsprogramm und gibt dem Fenster das Ende des MessagePorts.
function start(webContents) {
  if (proc) {
    attachPort(webContents);
    return status;
  }
  if (!fs.existsSync(EXE)) {
    setStatus({ state: 'missing', message: 'kmdev-audio.exe fehlt – App neu installieren.' });
    return status;
  }
  setStatus({ state: 'starting' });
  proc = spawn(EXE, ['--exclude-tree', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  attachPort(webContents);

  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(1);
      if (buf.length < 5 + len) break;
      const type = buf[0];
      const body = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      if (type === 0x50 /* P */) {
        // Eigene Kopie mit passender Ausrichtung fuer Float32Array im Worklet.
        if (port) port.postMessage(Uint8Array.from(body));
      } else if (type === 0x4a /* J */) {
        try { handleJson(JSON.parse(body.toString('utf8'))); } catch { /* ignorieren */ }
      }
    }
  });
  proc.on('exit', (code) => {
    proc = null;
    if (status.state !== 'unsupported') setStatus(code === 0 ? { state: 'off' } : { state: 'error', message: `Audio-Hilfsprogramm beendet (${code})` });
  });
  sendConfig();
  return status;
}

function attachPort(webContents) {
  if (port) port.close();
  const { port1, port2 } = new MessageChannelMain();
  port = port1;
  port.start();
  webContents.postMessage('audio:port', null, [port2]);
}

function configure(cfg) {
  lastConfig = cfg;
  sendConfig();
}

function requestList() {
  if (proc) proc.stdin.write('list\n');
}

function stop() {
  if (port) { port.close(); port = null; }
  if (!proc) return;
  try { proc.stdin.write('quit\n'); } catch { /* schon zu */ }
  const p = proc;
  setTimeout(() => { if (!p.killed && p.exitCode === null) p.kill(); }, 1000);
}

function init(handlers) {
  onStatus = handlers.onStatus || onStatus;
  onApps = handlers.onApps || onApps;
}

module.exports = { init, start, stop, configure, requestList, status: () => status };
