const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('muhabbet', {
  isDesktop: true,
  version: 2,
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, name) => cb(name)),
  setServer: (url) => ipcRenderer.send('set-server', url),
  // Ekran paylaşımı seçicisi: ana süreç kaynak listesini yollar, arayüz seçimi geri yollar
  onPickSource: (cb) =>
    ipcRenderer.on('pick-source', async (_e, reqId, list) => {
      let choice = null;
      try { choice = await cb(list); } catch {}
      ipcRenderer.send('pick-source-reply', reqId, choice);
    }),
});
