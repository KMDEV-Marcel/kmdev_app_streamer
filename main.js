const { app, BrowserWindow, ipcMain, desktopCapturer, session, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const updater = require('./updater');

const ICON = path.join(__dirname, 'build', 'icon.ico');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

let win = null;
let streaming = false;
let selectedSourceId = null;

/* ---------- Einstellungen ---------- */

// Bis 0.1.0 hiess die App "KMDev Stream" – Electron legte die Einstellungen
// unter diesem Namen ab. Beim ersten Start nach der Umbenennung uebernehmen.
function migrateLegacySettings() {
  const legacy = path.join(app.getPath('appData'), 'KMDev Stream', 'settings.json');
  if (fs.existsSync(SETTINGS_PATH) || !fs.existsSync(legacy)) return;
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.copyFileSync(legacy, SETTINGS_PATH);
  } catch (e) {
    console.warn('Alte Einstellungen nicht uebernommen', e);
  }
}
migrateLegacySettings();

// Keine Server-Adresse vorgegeben: Jeder Nutzer traegt seinen Server beim
// ersten Start selbst ein (Repo ist oeffentlich, keine Domains im Code).
const DEFAULT_SETTINGS = {
  serverUrl: '',
  displayName: '',
  preset: '1080',
  resolution: '1080',
  fps: 60,
  bitrate: 6000,
  audioBitrate: 128,
  appAudio: true,
  privacy: 'private',
  viewerLimit: 0,
  connectionMode: 'p2p',
  title: ''
};

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch { /* erster Start */ }
  return { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings(s) {
  const merged = { ...loadSettings(), ...s };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

/* ---------- Fenster ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    icon: ICON,
    title: `KM-DEV Stream ${app.getVersion()}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Stream soll auch im minimierten Fenster mit voller Rate weiterlaufen.
      backgroundThrottling: false
    }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('close', (e) => {
    if (!streaming) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Stream beenden und schließen', 'Abbrechen'],
      defaultId: 1,
      cancelId: 1,
      title: 'Stream läuft',
      message: 'Es läuft gerade ein Stream. Wirklich beenden?'
    });
    if (choice !== 0) e.preventDefault();
  });

  // Links aus der Oberflaeche im Standardbrowser oeffnen, nie im App-Fenster.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ---------- Bildschirmaufnahme ----------
   Der Renderer zeigt eine eigene Quellen-Auswahl (Bildschirme/Fenster mit
   Vorschaubild), merkt die Wahl hier per IPC an und ruft dann
   getDisplayMedia() auf. Dieser Handler beantwortet den Aufruf mit der
   gemerkten Quelle – so greifen die Constraints (Aufloesung/FPS) und es gibt
   keinen zweiten System-Dialog. */

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === selectedSourceId);
      if (!source) {
        callback({});
        return;
      }
      const result = { video: source };
      // 'loopback' = gesamter Systemton (Windows). Pro-App-Audio folgt in
      // Ausbaustufe 3 ueber WASAPI Process Loopback.
      if (request.audioRequested) result.audio = 'loopback';
      callback(result);
    } catch (err) {
      console.error('displayMedia', err);
      callback({});
    }
  });
}

ipcMain.handle('capture:sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });
  return sources
    // Das eigene Fenster nicht anbieten – ergibt nur einen Spiegel-Effekt.
    .filter((s) => !win || s.id !== win.getMediaSourceId())
    .map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      displayId: s.display_id,
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
    }));
});

ipcMain.handle('capture:select', (_e, id) => {
  selectedSourceId = id;
  return true;
});

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_e, s) => saveSettings(s));
ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.handle('app:streaming', (_e, on) => {
  streaming = !!on;
  if (win) win.setTitle(`KM-DEV Stream ${app.getVersion()}${streaming ? ' – LIVE' : ''}`);
  return streaming;
});
ipcMain.handle('shell:open', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

/* ---------- Start ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    installDisplayMediaHandler();
    createWindow();
    updater.init({
      onStatus: (status) => win && !win.isDestroyed() && win.webContents.send('update:event', status)
    });
  });

  app.on('window-all-closed', () => {
    updater.stop();
    app.quit();
  });
}
