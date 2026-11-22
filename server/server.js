// Muhabbet sinyal + sohbet sunucusu
// - Yazılı sohbet ve özel mesajları dağıtır (kanal geçmişi bellekte, son 100 mesaj)
// - Fotoğraf/dosya yüklemelerini saklar ve sunar (en fazla 25 MB, 3 gün sonra silinir)
// - Sesli kanallar için WebRTC sinyallerini (offer/answer/ICE) iletir
// - Ses verisi sunucudan GEÇMEZ; kullanıcılar arasında doğrudan (P2P) akar
// - client/app klasörünü sunar: masaüstü uygulaması arayüzü buradan yükler,
//   böylece arayüz güncellemeleri herkese otomatik ulaşır

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const TEXT_CHANNELS = ['genel', 'oyun', 'klipler'];
const VOICE_CHANNELS = ['Genel Ses', 'Oyun Odası 1', 'Oyun Odası 2', 'AFK'];
const HISTORY_LIMIT = 100;
const MAX_FILE = 25 * 1024 * 1024;
const TOO_BIG = "Dosya 25 MB'dan büyük olamaz";
const FILE_TTL = 3 * 24 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const FILE_RE = /^[a-f0-9]{24}(\.[a-z0-9]{1,8})?$/;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e5 });

const users = new Map(); // socketId -> { id, name, voice, muted, deafened }
const history = Object.fromEntries(TEXT_CHANNELS.map((c) => [c, []]));
let msgCounter = 0;

const userList = () => [...users.values()];
const broadcastUsers = () => io.emit('users', userList());

/* ---------------- HTTP ---------------- */
app.use(express.static(path.join(__dirname, '..', 'client', 'app')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Dosya yükleme (yalnızca bağlı kullanıcılar)
app.use('/upload', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Socket-Id');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Dosya belleğe alınmaz, parça parça doğrudan diske yazılır (sunucu belleği dolmasın)
app.post('/upload', (req, res) => {
  if (!users.has(req.get('X-Socket-Id'))) return res.status(403).json({ error: 'Sunucuya bağlı değilsin' });
  if (Number(req.get('Content-Length')) > MAX_FILE) return res.status(413).json({ error: TOO_BIG });
  let name = 'dosya';
  try { name = decodeURIComponent(req.get('X-Filename') || 'dosya'); } catch {}
  name = name.replace(/[\\/\r\n"]/g, '_').slice(0, 120) || 'dosya';
  let ext = path.extname(name).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = '';
  const file = crypto.randomBytes(12).toString('hex') + ext;
  const dest = path.join(UPLOAD_DIR, file);
  const out = fs.createWriteStream(dest);
  let size = 0;
  let failed = false;
  const fail = (code, error) => {
    if (failed) return;
    failed = true;
    req.unpipe(out);
    out.destroy();
    fs.unlink(dest, () => {});
    if (!res.headersSent) res.status(code).json({ error });
    req.resume(); // kalan veriyi boşa akıt
  };
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_FILE) fail(413, TOO_BIG);
  });
  req.on('aborted', () => fail(400, 'Yükleme yarıda kesildi'));
  out.on('error', () => fail(500, 'Dosya kaydedilemedi'));
  out.on('finish', () => {
    if (failed) return;
    if (!size) {
      fs.unlink(dest, () => {});
      return res.status(400).json({ error: 'Dosya boş' });
    }
    res.json({ url: '/files/' + file, name, size, image: IMAGE_EXT.has(ext) });
  });
  req.pipe(out);
});

// Dosya indirme: resimler sayfada gösterilir, diğer her şey "indir" olarak gelir (güvenlik)
app.get('/files/:file', (req, res) => {
  const f = req.params.file;
  if (!FILE_RE.test(f)) return res.sendStatus(404);
  const p = path.join(UPLOAD_DIR, f);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const onErr = (err) => { if (err && !res.headersSent) res.sendStatus(404); };
  if (IMAGE_EXT.has(path.extname(f).toLowerCase())) return res.sendFile(p, onErr);
  res.download(p, String(req.query.name || f).slice(0, 120), onErr);
});

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: 'Sunucu hatası' });
});

// Eski dosyaları temizle
setInterval(() => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return;
    for (const f of files) {
      const p = path.join(UPLOAD_DIR, f);
      fs.stat(p, (e, st) => { if (!e && Date.now() - st.mtimeMs > FILE_TTL) fs.unlink(p, () => {}); });
    }
  });
}, 60 * 60 * 1000);

/* ---------------- Socket.IO ---------------- */
function cleanFile(f) {
  if (!f || typeof f !== 'object') return null;
  const url = String(f.url || '');
  const m = url.match(/^\/files\/(.+)$/);
  if (!m || !FILE_RE.test(m[1])) return null;
  return {
    url,
    name: String(f.name || 'dosya').slice(0, 120),
    size: Math.max(0, Number(f.size) || 0),
    image: IMAGE_EXT.has(path.extname(url).toLowerCase()),
  };
}
const cleanText = (t) => String(t || '').trim().slice(0, 2000);

function leaveVoice(socket) {
  const u = users.get(socket.id);
  if (!u || !u.voice) return;
  socket.to('v:' + u.voice).emit('peer-left', socket.id);
  socket.leave('v:' + u.voice);
  u.voice = null;
}

io.on('connection', (socket) => {
  socket.on('hello', ({ name } = {}) => {
    name = String(name || '').trim().slice(0, 24) || 'Anonim';
    users.set(socket.id, { id: socket.id, name, voice: null, muted: false, deafened: false });
    socket.emit('init', {
      you: socket.id,
      textChannels: TEXT_CHANNELS,
      voiceChannels: VOICE_CHANNELS,
      users: userList(),
      history,
    });
    broadcastUsers();
    console.log(`+ ${name} bağlandı (${users.size} çevrimiçi)`);
  });

  socket.on('join-voice', (channel) => {
    const u = users.get(socket.id);
    if (!u || !VOICE_CHANNELS.includes(channel)) return;
    if (u.voice) leaveVoice(socket);
    const peers = userList().filter((x) => x.voice === channel).map((x) => x.id);
    u.voice = channel;
    socket.join('v:' + channel);
    socket.emit('voice-peers', peers); // yeni gelen, mevcut herkese bağlantı teklif eder
    broadcastUsers();
  });

  socket.on('leave-voice', () => {
    leaveVoice(socket);
    broadcastUsers();
  });

  socket.on('signal', ({ to, data } = {}) => {
    const a = users.get(socket.id);
    const b = users.get(to);
    if (a && b && a.voice && a.voice === b.voice) io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', ({ channel, text, file } = {}) => {
    const u = users.get(socket.id);
    text = cleanText(text);
    file = cleanFile(file);
    if (!u || (!text && !file) || !TEXT_CHANNELS.includes(channel)) return;
    const msg = { id: ++msgCounter, channel, userId: u.id, name: u.name, text, file, ts: Date.now() };
    history[channel].push(msg);
    if (history[channel].length > HISTORY_LIMIT) history[channel].shift();
    io.emit('chat', msg);
  });

  // Özel mesaj: sunucuda saklanmaz, sadece iki kişiye iletilir
  socket.on('dm', ({ to, text, file } = {}) => {
    const a = users.get(socket.id);
    const b = users.get(to);
    text = cleanText(text);
    file = cleanFile(file);
    if (!a || !b || (!text && !file)) return;
    const msg = { id: ++msgCounter, from: a.id, fromName: a.name, to: b.id, toName: b.name, text, file, ts: Date.now() };
    io.to(b.id).emit('dm', msg);
    if (b.id !== a.id) socket.emit('dm', msg);
  });

  socket.on('state', ({ muted, deafened } = {}) => {
    const u = users.get(socket.id);
    if (!u) return;
    u.muted = !!muted;
    u.deafened = !!deafened;
    broadcastUsers();
  });

  socket.on('speaking', (speaking) => {
    if (users.has(socket.id)) socket.broadcast.emit('speaking', { id: socket.id, speaking: !!speaking });
  });

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    if (!u) return;
    leaveVoice(socket);
    users.delete(socket.id);
    broadcastUsers();
    console.log(`- ${u.name} ayrıldı (${users.size} çevrimiçi)`);
  });
});

server.listen(PORT, () => {
  console.log(`Muhabbet sunucusu çalışıyor: http://localhost:${PORT}`);
});
