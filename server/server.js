// Muhabbet sinyal + sohbet sunucusu
// - Yazılı sohbet mesajlarını dağıtır (bellekte son 100 mesaj saklanır)
// - Sesli kanallar için WebRTC sinyallerini (offer/answer/ICE) iletir
// - Ses verisi sunucudan GEÇMEZ; kullanıcılar arasında doğrudan (P2P) akar
// - Ayrıca client/app klasörünü sunar: arkadaşlar tarayıcıdan da katılabilir

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const TEXT_CHANNELS = ['genel', 'oyun', 'klipler'];
const VOICE_CHANNELS = ['Genel Ses', 'Oyun Odası 1', 'Oyun Odası 2', 'AFK'];
const HISTORY_LIMIT = 100;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client', 'app')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e5 });

const users = new Map(); // socketId -> { id, name, voice, muted, deafened }
const history = Object.fromEntries(TEXT_CHANNELS.map((c) => [c, []]));
let msgCounter = 0;

const userList = () => [...users.values()];
const broadcastUsers = () => io.emit('users', userList());

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

  socket.on('chat', ({ channel, text } = {}) => {
    const u = users.get(socket.id);
    text = String(text || '').trim().slice(0, 2000);
    if (!u || !text || !TEXT_CHANNELS.includes(channel)) return;
    const msg = { id: ++msgCounter, channel, userId: u.id, name: u.name, text, ts: Date.now() };
    history[channel].push(msg);
    if (history[channel].length > HISTORY_LIMIT) history[channel].shift();
    io.emit('chat', msg);
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
