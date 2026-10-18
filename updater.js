/*
 * Auto-Update ueber electron-updater aus den GitHub Releases dieses Repos.
 *
 * Die Quelle steht in package.json -> build.publish (provider "github").
 * electron-builder legt daraus resources/app-update.yml in die installierte
 * App. Das Repo ist oeffentlich, die Clients brauchen also kein Token.
 */
const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let sendStatus = () => {};
let lastStatus = { state: 'idle' };
let timer = null;

function emit(status) {
  lastStatus = status;
  sendStatus(status);
}

function init({ onStatus }) {
  sendStatus = onStatus;

  ipcMain.handle('update:status', () => lastStatus);
  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:install', () => {
    if (lastStatus.state !== 'ready') return false;
    // isSilent=false zeigt den NSIS-Fortschritt, isForceRunAfter startet die
    // App nach der Installation wieder.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });

  if (!app.isPackaged) {
    emit({ state: 'dev', message: 'Auto-Update ist nur in der installierten Version aktiv.' });
    return;
  }

  autoUpdater.autoDownload = true;
  // Falls der Nutzer nicht sofort neu startet, wird das Update beim
  // naechsten Beenden installiert.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => emit({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => emit({ state: 'none', version: app.getVersion() }));
  autoUpdater.on('download-progress', (p) => emit({
    state: 'downloading',
    percent: Math.round(p.percent),
    bytesPerSecond: p.bytesPerSecond
  }));
  autoUpdater.on('update-downloaded', (info) => emit({
    state: 'ready',
    version: info.version,
    notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
  }));
  autoUpdater.on('error', (err) => {
    const message = String(err && err.message || err);
    // Noch kein Release im Repo -> kein Fehler, nur nichts zu holen.
    if (/No published versions/i.test(message)) emit({ state: 'none', version: app.getVersion() });
    else emit({ state: 'error', message });
  });

  setTimeout(check, 5000);
  timer = setInterval(check, CHECK_INTERVAL_MS);
}

async function check() {
  if (!app.isPackaged) return lastStatus;
  // Waehrend ein Download laeuft oder schon bereitliegt, nicht neu pruefen.
  if (lastStatus.state === 'downloading' || lastStatus.state === 'ready') return lastStatus;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    emit({ state: 'error', message: String(err && err.message || err) });
  }
  return lastStatus;
}

function stop() {
  if (timer) clearInterval(timer);
}

module.exports = { init, check, stop };
