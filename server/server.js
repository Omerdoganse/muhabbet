// Muhabbet sinyal + sohbet sunucusu
// - Yazılı sohbet, özel mesaj, anket ve karar çarkı
// - Geçici odalar (son kişi çıkınca silinir), süreli durum kartları
// - Ses odalarında ortak YouTube izleme ve Pomodoro sayacı
// - Fotoğraf/dosya/klip yüklemelerini saklar (en fazla 25 MB, 3 gün sonra silinir)
// - Sesli kanallar ve ekran paylaşımı için WebRTC sinyallerini iletir
//   (ses ve görüntü sunucudan GEÇMEZ; kullanıcılar arasında doğrudan akar)
// - client/app klasörünü sunar: masaüstü uygulaması arayüzü buradan yükler

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const FIXED_TEXT = ['genel', 'oyun', 'klipler'];
const FIXED_VOICE = ['Genel Ses', 'Oyun Odası 1', 'Oyun Odası 2', 'AFK'];
const HISTORY_LIMIT = 100;
const MAX_FILE = 25 * 1024 * 1024;
const TOO_BIG = "Dosya 25 MB'dan büyük olamaz";
const FILE_TTL = 3 * 24 * 60 * 60 * 1000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a']);
const INLINE_EXT = new Set([...IMAGE_EXT, ...AUDIO_EXT]);
const FILE_RE = /^[a-f0-9]{24}(\.[a-z0-9]{1,8})?$/;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 2e5 });

const users = new Map(); // socketId -> kullanıcı
const tempRooms = new Map(); // id -> { id, name, created, everJoined }
// Yazı kanallarının ve her ses odasının kendi sohbet geçmişi
const history = Object.fromEntries([...FIXED_TEXT, ...FIXED_VOICE].map((c) => [c, []]));
const yt = {}; // ses odası -> ortak izleme durumu
const pomo = {}; // ses odası -> pomodoro durumu
let msgCounter = 0;

const now = () => Date.now();
const publicUser = (u) => ({
  id: u.id, name: u.name, voice: u.voice, muted: u.muted, deafened: u.deafened, sharing: u.sharing, status: u.status,
});
const userList = () => [...users.values()].map(publicUser);
const broadcastUsers = () => io.emit('users', userList());
const isText = (id) => FIXED_TEXT.includes(id) || FIXED_VOICE.includes(id) || tempRooms.has(id);
const isVoice = (id) => FIXED_VOICE.includes(id) || tempRooms.has(id);
const voiceMembers = (ch) => [...users.values()].filter((u) => u.voice === ch);
function channelList() {
  const temps = [...tempRooms.values()].map((r) => ({ id: r.id, name: r.name, temp: true }));
  return {
    textChannels: [...FIXED_TEXT.map((c) => ({ id: c, name: c })), ...temps],
    voiceChannels: [...FIXED_VOICE.map((c) => ({ id: c, name: c })), ...temps],
  };
}
const broadcastChannels = () => io.emit('channels', channelList());

/* ---------------- HTTP ---------------- */
app.use(express.static(path.join(__dirname, '..', 'client', 'app')));
app.get('/health', (_req, res) => res.json({ ok: true }));

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
    req.resume();
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
    res.json({ url: '/files/' + file, name, size, image: IMAGE_EXT.has(ext), audio: AUDIO_EXT.has(ext) });
  });
  req.pipe(out);
});

// Resim ve sesler sayfada oynatılır, diğer her şey "indir" olarak gelir (güvenlik)
app.get('/files/:file', (req, res) => {
  const f = req.params.file;
  if (!FILE_RE.test(f)) return res.sendStatus(404);
  const p = path.join(UPLOAD_DIR, f);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const onErr = (err) => { if (err && !res.headersSent) res.sendStatus(404); };
  if (INLINE_EXT.has(path.extname(f).toLowerCase())) return res.sendFile(p, onErr);
  res.download(p, String(req.query.name || f).slice(0, 120), onErr);
});

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: 'Sunucu hatası' });
});

/* ---------------- Yardımcılar ---------------- */
function cleanFile(f) {
  if (!f || typeof f !== 'object') return null;
  const url = String(f.url || '');
  const m = url.match(/^\/files\/(.+)$/);
  if (!m || !FILE_RE.test(m[1])) return null;
  const ext = path.extname(url).toLowerCase();
  return {
    url,
    name: String(f.name || 'dosya').slice(0, 120),
    size: Math.max(0, Number(f.size) || 0),
    image: IMAGE_EXT.has(ext),
    audio: AUDIO_EXT.has(ext),
  };
}
const cleanText = (t, max = 2000) => String(t || '').trim().slice(0, max);

function pushMessage(channel, msg) {
  const list = (history[channel] ||= []);
  list.push(msg);
  if (list.length > HISTORY_LIMIT) list.shift();
  io.emit('chat', msg);
}
function newMessage(u, channel, extra) {
  return { id: ++msgCounter, channel, userId: u.id, name: u.name, text: '', file: null, ts: now(), ...extra };
}

/* ---------------- Geçici odalar ---------------- */
function deleteTempRoom(id) {
  if (!tempRooms.has(id)) return;
  tempRooms.delete(id);
  delete history[id];
  stopRoomExtras(id);
  broadcastChannels();
}
function checkTempRoom(id) {
  const r = tempRooms.get(id);
  if (!r || voiceMembers(id).length) return;
  // Hiç kimse girmediyse kurulduktan sonra 2 dakika bekle
  if (r.everJoined || now() - r.created > 2 * 60 * 1000) deleteTempRoom(id);
}

/* ---------------- Ortak izleme (YouTube) ---------------- */
function ytPublic(ch) {
  const s = yt[ch];
  if (!s) return null;
  return { current: s.current, queue: s.queue, paused: s.paused, pos: s.pos, startedAt: s.startedAt, now: now() };
}
const ytBroadcast = (ch) => io.to('v:' + ch).emit('yt', { channel: ch, state: ytPublic(ch) });
function ytPosition(s) {
  return s.paused ? s.pos : (now() - s.startedAt) / 1000;
}
function ytNext(ch) {
  const s = yt[ch];
  if (!s) return;
  s.current = s.queue.shift() || null;
  s.pos = 0;
  s.paused = false;
  s.startedAt = now();
  if (!s.current && !s.queue.length) delete yt[ch];
  ytBroadcast(ch);
}
function parseYouTube(url) {
  url = String(url || '').trim();
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/) || url.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}
async function ytTitle(vid) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${vid}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) return String((await r.json()).title || '').slice(0, 150);
  } catch {}
  return 'YouTube videosu';
}

/* ---------------- Pomodoro ---------------- */
function pomoPublic(ch) {
  const s = pomo[ch];
  return s ? { phase: s.phase, endsAt: s.endsAt, work: s.work, brk: s.brk, round: s.round, now: now() } : null;
}
const pomoBroadcast = (ch) => io.to('v:' + ch).emit('pomo', { channel: ch, state: pomoPublic(ch) });
function pomoSchedule(ch) {
  const s = pomo[ch];
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    if (!pomo[ch]) return;
    if (s.phase === 'work') {
      s.phase = 'break';
      s.endsAt = now() + s.brk * 60000;
    } else {
      s.phase = 'work';
      s.round++;
      s.endsAt = now() + s.work * 60000;
    }
    pomoSchedule(ch);
    pomoBroadcast(ch);
  }, Math.max(0, s.endsAt - now()));
}
function stopPomo(ch) {
  if (!pomo[ch]) return;
  clearTimeout(pomo[ch].timer);
  delete pomo[ch];
  pomoBroadcast(ch);
}
function stopRoomExtras(ch) {
  stopPomo(ch);
  if (yt[ch]) {
    delete yt[ch];
    ytBroadcast(ch);
  }
}

/* ---------------- Ses odasından çıkma ---------------- */
function leaveVoice(socket) {
  const u = users.get(socket.id);
  if (!u || !u.voice) return;
  const ch = u.voice;
  socket.to('v:' + ch).emit('peer-left', socket.id);
  socket.leave('v:' + ch);
  u.voice = null;
  u.sharing = false;
  u.frame = null;
  if (!voiceMembers(ch).length) {
    stopRoomExtras(ch);
    checkTempRoom(ch);
  }
}

// Süresi dolan durumları ve boş geçici odaları temizle
setInterval(() => {
  let changed = false;
  for (const u of users.values()) {
    if (u.status && u.status.until <= now()) {
      u.status = null;
      changed = true;
    }
  }
  if (changed) broadcastUsers();
  for (const id of tempRooms.keys()) checkTempRoom(id);
}, 20 * 1000);

// Eski dosyaları temizle
setInterval(() => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return;
    for (const f of files) {
      const p = path.join(UPLOAD_DIR, f);
      fs.stat(p, (e, st) => { if (!e && now() - st.mtimeMs > FILE_TTL) fs.unlink(p, () => {}); });
    }
  });
}, 60 * 60 * 1000);

/* ---------------- Socket.IO ---------------- */
io.on('connection', (socket) => {
  const me = () => users.get(socket.id);

  socket.on('hello', ({ name } = {}) => {
    name = String(name || '').trim().slice(0, 24) || 'Anonim';
    users.set(socket.id, {
      id: socket.id, name, voice: null, muted: false, deafened: false, sharing: false, status: null, frame: null,
    });
    socket.emit('init', { you: socket.id, ...channelList(), users: userList(), history, now: now() });
    broadcastUsers();
    console.log(`+ ${name} bağlandı (${users.size} çevrimiçi)`);
  });

  socket.on('join-voice', (channel) => {
    const u = me();
    if (!u || !isVoice(channel)) return;
    if (u.voice) leaveVoice(socket);
    const peers = voiceMembers(channel).map((x) => x.id);
    u.voice = channel;
    socket.join('v:' + channel);
    const room = tempRooms.get(channel);
    if (room) room.everJoined = true;
    socket.emit('voice-peers', peers); // yeni gelen, mevcut herkese bağlantı teklif eder
    socket.emit('yt', { channel, state: ytPublic(channel) });
    socket.emit('pomo', { channel, state: pomoPublic(channel) });
    broadcastUsers();
  });

  socket.on('leave-voice', () => {
    leaveVoice(socket);
    broadcastUsers();
  });

  socket.on('signal', ({ to, data } = {}) => {
    const a = me();
    const b = users.get(to);
    if (a && b && a.voice && a.voice === b.voice) io.to(to).emit('signal', { from: socket.id, data });
  });

  /* --- Yazılı sohbet --- */
  socket.on('chat', ({ channel, text, file } = {}) => {
    const u = me();
    text = cleanText(text);
    file = cleanFile(file);
    if (!u || (!text && !file) || !isText(channel)) return;
    pushMessage(channel, newMessage(u, channel, { text, file }));
  });

  // Özel mesaj: sunucuda saklanmaz, sadece iki kişiye iletilir
  socket.on('dm', ({ to, text, file } = {}) => {
    const a = me();
    const b = users.get(to);
    text = cleanText(text);
    file = cleanFile(file);
    if (!a || !b || (!text && !file)) return;
    const msg = { id: ++msgCounter, from: a.id, fromName: a.name, to: b.id, toName: b.name, text, file, ts: now() };
    io.to(b.id).emit('dm', msg);
    if (b.id !== a.id) socket.emit('dm', msg);
  });

  /* --- Anket ve karar çarkı --- */
  socket.on('poll', ({ channel, question, options } = {}) => {
    const u = me();
    question = cleanText(question, 200);
    options = (Array.isArray(options) ? options : []).map((o) => cleanText(o, 80)).filter(Boolean).slice(0, 10);
    if (!u || !isText(channel) || !question || options.length < 2) return;
    pushMessage(channel, newMessage(u, channel, { poll: { question, options: options.map((text) => ({ text, voters: [] })) } }));
  });

  socket.on('vote', ({ channel, msgId, option } = {}) => {
    const u = me();
    const msg = u && (history[channel] || []).find((m) => m.id === msgId && m.poll);
    if (!msg || !Number.isInteger(option) || !msg.poll.options[option]) return;
    const already = msg.poll.options[option].voters.includes(u.name);
    for (const o of msg.poll.options) o.voters = o.voters.filter((n) => n !== u.name);
    if (!already) msg.poll.options[option].voters.push(u.name);
    io.emit('msg-update', msg);
  });

  socket.on('wheel', ({ channel, title, options } = {}) => {
    const u = me();
    options = (Array.isArray(options) ? options : []).map((o) => cleanText(o, 40)).filter(Boolean).slice(0, 12);
    if (!u || !isText(channel) || options.length < 2) return;
    const result = crypto.randomInt(options.length);
    pushMessage(channel, newMessage(u, channel, { wheel: { title: cleanText(title, 100), options, result } }));
  });

  /* --- Geçici odalar --- */
  socket.on('create-room', ({ name } = {}, ack) => {
    const u = me();
    name = cleanText(name, 32);
    if (!u || !name || tempRooms.size >= 20) return typeof ack === 'function' && ack({ error: 'Oda açılamadı' });
    const id = 't-' + crypto.randomBytes(4).toString('hex');
    tempRooms.set(id, { id, name, created: now(), everJoined: false });
    history[id] = [];
    broadcastChannels();
    if (typeof ack === 'function') ack({ id });
  });

  /* --- Süreli durum --- */
  socket.on('status', (s) => {
    const u = me();
    if (!u) return;
    if (!s) u.status = null;
    else {
      const text = cleanText(s.text, 60);
      const minutes = Math.min(24 * 60, Math.max(5, Number(s.minutes) || 60));
      const emoji = cleanText(s.emoji, 8) || '💬';
      u.status = text ? { text, emoji, until: now() + minutes * 60000 } : null;
    }
    broadcastUsers();
  });

  /* --- Ses durumu, ekran paylaşımı, önizleme --- */
  socket.on('state', ({ muted, deafened } = {}) => {
    const u = me();
    if (!u) return;
    u.muted = !!muted;
    u.deafened = !!deafened;
    broadcastUsers();
  });

  socket.on('speaking', (speaking) => {
    if (users.has(socket.id)) socket.broadcast.emit('speaking', { id: socket.id, speaking: !!speaking });
  });

  socket.on('sharing', (on) => {
    const u = me();
    if (!u || !u.voice) return;
    u.sharing = !!on;
    if (!on) u.frame = null;
    broadcastUsers();
  });

  socket.on('peek-frame', (frame) => {
    const u = me();
    if (u && u.sharing && typeof frame === 'string' && frame.startsWith('data:image/jpeg;base64,') && frame.length < 150000) {
      u.frame = frame;
    }
  });

  socket.on('peek', (channel, ack) => {
    if (typeof ack !== 'function' || !isVoice(channel)) return;
    ack(voiceMembers(channel).filter((u) => u.sharing && u.frame).map((u) => ({ id: u.id, name: u.name, frame: u.frame })));
  });

  /* --- Ortak izleme --- */
  socket.on('yt-add', async ({ url } = {}, ack) => {
    const u = me();
    const ch = u?.voice;
    const vid = parseYouTube(url);
    const reply = (r) => typeof ack === 'function' && ack(r);
    if (!ch) return reply({ error: 'Önce bir ses odasına gir' });
    if (!vid) return reply({ error: 'Geçerli bir YouTube linki değil' });
    const item = { vid, title: await ytTitle(vid), by: u.name };
    if (u.voice !== ch) return reply({ error: 'Odadan çıktın' });
    const s = (yt[ch] ||= { current: null, queue: [], paused: false, pos: 0, startedAt: now() });
    if (s.queue.length >= 50) return reply({ error: 'Sıra dolu' });
    if (!s.current) {
      s.current = item;
      s.pos = 0;
      s.paused = false;
      s.startedAt = now();
    } else s.queue.push(item);
    ytBroadcast(ch);
    reply({ ok: true, title: item.title });
  });

  socket.on('yt-control', ({ action, t, index, vid } = {}) => {
    const ch = me()?.voice;
    const s = ch && yt[ch];
    if (!s) return;
    if (action === 'pause' && !s.paused) {
      s.pos = ytPosition(s);
      s.paused = true;
    } else if (action === 'play' && s.paused) {
      s.startedAt = now() - s.pos * 1000;
      s.paused = false;
    } else if (action === 'seek' && Number.isFinite(t) && t >= 0) {
      if (s.paused) s.pos = t;
      else s.startedAt = now() - t * 1000;
    } else if (action === 'skip') {
      // Aynı anda birden çok kişi "geç" derse sadece bir video atlansın
      if (vid && s.current?.vid !== vid) return;
      return ytNext(ch);
    } else if (action === 'remove' && Number.isInteger(index) && s.queue[index]) {
      s.queue.splice(index, 1);
    } else if (action === 'stop') {
      delete yt[ch];
    } else return;
    ytBroadcast(ch);
  });

  socket.on('yt-ended', ({ vid } = {}) => {
    const ch = me()?.voice;
    const s = ch && yt[ch];
    // Birden fazla kişi "bitti" der; sadece ilki geçerli olsun
    if (s && s.current && s.current.vid === vid && ytPosition(s) > 3) ytNext(ch);
  });

  /* --- Pomodoro --- */
  socket.on('pomo-start', ({ work, brk } = {}) => {
    const ch = me()?.voice;
    if (!ch) return;
    work = Math.min(120, Math.max(1, Math.round(Number(work) || 25)));
    brk = Math.min(60, Math.max(1, Math.round(Number(brk) || 5)));
    if (pomo[ch]) clearTimeout(pomo[ch].timer);
    pomo[ch] = { phase: 'work', endsAt: now() + work * 60000, work, brk, round: 1, timer: null };
    pomoSchedule(ch);
    pomoBroadcast(ch);
  });

  socket.on('pomo-stop', () => {
    const ch = me()?.voice;
    if (ch) stopPomo(ch);
  });

  socket.on('disconnect', () => {
    const u = me();
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
