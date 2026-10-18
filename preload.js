const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  appInfo: () => ipcRenderer.invoke('app:info'),
  setStreaming: (on) => ipcRenderer.invoke('app:streaming', on),
  openUrl: (url) => ipcRenderer.invoke('shell:open', url),

  getSources: () => ipcRenderer.invoke('capture:sources'),
  selectSource: (id) => ipcRenderer.invoke('capture:select', id),

  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update:event', (_e, s) => cb(s)),

  // Einladungslinks: einen evtl. beim Start uebergebenen Link sofort holen,
  // danach auf weitere warten.
  onInvite: (cb) => {
    ipcRenderer.on('invite', (_e, link) => cb(link));
    ipcRenderer.invoke('invite:take').then((link) => link && cb(link));
  }
});
