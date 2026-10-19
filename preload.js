const { contextBridge, ipcRenderer } = require('electron');

ipcRenderer.on('audio:port', (e) => window.postMessage('kmdev:audio-port', '*', e.ports));

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  appInfo: () => ipcRenderer.invoke('app:info'),
  setStreaming: (on) => ipcRenderer.invoke('app:streaming', on),
  openUrl: (url) => ipcRenderer.invoke('shell:open', url),

  getSources: () => ipcRenderer.invoke('capture:sources'),
  selectSource: (id) => ipcRenderer.invoke('capture:select', id),
  windowExe: (id) => ipcRenderer.invoke('capture:window-exe', id),

  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update:event', (_e, s) => cb(s)),

  // Anwendungsaudio: Der MessagePort mit dem PCM-Ton kommt per window.postMessage
  // ('kmdev:audio-port') in die Seite, weil Ports nicht ueber contextBridge gehen.
  audioStart: () => ipcRenderer.invoke('audio:start'),
  audioStop: () => ipcRenderer.invoke('audio:stop'),
  audioConfig: (cfg) => ipcRenderer.invoke('audio:config', cfg),
  audioList: () => ipcRenderer.invoke('audio:list'),
  onAudioStatus: (cb) => ipcRenderer.on('audio:status', (_e, s) => cb(s)),
  onAudioApps: (cb) => ipcRenderer.on('audio:apps', (_e, apps) => cb(apps)),

  // Windows-Benachrichtigung, wenn jemand live geht; Klick -> onNotifyOpen(room)
  notify: (n) => ipcRenderer.invoke('notify:show', n),
  onNotifyOpen: (cb) => ipcRenderer.on('notify:open', (_e, room) => cb(room)),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),

  openPopout: (data) => ipcRenderer.invoke('popout:open', data),
  pinPopout: (on) => ipcRenderer.invoke('popout:pin', on),

  // Einladungslinks: einen evtl. beim Start uebergebenen Link sofort holen,
  // danach auf weitere warten.
  onInvite: (cb) => {
    ipcRenderer.on('invite', (_e, link) => cb(link));
    ipcRenderer.invoke('invite:take').then((link) => link && cb(link));
  }
});
