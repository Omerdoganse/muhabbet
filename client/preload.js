const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('muhabbet', {
  isDesktop: true,
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, name) => cb(name)),
  setServer: (url) => ipcRenderer.send('set-server', url),
});
