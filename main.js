const { app, BrowserWindow, ipcMain, desktopCapturer, session, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const updater = require('./updater');
const audio = require('./audio');

const ICON = path.join(__dirname, 'build', 'icon.ico');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const PROTOCOL = 'kmdev-stream';

let win = null;
let streaming = false;
let selectedSourceId = null;
let pendingInvite = null; // Einladungslink, bevor das Fenster bereit ist

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
  accessKey: '',
  displayName: '',
  preset: '1080',
  resolution: '1080',
  fps: 60,
  bitrate: 6000,
  audioBitrate: 128,
  appAudio: true,
  // Anwendungsaudio: 'all' = alle Apps, 'include' = nur ausgewaehlte,
  // 'exclude' = alle ausser ausgewaehlten. Die eigene App ist nie dabei.
  // Sprach-Chats sind von Anfang an stumm (siehe VOICE_APPS im Renderer).
  audioMode: 'exclude',
  audioSelected: ['discord.exe', 'discordptb.exe', 'discordcanary.exe', 'ts3client_win64.exe', 'ts3client_win32.exe', 'teamspeak.exe'],
  audioVolumes: {},
  audioMaster: 1,
  // Zuschauen: Anordnung der Kacheln ('grid' | 'focus' | 'free')
  watchLayout: 'grid',
  privacy: 'private',
  viewerLimit: 10,
  connectionMode: 'p2p',
  title: '',
  joinSound: true, // Ton, wenn beim eigenen Stream jemand beitritt
  settingsVersion: 2
};

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch { /* erster Start */ }
  // Bis Version 1 war "unbegrenzt" (0) voreingestellt – einmalig auf 10 setzen.
  if (Object.keys(saved).length && !saved.settingsVersion) {
    if (!saved.viewerLimit) saved.viewerLimit = 10;
    saved.settingsVersion = 2;
  }
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
    backgroundColor: '#0d1110',
    autoHideMenuBar: true,
    icon: ICON,
    title: `KM-DEV Stream ${app.getVersion()}`,
    // Eigene Kopfleiste als Titelleiste; Windows zeichnet nur die Fensterknoepfe darueber.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d1110', symbolColor: '#9aa6a1', height: 60 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Stream soll auch im minimierten Fenster mit voller Rate weiterlaufen.
      backgroundThrottling: false,
      // Anwendungsaudio laeuft ueber einen AudioContext, der ohne Klick starten muss.
      autoplayPolicy: 'no-user-gesture-required'
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
  // Pop-out-Fenster gehoeren zum Hauptfenster.
  win.on('closed', () => {
    for (const w of popouts) if (!w.isDestroyed()) w.close();
    audio.stop();
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
      // 'loopback' = gesamter Systemton. Nur noch Rueckfall, wenn das
      // Anwendungsaudio (audio.js, WASAPI Process Loopback) nicht verfuegbar ist.
      if (request.audioRequested) result.audio = 'loopback';
      callback(result);
    } catch (err) {
      console.error('displayMedia', err);
      callback({});
    }
  });
}

// Unsichtbare Overlays und Hilfsfenster (Treiber, Tastatur-Tools, Eingabe-
// methoden), die Windows als Fenster meldet, die man aber nicht streamen will.
const HIDDEN_WINDOWS = [
  /^nvidia geforce overlay/i, /^nvidia overlay/i, /^amd (software|radeon).*overlay/i,
  /^rzmonitorforegroundwindow$/i,
  /^program manager$/i, /^windows input experience$/i, /^microsoft text input application$/i,
  /^default ime$/i, /^msctfime ui$/i, /^task switching$/i, /^start$/i, /^search$/i
];

// Komplett durchsichtiges Vorschaubild = Overlay ohne eigenen Inhalt.
function isTransparent(img) {
  if (img.isEmpty()) return false;
  const bmp = img.toBitmap(); // BGRA
  for (let i = 3; i < bmp.length; i += 4 * 97) if (bmp[i] !== 0) return false;
  return true;
}

function isStreamableWindow(s) {
  const name = String(s.name || '').trim();
  if (!name) return false;
  if (HIDDEN_WINDOWS.some((re) => re.test(name))) return false;
  return !isTransparent(s.thumbnail);
}

ipcMain.handle('capture:sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 640, height: 360 },
    fetchWindowIcons: true
  });
  return sources
    // Das eigene Fenster nicht anbieten – ergibt nur einen Spiegel-Effekt.
    .filter((s) => !win || s.id !== win.getMediaSourceId())
    .filter((s) => s.id.startsWith('screen:') || isStreamableWindow(s))
    .map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      displayId: s.display_id,
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
    }));
});

// Programm hinter einer Fenster-Quelle ("window:<HWND>:0") -> "chrome.exe".
// Dient nur als Vorauswahl fuer das Anwendungsaudio.
ipcMain.handle('capture:window-exe', (_e, id) => {
  const m = /^window:(\d+):/.exec(String(id));
  if (!m || process.platform !== 'win32') return null;
  const script = [
    '$t = Add-Type -PassThru -Name W -Namespace K -MemberDefinition \'[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);\'',
    '$p = 0',
    `[void]$t::GetWindowThreadProcessId([IntPtr]${m[1]}, [ref]$p)`,
    'if ($p) { (Get-Process -Id $p).Path }'
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 }, (err, out) => {
      const exe = path.basename(String(out || '').trim()).toLowerCase();
      // Store-Apps haengen alle am selben Rahmenprozess – der sagt nichts ueber den Ton.
      resolve(err || !exe || exe === 'applicationframehost.exe' ? null : exe);
    });
  });
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

/* ---------- Anwendungsaudio ---------- */

function sendToWin(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

audio.init({
  onStatus: (s) => sendToWin('audio:status', s),
  onApps: (apps) => sendToWin('audio:apps', apps)
});
ipcMain.handle('audio:start', (e) => audio.start(e.sender));
ipcMain.handle('audio:stop', () => audio.stop());
ipcMain.handle('audio:config', (_e, cfg) => audio.configure(cfg));
ipcMain.handle('audio:list', () => audio.requestList());

/* ---------- Pop-out: einzelner Stream im eigenen Fenster ---------- */

const popouts = new Set();

ipcMain.handle('popout:open', (_e, data) => {
  const w = new BrowserWindow({
    width: 1100,
    height: 640,
    minWidth: 320,
    minHeight: 200,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: ICON,
    title: String(data.title || 'Stream'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  popouts.add(w);
  w.on('closed', () => popouts.delete(w));
  // Daten nur lokal ueber die Adresszeile der Datei (verlassen den Rechner nicht).
  const d = Buffer.from(JSON.stringify(data)).toString('base64url');
  w.loadFile(path.join(__dirname, 'renderer', 'popout.html'), { query: { d } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return true;
});

ipcMain.handle('popout:pin', (e, on) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && popouts.has(w)) w.setAlwaysOnTop(!!on);
  return !!on;
});

/* ---------- Einladungslinks (kmdev-stream://...) ----------
   Windows startet die App mit dem Link als Argument; laeuft sie schon, kommt
   er ueber 'second-instance'. Ausgewertet wird im Renderer (invite.js). */

function findInvite(argv) {
  return argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(PROTOCOL + '://')) || null;
}

function deliverInvite(link) {
  if (!link) return;
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('invite', link);
  else pendingInvite = link;
}

ipcMain.handle('invite:take', () => {
  const link = pendingInvite;
  pendingInvite = null;
  return link;
});

/* ---------- Start ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Der Installer registriert das Protokoll ebenfalls; hier nur nachziehen,
  // falls die App verschoben wurde. Entwicklungsstarts registrieren nichts.
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
  pendingInvite = findInvite(process.argv);

  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    deliverInvite(findInvite(argv));
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
    audio.stop();
    app.quit();
  });
}
