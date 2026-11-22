const { app, BrowserWindow, globalShortcut, session, shell, ipcMain, desktopCapturer } = require('electron');
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

  // Mikrofon ve ekran paylaşımı izinlerini otomatik ver
  // (ekranın hangisinin paylaşılacağını yine de kullanıcı seçer)
  const ALLOWED = new Set(['media', 'display-capture']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));

  // Ekran paylaşımı: hangi ekran/pencerenin paylaşılacağını uygulamadaki seçiciden sor
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    } catch {}
    const list = sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
    const choice = await new Promise((resolve) => {
      const reqId = String(Date.now()) + Math.random();
      const onReply = (_e, id, c) => {
        if (id !== reqId) return;
        ipcMain.removeListener('pick-source-reply', onReply);
        resolve(c);
      };
      ipcMain.on('pick-source-reply', onReply);
      win.webContents.send('pick-source', reqId, list);
    });
    const src = choice && sources.find((s) => s.id === choice.id);
    try {
      if (!src) return callback({});
      // "loopback" = bilgisayarın sesi (Windows)
      callback(choice.audio ? { video: src, audio: 'loopback' } : { video: src });
    } catch {}
  });

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

  // Kayıtlı adres sadece aynı varsayılan adresle kaydedildiyse kullanılır;
  // exe yeni bir varsayılan adresle gelirse (ör. tünelden Render'a geçiş) yenisi geçerli olur
  const saved = readSettings();
  const def = defaultServer();
  const server = (saved.server && saved.base === def ? saved.server : null) || def;
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
  globalShortcut.register('CommandOrControl+Shift+K', () => win?.webContents.send('hotkey', 'clip'));
}

// Başarıyla bağlanılan sunucuyu hatırla: bir sonraki açılışta arayüz oradan yüklenir
ipcMain.on('set-server', (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/.test(url)) return;
  const s = readSettings();
  const base = defaultServer();
  if (s.server !== url || s.base !== base) writeSettings({ ...s, server: url, base });
});

app.whenReady().then(createWindow);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
