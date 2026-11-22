const { app, BrowserWindow, globalShortcut, session, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// Arayüz sunucudan yüklenir: sunucudaki her güncelleme herkese otomatik ulaşır.
// Sunucuya ulaşılamazsa exe'nin içindeki arayüz açılır (oradan başka adres girilebilir).

let win;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s)); } catch {}
}
function defaultServer() {
  try {
    const ctx = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'app', 'config.js'), 'utf8'), ctx);
    return ctx.window.MUHABBET_CONFIG?.defaultServer || null;
  } catch {
    return null;
  }
}

const localUI = () => win.loadFile(path.join(__dirname, 'app', 'index.html'));

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#f3e8ff',
    title: 'Muhabbet',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // oyun oynarken (pencere arka plandayken) ses kesilmesin
    },
  });

  // Mikrofon iznini otomatik ver
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  // Yeni pencere açan linkler varsayılan tarayıcıda açılsın
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Uygulama sayfası dışındaki adreslere gitmeyi engelle, tarayıcıda aç
  win.webContents.on('will-navigate', (e, url) => {
    const current = win.webContents.getURL();
    let same = false;
    try { same = new URL(url).origin === new URL(current).origin && !current.startsWith('file:'); } catch {}
    if (!same) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  const server = readSettings().server || defaultServer();
  if (server) {
    win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && url.startsWith('http')) localUI();
    });
    win
      .loadFile(path.join(__dirname, 'app', 'loading.html'))
      .then(() => win.loadURL(server))
      .catch(() => {});
  } else {
    localUI();
  }

  // Global kısayollar: oyun penceresi öndeyken bile çalışır
  globalShortcut.register('CommandOrControl+Shift+M', () => win?.webContents.send('hotkey', 'toggle-mute'));
  globalShortcut.register('CommandOrControl+Shift+D', () => win?.webContents.send('hotkey', 'toggle-deafen'));
}

// Başarıyla bağlanılan sunucuyu hatırla: bir sonraki açılışta arayüz oradan yüklenir
ipcMain.on('set-server', (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/.test(url)) return;
  const s = readSettings();
  if (s.server !== url) writeSettings({ ...s, server: url });
});

app.whenReady().then(createWindow);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
