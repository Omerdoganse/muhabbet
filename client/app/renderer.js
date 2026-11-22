'use strict';
// Muhabbet istemcisi
// - Yazılı sohbet, özel mesaj, dosya, anket, karar çarkı, geçici odalar, durumlar (Socket.IO/HTTP)
// - Sesli sohbet ve ekran paylaşımı (WebRTC, eşler arası)
// - Ortak YouTube izleme, Pomodoro, son 30 saniye ses klibi, oda önizlemesi

const $ = (s) => document.querySelector(s);
const desktop = window.muhabbet || null;

// Varsayılan sunucu adresi config.js'den gelir (GitHub'a yüklenmez)
const DEFAULT_SERVER = window.MUHABBET_CONFIG?.defaultServer || 'http://localhost:3000';
const MAX_FILE = 25 * 1024 * 1024;
const CLIP_SECONDS = 30;

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};
const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐨', '🐯', '🦁', '🐸', '🐵', '🐰', '🐻', '🐧', '🦄', '🐙', '🐹', '🐲'];
const AVATAR_BG = ['#ffd9e8', '#d4ebff', '#fff1b8', '#e6ddff', '#d3f5e3', '#ffe2c6'];
const BUBBLES = ['c-blue', 'c-yellow', 'c-pink', 'c-purple', 'c-green', 'c-orange'];
const NAME_COLORS = ['#3d8bfd', '#d49a00', '#e0457b', '#7c5cff', '#1f9e6b', '#e8772e'];
const WHEEL_COLORS = ['#d4ebff', '#fff1b8', '#ffd9e8', '#e6ddff', '#d3f5e3', '#ffe2c6'];
const EMOJIS = ['😀', '😂', '🤣', '😊', '😍', '😎', '🤔', '😴', '😭', '😡', '🥳', '🤯', '👍', '👎', '👏', '🙏',
  '🔥', '💯', '❤️', '💜', '🎮', '🕹️', '🏆', '⚔️', '🎯', '💀', '👀', '🚀', '⭐', '🎉', 'GG', '🍕'];

const S = {
  socket: null,
  serverUrl: '',
  me: null,
  myName: '',
  users: [],
  textChannels: [], // [{ id, name, temp }]
  voiceChannels: [],
  history: {},
  dms: JSON.parse(localStorage.getItem('dms') || '{}'), // karşı tarafın adı -> mesajlar
  lastRead: JSON.parse(localStorage.getItem('lastRead') || '{}'), // kanal -> zaman
  unread: {}, // görünüm anahtarı -> sayı
  view: { type: 'channel', id: 'genel' },
  myVoice: null,
  muted: false,
  deafened: false,
  stream: null,
  screenStream: null,
  peers: new Map(), // userId -> eş bağlantısı
  speaking: new Set(),
  volumes: JSON.parse(localStorage.getItem('volumes') || '{}'), // isim -> 0..1
  micId: localStorage.getItem('micId') || '',
  speakerId: localStorage.getItem('speakerId') || '',
  noise: localStorage.getItem('noise') !== '0',
  settingsOpen: false,
  stage: { mode: null, user: null }, // mode: 'screen' | 'yt'
  yt: null,
  ytOffset: 0,
  pomo: null,
  pomoOffset: 0,
  pomoMuted: false,
  spun: new Set(),
};

/* ---------------- Yardımcılar ---------------- */
function hash(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
const pick = (arr, name) => arr[hash(name) % arr.length];

function avatarEl(user, size) {
  const a = document.createElement('div');
  a.className = 'avatar';
  if (user.id) a.dataset.speak = user.id;
  a.style.background = pick(AVATAR_BG, user.name);
  if (size) Object.assign(a.style, { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.58) + 'px' });
  a.textContent = pick(AVATARS, user.name);
  a.title = user.name;
  if (user.id && S.speaking.has(user.id)) a.classList.add('speaking');
  return a;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function button(label, onClick, cls = 'chip', title) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
let actx;
function audioCtx() {
  actx ||= new AudioContext();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function beep(freq = 520, dur = 0.12) {
  try {
    const ctx = audioCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur);
  } catch {}
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error('Sunucuya ulaşılamadı. Adresi kontrol et.')); };
    document.head.appendChild(s);
  });
}
const userById = (id) => S.users.find((u) => u.id === id);
const userByName = (name) => S.users.find((u) => u.name === name && u.id !== S.me);
const fmtSize = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
const fmtTime = (sec) => {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const viewKey = (v) => (v.type === 'channel' ? 'c:' + v.id : 'd:' + v.name);
const absUrl = (u) => S.serverUrl + u;
const chName = (id) => S.textChannels.find((c) => c.id === id)?.name || S.voiceChannels.find((c) => c.id === id)?.name || id;
const saveLastRead = () => localStorage.setItem('lastRead', JSON.stringify(S.lastRead));
// Sohbeti olan her yer: yazı kanalları + ses odaları (geçici odalar ikisinde de var)
const chatChannel = (id) => {
  const t = S.textChannels.find((c) => c.id === id);
  if (t) return t;
  const v = S.voiceChannels.find((c) => c.id === id);
  return v ? { ...v, voice: true } : null;
};
const allChatIds = () => [...new Set([...S.textChannels, ...S.voiceChannels].map((c) => c.id))];

/* ---------------- Genel pencere ---------------- */
let dialogClose = null;
function openDialog(title, body, actions = []) {
  $('#dialog-title').textContent = title;
  $('#dialog-body').replaceChildren(...[].concat(body));
  const box = $('#dialog-actions');
  box.replaceChildren();
  for (const a of actions) box.appendChild(button(a.label, a.onClick, a.primary ? 'btn-primary' : 'btn-ghost'));
  $('#dialog').classList.remove('hidden');
  return new Promise((resolve) => {
    dialogClose = (v) => {
      $('#dialog').classList.add('hidden');
      dialogClose = null;
      resolve(v);
    };
  });
}
const closeDialog = (v = null) => dialogClose?.(v);
$('#dialog').addEventListener('mousedown', (e) => { if (e.target.id === 'dialog') closeDialog(); });

function field(label, input) {
  const l = el('label', null, label);
  l.appendChild(input);
  return l;
}
function inputEl(placeholder, value = '', max = 100) {
  const i = el('input');
  i.placeholder = placeholder;
  i.value = value;
  i.maxLength = max;
  i.autocomplete = 'off';
  return i;
}

/* ---------------- Giriş ---------------- */
$('#name').value = localStorage.getItem('name') || '';
$('#server').value =
  localStorage.getItem('server') || (location.protocol.startsWith('http') ? location.origin : DEFAULT_SERVER);

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#name').value.trim();
  const server = $('#server').value.trim();
  if (!name || !server) return;
  $('#login-btn').disabled = true;
  $('#login-error').textContent = '';
  try {
    await connect(name, server);
    localStorage.setItem('name', name);
    localStorage.setItem('server', server);
    desktop?.setServer?.(S.serverUrl);
    audioCtx();
  } catch (err) {
    $('#login-error').textContent = err.message;
  } finally {
    $('#login-btn').disabled = false;
  }
});

async function connect(name, url) {
  url = url.replace(/\/+$/, '');
  // "https://" yazılmamışsa ekle (yerel ağ adresleri için http)
  if (!/^https?:\/\//i.test(url)) {
    const local = /^(localhost|127\.|192\.168\.|10\.|\d+\.\d+\.\d+\.\d+)/.test(url);
    url = (local ? 'http://' : 'https://') + url;
  }
  if (!window.io) await loadScript(url + '/socket.io/socket.io.js');

  return new Promise((resolve, reject) => {
    const socket = io(url, { reconnectionDelayMax: 5000 });
    let first = true;
    const timer = setTimeout(() => {
      if (first) { socket.close(); reject(new Error('Sunucuya bağlanılamadı (zaman aşımı).')); }
    }, 60000); // uyuyan ücretsiz sunucunun uyanması için bekle

    socket.on('connect', () => {
      socket.emit('hello', { name });
      $('#conn-dot').classList.remove('off');
    });
    socket.on('init', (d) => {
      if (first) { first = false; clearTimeout(timer); resolve(); }
      onInit(d);
    });
    socket.on('disconnect', () => {
      $('#conn-dot').classList.add('off');
      dropAllPeers();
      if (!first) toast('Bağlantı koptu, yeniden bağlanılıyor…');
    });
    socket.on('users', onUsers);
    socket.on('channels', onChannels);
    socket.on('chat', onChat);
    socket.on('msg-update', onMsgUpdate);
    socket.on('dm', onDm);
    socket.on('voice-peers', (ids) => ids.forEach((id) => makePeer(id, true)));
    socket.on('signal', onSignal);
    socket.on('peer-left', closePeer);
    socket.on('speaking', ({ id, speaking }) => setSpeaking(id, speaking));
    socket.on('yt', onYt);
    socket.on('pomo', onPomo);
    S.socket = socket;
    S.serverUrl = url;
  });
}

function onInit(d) {
  S.me = d.you;
  S.textChannels = d.textChannels;
  S.voiceChannels = d.voiceChannels;
  S.users = d.users;
  S.history = d.history;
  if (S.view.type === 'channel' && !chatChannel(S.view.id)) S.view = { type: 'channel', id: 'genel' };
  $('#login').classList.add('hidden');
  $('#main').classList.remove('hidden');
  const me = userById(S.me);
  S.myName = me.name;
  // Geçmişteki kendi mesajlarımı sağa hizala (yeniden bağlanınca kimlik değişebilir, isme bak)
  for (const list of Object.values(S.history)) for (const m of list) m.mine = m.userId === S.me || m.name === me.name;
  $('#my-name').textContent = me.name;
  const av = avatarEl(me);
  $('#my-avatar').replaceWith(av);
  av.id = 'my-avatar';
  // Başka kanallarda kaçırılan mesaj sayıları
  for (const id of allChatIds()) {
    if (S.view.type === 'channel' && id === S.view.id) continue;
    const since = S.lastRead[id] || 0;
    const n = (S.history[id] || []).filter((m) => m.ts > since && !m.mine).length;
    if (n) S.unread['c:' + id] = n;
  }
  renderAll();
  // Yeniden bağlanınca bulunduğun ses kanalına geri dön
  if (S.myVoice) {
    const ch = S.myVoice;
    S.myVoice = null;
    joinVoice(ch);
  }
  sendState();
}

function onUsers(list) {
  // Ses kanalıma giren/çıkan için bildirim sesi
  if (S.myVoice) {
    const before = new Set(S.users.filter((u) => u.voice === S.myVoice && u.id !== S.me).map((u) => u.id));
    const after = new Set(list.filter((u) => u.voice === S.myVoice && u.id !== S.me).map((u) => u.id));
    if ([...after].some((id) => !before.has(id))) beep(740);
    else if ([...before].some((id) => !after.has(id))) beep(380);
  }
  S.users = list;
  // İzlediğim ekran paylaşımı bittiyse sahneyi kapat
  if (S.stage.mode === 'screen' && S.stage.user !== S.me && !userById(S.stage.user)?.sharing) closeStage();
  renderVoiceChannels();
  renderMembers();
  renderDmList();
  renderMyStatus();
  renderHeader();
  for (const p of S.peers.values()) applyPeerAudio(p);
}

function onChannels(d) {
  S.textChannels = d.textChannels;
  S.voiceChannels = d.voiceChannels;
  for (const id of Object.keys(S.history)) if (!chatChannel(id)) delete S.history[id];
  if (S.myVoice && !S.voiceChannels.some((c) => c.id === S.myVoice)) leaveVoice();
  if (S.view.type === 'channel' && !chatChannel(S.view.id)) openView({ type: 'channel', id: 'genel' });
  else renderTextChannels();
  renderVoiceChannels();
}

/* ---------------- Mesajlar ---------------- */
function currentList() {
  return S.view.type === 'channel' ? S.history[S.view.id] || [] : S.dms[S.view.name] || [];
}

function appendIfVisible(key, list, msg) {
  if (viewKey(S.view) !== key) return false;
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.querySelector('.empty')?.remove();
  box.appendChild(messageEl(msg, list[list.length - 2]));
  if (atBottom || msg.mine) box.scrollTop = box.scrollHeight;
  box.lastElementChild.querySelectorAll('img').forEach((img) => img.addEventListener('load', () => {
    if (atBottom || msg.mine) box.scrollTop = box.scrollHeight;
  }));
  if (S.view.type === 'channel') {
    S.lastRead[S.view.id] = msg.ts;
    saveLastRead();
  }
  return true;
}

function onChat(msg) {
  msg.mine = msg.userId === S.me;
  const list = (S.history[msg.channel] ||= []);
  list.push(msg);
  if (list.length > 100) list.shift();
  const key = 'c:' + msg.channel;
  if (!appendIfVisible(key, list, msg)) {
    S.unread[key] = (S.unread[key] || 0) + 1;
    renderTextChannels();
    renderVoiceChannels();
  }
  if (!msg.mine && !document.hasFocus()) beep(900, 0.08);
}

function onMsgUpdate(msg) {
  const list = S.history[msg.channel];
  const i = list ? list.findIndex((m) => m.id === msg.id) : -1;
  if (i < 0) return;
  msg.mine = list[i].mine;
  list[i] = msg;
  if (viewKey(S.view) === 'c:' + msg.channel) {
    const old = $('#messages').querySelector(`[data-msg="${msg.id}"]`);
    if (old) old.replaceWith(messageEl(msg, list[i - 1]));
  }
}

function onDm(msg) {
  msg.mine = msg.from === S.me;
  const other = msg.mine ? msg.toName : msg.fromName;
  const list = (S.dms[other] ||= []);
  list.push({ userId: msg.from, name: msg.fromName, text: msg.text, file: msg.file, ts: msg.ts, mine: msg.mine });
  if (list.length > 200) list.splice(0, list.length - 200);
  saveDms();
  const key = 'd:' + other;
  if (!appendIfVisible(key, list, list[list.length - 1])) {
    S.unread[key] = (S.unread[key] || 0) + 1;
    if (!msg.mine) toast(`💌 ${msg.fromName}: ${msg.text || '📎 dosya'}`);
  }
  renderDmList();
  if (!msg.mine) beep(1000, 0.1);
}

function saveDms() {
  try { localStorage.setItem('dms', JSON.stringify(S.dms)); } catch {}
}

function sendMessage(text, file, channel) {
  if (!S.socket) return;
  if (channel || S.view.type === 'channel') {
    S.socket.emit('chat', { channel: channel || S.view.id, text, file });
  } else {
    const u = userByName(S.view.name);
    if (!u) return toast(`${S.view.name} şu an çevrimdışı.`);
    S.socket.emit('dm', { to: u.id, text, file });
  }
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  sendMessage(text);
  input.value = '';
  $('#emoji-panel').classList.add('hidden');
});

function linkify(text, parent) {
  const re = /(https?:\/\/[^\s<]+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = el('a', null, m[0]);
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    parent.appendChild(a);
    last = m.index + m[0].length;
  }
  parent.appendChild(document.createTextNode(text.slice(last)));
}

function fileEl(file) {
  if (file.image) {
    const img = el('img', 'msg-img');
    img.src = absUrl(file.url);
    img.alt = file.name;
    img.loading = 'lazy';
    img.onclick = () => {
      $('#lightbox-img').src = img.src;
      $('#lightbox').classList.remove('hidden');
    };
    return img;
  }
  if (file.audio) {
    const wrap = el('div');
    const a = el('audio', 'msg-audio');
    a.controls = true;
    a.preload = 'none';
    a.src = absUrl(file.url);
    wrap.append(a, el('div', 'clip-label', '🎬 ' + file.name));
    return wrap;
  }
  const a = el('a', 'file-card');
  a.href = absUrl(file.url) + '?name=' + encodeURIComponent(file.name);
  a.download = file.name;
  const info = el('div');
  info.append(el('div', 'f-name', file.name), el('div', 'f-size', fmtSize(file.size)));
  a.append(el('span', 'f-ico', '📄'), info, el('span', 'f-dl', '⬇️'));
  return a;
}

function pollEl(msg) {
  const card = el('div', 'card');
  card.appendChild(el('div', 'card-title', '📊 ' + msg.poll.question));
  const total = msg.poll.options.reduce((s, o) => s + o.voters.length, 0);
  msg.poll.options.forEach((o, i) => {
    const row = el('div', 'poll-opt' + (o.voters.includes(S.myName) ? ' mine' : ''));
    const fill = el('div', 'fill');
    fill.style.width = (total ? (o.voters.length / total) * 100 : 0) + '%';
    row.append(fill, el('span', null, o.text), el('span', 'cnt', String(o.voters.length)));
    row.title = o.voters.join(', ') || 'Henüz oy yok';
    row.onclick = () => S.socket.emit('vote', { channel: msg.channel, msgId: msg.id, option: i });
    card.appendChild(row);
  });
  card.appendChild(el('div', 'poll-voters', total ? `${total} oy · değiştirmek için başka seçeneğe tıkla` : 'Oy vermek için tıkla'));
  return card;
}

function wheelSvg(options) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '-100 -100 200 200');
  const n = options.length;
  const seg = (Math.PI * 2) / n;
  options.forEach((opt, i) => {
    const a0 = i * seg - Math.PI / 2;
    const a1 = a0 + seg;
    const path = document.createElementNS(ns, 'path');
    const large = seg > Math.PI ? 1 : 0;
    path.setAttribute('d', `M0 0 L${98 * Math.cos(a0)} ${98 * Math.sin(a0)} A98 98 0 ${large} 1 ${98 * Math.cos(a1)} ${98 * Math.sin(a1)} Z`);
    path.setAttribute('fill', WHEEL_COLORS[i % WHEEL_COLORS.length]);
    path.setAttribute('stroke', '#fff');
    path.setAttribute('stroke-width', '2');
    svg.appendChild(path);
    const mid = a0 + seg / 2;
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', 60 * Math.cos(mid));
    t.setAttribute('y', 60 * Math.sin(mid));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('font-size', n > 8 ? '9' : '11');
    t.setAttribute('font-weight', '700');
    t.setAttribute('fill', '#3b3355');
    t.setAttribute('transform', `rotate(${(mid * 180) / Math.PI + 90} ${60 * Math.cos(mid)} ${60 * Math.sin(mid)})`);
    t.textContent = opt.length > 12 ? opt.slice(0, 11) + '…' : opt;
    svg.appendChild(t);
  });
  const c = document.createElementNS(ns, 'circle');
  c.setAttribute('r', '10');
  c.setAttribute('fill', '#7c5cff');
  svg.appendChild(c);
  return svg;
}

function wheelEl(msg) {
  const w = msg.wheel;
  const card = el('div', 'card');
  card.appendChild(el('div', 'card-title', '🎡 ' + (w.title || 'Karar çarkı')));
  const box = el('div', 'wheel-box');
  const svg = wheelSvg(w.options);
  box.append(el('div', 'wheel-pointer', '🔻'), svg);
  card.appendChild(box);
  const res = el('div', 'wheel-result');
  card.appendChild(res);
  const seg = 360 / w.options.length;
  const final = 360 * 6 - (w.result + 0.5) * seg;
  const showResult = () => {
    res.textContent = '🎉 ' + w.options[w.result];
    res.classList.add('show');
  };
  // Yeni çevrilen çark dönerek açılır, eskiler sonucu direkt gösterir
  if (!S.spun.has(msg.id) && Date.now() - msg.ts < 8000) {
    S.spun.add(msg.id);
    svg.style.transform = 'rotate(0deg)';
    requestAnimationFrame(() => requestAnimationFrame(() => (svg.style.transform = `rotate(${final}deg)`)));
    res.textContent = 'Dönüyor…';
    setTimeout(() => { showResult(); beep(880, 0.15); }, 4100);
  } else {
    S.spun.add(msg.id);
    svg.style.transition = 'none';
    svg.style.transform = `rotate(${final}deg)`;
    showResult();
  }
  return card;
}

const isOnlyEmoji = (t) => t.length <= 8 && /^(\p{Extended_Pictographic}|‍|️|\s)+$/u.test(t);

function messageEl(msg, prev) {
  const sender = msg.mine ? '__me' : msg.name;
  const prevSender = prev ? (prev.mine ? '__me' : prev.name) : null;
  const cont = prev && prevSender === sender && msg.ts - prev.ts < 5 * 60 * 1000 && !msg.poll && !msg.wheel;
  const row = el('div', 'msg' + (cont ? ' cont' : '') + (msg.mine ? ' mine' : ''));
  if (msg.id) row.dataset.msg = msg.id;
  row.appendChild(avatarEl({ id: msg.userId, name: msg.name }, 36));
  const body = el('div', 'msg-body');
  if (!cont) {
    const head = el('div', 'msg-head');
    const n = el('span', 'msg-name', msg.mine ? 'Sen' : msg.name);
    n.style.color = pick(NAME_COLORS, msg.name);
    head.append(n, el('span', 'msg-time', new Date(msg.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })));
    body.appendChild(head);
  }
  if (msg.text) {
    const b = el('div', 'bubble ' + pick(BUBBLES, msg.name) + (isOnlyEmoji(msg.text) ? ' only-emoji' : ''));
    linkify(msg.text, b);
    body.appendChild(b);
  }
  if (msg.file) body.appendChild(fileEl(msg.file));
  if (msg.poll) body.appendChild(pollEl(msg));
  if (msg.wheel) body.appendChild(wheelEl(msg));
  row.appendChild(body);
  return row;
}

// "Neler kaçırdım?" özeti
function missedEl(missed) {
  const box = el('div', 'missed');
  const counts = {};
  let images = 0, files = 0, polls = 0, wheels = 0;
  for (const m of missed) {
    counts[m.name] = (counts[m.name] || 0) + 1;
    if (m.file?.image) images++;
    else if (m.file) files++;
    if (m.poll) polls++;
    if (m.wheel) wheels++;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} (${c})`).join(', ');
  const parts = [`👋 Sen yokken <b>${missed.length}</b> mesaj yazıldı`];
  const extra = [];
  if (images) extra.push(`📷 ${images} fotoğraf`);
  if (files) extra.push(`📎 ${files} dosya`);
  if (polls) extra.push(`📊 ${polls} anket`);
  if (wheels) extra.push(`🎡 ${wheels} çark`);
  const lastPoll = [...missed].reverse().find((m) => m.poll);
  box.append(el('div', null, ''), el('div'), el('div'));
  box.children[0].innerHTML = parts[0];
  box.children[1].textContent = '✍️ En çok yazanlar: ' + top + (extra.length ? ' · ' + extra.join(' · ') : '');
  if (lastPoll) {
    const best = [...lastPoll.poll.options].sort((a, b) => b.voters.length - a.voters.length)[0];
    box.children[2].textContent = `🗳️ Son anket "${lastPoll.poll.question}": şu an önde → ${best.text} (${best.voters.length} oy)`;
  }
  return box;
}

function renderHeader() {
  const icon = $('#chat-icon');
  const input = $('#chat-input');
  $('#header-tools').classList.toggle('hidden', S.view.type !== 'channel');
  if (S.view.type === 'channel') {
    const ch = chatChannel(S.view.id);
    icon.className = 'chat-icon';
    icon.style.background = '';
    icon.textContent = ch?.temp ? '⏳' : ch?.voice ? '🔊' : '#';
    $('#chat-title').textContent = ch?.name || S.view.id;
    const inside = S.users.filter((u) => u.voice === S.view.id).length;
    $('#chat-sub').textContent = ch?.temp
      ? 'Geçici oda · son kişi çıkınca silinir'
      : ch?.voice
        ? `Ses odası sohbeti · ${inside ? inside + ' kişi içeride' : 'şu an kimse yok'}`
        : 'Herkese açık kanal';
    input.placeholder = `#${ch?.name || S.view.id} kanalına mesaj yaz…`;
    input.disabled = false;
  } else {
    const online = !!userByName(S.view.name);
    icon.className = 'chat-icon avatar';
    icon.style.background = pick(AVATAR_BG, S.view.name);
    icon.textContent = pick(AVATARS, S.view.name);
    $('#chat-title').textContent = S.view.name;
    $('#chat-sub').textContent = online ? '🟢 Çevrimiçi · özel sohbet' : '⚪ Çevrimdışı';
    input.placeholder = online ? `${S.view.name} kişisine özel mesaj…` : `${S.view.name} şu an çevrimdışı`;
    input.disabled = !online;
  }
}

function renderMessages() {
  const box = $('#messages');
  box.replaceChildren();
  const list = currentList();
  if (!list.length) {
    const e = el('div', 'empty');
    e.appendChild(el('span', 'big', S.view.type === 'channel' ? '💬' : '💌'));
    e.appendChild(document.createTextNode(
      S.view.type === 'channel'
        ? `#${chName(S.view.id)} kanalının başlangıcı. İlk mesajı sen yaz!`
        : `${S.view.name} ile özel sohbetin başlangıcı. Bu mesajları sadece ikiniz görebilir.`,
    ));
    box.appendChild(e);
  }
  // Kanalda kaçırılan mesajlar: özet + "yeni mesajlar" çizgisi
  let divider = null;
  const since = S.view.type === 'channel' ? S.lastRead[S.view.id] || 0 : Infinity;
  const missed = list.filter((m) => m.ts > since && !m.mine);
  list.forEach((m, i) => {
    if (!divider && missed.length && m === missed[0]) {
      if (missed.length >= 5) box.appendChild(missedEl(missed));
      divider = el('div', 'new-divider', 'YENİ MESAJLAR');
      box.appendChild(divider);
    }
    box.appendChild(messageEl(m, list[i - 1]));
  });
  const scroll = () => {
    if (divider && since) box.scrollTop = divider.offsetTop - 80;
    else box.scrollTop = box.scrollHeight;
  };
  scroll();
  box.querySelectorAll('img').forEach((img) => img.addEventListener('load', scroll, { once: true }));
  if (S.view.type === 'channel' && list.length) {
    S.lastRead[S.view.id] = list[list.length - 1].ts;
    saveLastRead();
  }
  renderHeader();
}

function openView(view) {
  S.view = view;
  delete S.unread[viewKey(view)];
  renderTextChannels();
  renderVoiceChannels();
  renderDmList();
  renderMessages();
  if (!$('#chat-input').disabled) $('#chat-input').focus();
}

/* ---------------- Dosya gönderme ---------------- */
async function uploadBlob(blob, name) {
  const r = await fetch(S.serverUrl + '/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(name),
      'X-Socket-Id': S.socket.id,
    },
    body: blob,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Yükleme hatası');
  return j;
}

async function uploadFiles(files) {
  for (const f of files) {
    if (f.size > MAX_FILE) { toast(`${f.name} çok büyük (en fazla 25 MB).`); continue; }
    if (S.view.type === 'dm' && !userByName(S.view.name)) { toast(`${S.view.name} şu an çevrimdışı.`); return; }
    toast(`📤 Yükleniyor: ${f.name || 'resim'}…`, 120000);
    try {
      sendMessage('', await uploadBlob(f, f.name || 'resim.png'));
      $('#toast').classList.add('hidden');
    } catch (err) {
      toast('Gönderilemedi: ' + err.message);
    }
  }
}

$('#attach-btn').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = '';
};
// Panodan yapıştır (Ctrl+V ile ekran görüntüsü gönder)
$('#chat-input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    uploadFiles(files);
  }
});
// Sürükle-bırak
let dragDepth = 0;
const chatEl = $('#chat');
chatEl.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  $('#drop-overlay').classList.remove('hidden');
});
chatEl.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.add('hidden'); }
});
chatEl.addEventListener('dragover', (e) => e.preventDefault());
chatEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.add('hidden');
  if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
});
$('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setFull(false);
    $('#lightbox').classList.add('hidden');
    $('#emoji-panel').classList.add('hidden');
    closeDialog();
  }
});

/* ---------------- Emoji ---------------- */
for (const em of EMOJIS) {
  const b = button(em, () => {
    const input = $('#chat-input');
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + em + input.value.slice(pos);
    input.focus();
    input.selectionStart = input.selectionEnd = pos + em.length;
  }, '');
  $('#emoji-panel').appendChild(b);
}
$('#emoji-btn').onclick = () => $('#emoji-panel').classList.toggle('hidden');

/* ---------------- Anket ve karar çarkı ---------------- */
$('#poll-btn').onclick = () => {
  const q = inputEl('Soru (örn. Bu akşam ne oynayalım?)', '', 200);
  const opts = el('textarea');
  opts.placeholder = 'Her satıra bir seçenek yaz\nValorant\nCS2\nMinecraft';
  openDialog('📊 Anket başlat', [field('SORU', q), field('SEÇENEKLER', opts)], [
    { label: 'Vazgeç', onClick: () => closeDialog() },
    {
      label: 'Başlat', primary: true, onClick: () => {
        const options = opts.value.split('\n').map((s) => s.trim()).filter(Boolean);
        if (!q.value.trim() || options.length < 2) return toast('Bir soru ve en az 2 seçenek yaz.');
        S.socket.emit('poll', { channel: S.view.id, question: q.value, options });
        closeDialog();
      },
    },
  ]);
  setTimeout(() => q.focus(), 50);
};

$('#wheel-btn').onclick = () => {
  const t = inputEl('Başlık (örn. Ne oynayalım?)', '', 100);
  const opts = el('textarea');
  opts.placeholder = 'Her satıra bir seçenek yaz (en az 2, en fazla 12)';
  const presets = el('div', 'chips');
  const sets = {
    '🎮 Oyunlar': 'Valorant\nCS2\nLoL\nMinecraft\nFortnite\nRocket League',
    '🍕 Yemek': 'Pizza\nHamburger\nDöner\nLahmacun\nSushi',
    '👥 Çevrimiçiler': () => S.users.map((u) => u.name).join('\n'),
    '🪙 Yazı-Tura': 'Yazı\nTura',
  };
  for (const [label, val] of Object.entries(sets)) {
    presets.appendChild(button(label, () => (opts.value = typeof val === 'function' ? val() : val)));
  }
  openDialog('🎡 Karar çarkı', [field('BAŞLIK', t), presets, field('SEÇENEKLER', opts)], [
    { label: 'Vazgeç', onClick: () => closeDialog() },
    {
      label: 'Çevir!', primary: true, onClick: () => {
        const options = opts.value.split('\n').map((s) => s.trim()).filter(Boolean);
        if (options.length < 2) return toast('En az 2 seçenek yaz.');
        S.socket.emit('wheel', { channel: S.view.id, title: t.value, options });
        closeDialog();
      },
    },
  ]);
};

/* ---------------- Geçici odalar ---------------- */
$('#new-room-btn').onclick = () => {
  const name = inputEl('Oda adı', '', 32);
  const chips = el('div', 'chips');
  for (const s of ['🎮 Bu akşamki maç', '🔫 Valorant 5\'li', '⛏️ Minecraft', '📚 Ders', '🎬 Film gecesi']) {
    chips.appendChild(button(s, () => (name.value = s)));
  }
  const create = () => {
    if (!name.value.trim()) return toast('Odaya bir ad ver.');
    S.socket.emit('create-room', { name: name.value }, (r) => {
      if (r?.error) return toast(r.error);
      closeDialog();
      setTimeout(() => {
        joinVoice(r.id);
        openView({ type: 'channel', id: r.id });
      }, 100);
    });
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && create());
  openDialog('⏳ Geçici oda aç', [
    field('ODA ADI', name), chips,
    el('p', 'hint', 'Sesli ve yazılı bir oda açılır. İçindeki son kişi çıkınca oda ve mesajları otomatik silinir.'),
  ], [{ label: 'Vazgeç', onClick: () => closeDialog() }, { label: 'Aç ve gir', primary: true, onClick: create }]);
  setTimeout(() => name.focus(), 50);
};

/* ---------------- Süreli durum ---------------- */
function renderMyStatus() {
  const me = userById(S.me);
  const box = $('#my-status');
  if (me?.status) {
    const left = Math.max(0, me.status.until - Date.now());
    box.textContent = `${me.status.emoji} ${me.status.text} · ${Math.ceil(left / 60000)} dk`;
  } else box.textContent = 'Çevrimiçi · durum ekle';
}
setInterval(renderMyStatus, 30000);

$('#my-info').onclick = () => {
  const me = userById(S.me);
  const emoji = inputEl('😀', me?.status?.emoji || '🎮', 8);
  emoji.style.width = '70px';
  emoji.style.flex = '0 0 70px';
  const text = inputEl('Ne yapıyorsun?', me?.status?.text || '', 60);
  const row = el('div', 'row');
  row.append(emoji, text);
  const presets = el('div', 'chips');
  for (const [e, t] of [['🎮', 'Oyun +1 lazım'], ['🔥', 'Rank kasıyorum'], ['📚', 'Ders çalışıyorum'], ['🍕', 'Yemekteyim'], ['😴', 'AFK'], ['🎧', 'Müzik dinliyorum']]) {
    presets.appendChild(button(`${e} ${t}`, () => { emoji.value = e; text.value = t; }));
  }
  let minutes = 120;
  const durs = el('div', 'chips');
  for (const [label, m] of [['30 dk', 30], ['1 saat', 60], ['2 saat', 120], ['4 saat', 240], ['Bugün', 720]]) {
    const b = button(label, () => {
      minutes = m;
      durs.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
    });
    if (m === minutes) b.classList.add('on');
    durs.appendChild(b);
  }
  openDialog('💬 Durumunu ayarla', [
    row, presets, field('NE KADAR SÜRSÜN?', durs),
    el('p', 'hint', 'Durumun herkesin listesinde görünür; süresi dolunca kendiliğinden kalkar. Arkadaşların durumuna tıklayıp yanına katılabilir.'),
  ], [
    { label: 'Temizle', onClick: () => { S.socket.emit('status', null); closeDialog(); } },
    {
      label: 'Kaydet', primary: true, onClick: () => {
        if (!text.value.trim()) return toast('Bir durum yaz.');
        S.socket.emit('status', { emoji: emoji.value, text: text.value, minutes });
        closeDialog();
      },
    },
  ]);
};

/* ---------------- Arayüz ---------------- */
function renderAll() {
  renderTextChannels();
  renderDmList();
  renderVoiceChannels();
  renderMembers();
  renderMessages();
  renderMyStatus();
  updateButtons();
}

function badge(key) {
  const n = S.unread[key];
  return n ? el('span', 'badge', n > 99 ? '99+' : String(n)) : null;
}

function renderTextChannels() {
  const box = $('#text-channels');
  box.replaceChildren();
  for (const ch of S.textChannels) {
    const active = S.view.type === 'channel' && S.view.id === ch.id;
    const d = el('div', 'channel' + (active ? ' active' : ''));
    d.append(el('span', 'ico', ch.temp ? '⏳' : '#'), el('span', null, ch.name));
    const b = badge('c:' + ch.id);
    if (b) d.appendChild(b);
    d.onclick = () => openView({ type: 'channel', id: ch.id });
    box.appendChild(d);
  }
}

function renderDmList() {
  const box = $('#dm-list');
  box.replaceChildren();
  const names = Object.keys(S.dms).sort((a, b) => (S.dms[b].at(-1)?.ts || 0) - (S.dms[a].at(-1)?.ts || 0));
  if (S.view.type === 'dm' && !names.includes(S.view.name)) names.unshift(S.view.name);
  if (!names.length) {
    box.appendChild(el('div', 'empty-small', 'Sağdan birine tıkla 👉'));
    return;
  }
  for (const name of names) {
    const active = S.view.type === 'dm' && S.view.name === name;
    const d = el('div', 'channel' + (active ? ' active' : ''));
    const u = userByName(name);
    d.append(avatarEl({ id: u?.id, name }), el('span', null, name));
    const b = badge('d:' + name);
    const dot = b || el('span', 'online-dot' + (u ? ' on' : ''));
    if (!b) dot.style.marginLeft = 'auto';
    d.appendChild(dot);
    d.onclick = () => openView({ type: 'dm', name });
    box.appendChild(d);
  }
}

function renderVoiceChannels() {
  const box = $('#voice-channels');
  box.replaceChildren();
  for (const ch of S.voiceChannels) {
    const viewing = S.view.type === 'channel' && S.view.id === ch.id;
    const d = el('div', 'channel' + (ch.id === S.myVoice || viewing ? ' active' : ''));
    d.append(el('span', 'ico', ch.temp ? '⏳' : '🔊'), el('span', null, ch.name));
    if (ch.temp) d.appendChild(el('span', 'temp-tag', 'geçici'));
    const b = ch.temp ? null : badge('c:' + ch.id); // geçici odanın sayacı yazı kanallarında görünüyor
    if (b) d.appendChild(b);
    d.title = 'Katıl ve sohbetini aç';
    // Ses odasına tıklayınca hem odaya girilir hem de o odanın sohbeti açılır
    d.onclick = () => {
      joinVoice(ch.id);
      openView({ type: 'channel', id: ch.id });
    };
    d.onmouseenter = () => showPeek(ch, d);
    d.onmouseleave = hidePeek;
    box.appendChild(d);

    const wrap = el('div', 'voice-users');
    for (const u of S.users.filter((x) => x.voice === ch.id)) {
      const row = el('div', 'voice-user');
      row.append(avatarEl(u), el('span', null, u.name));
      const flags = (u.muted ? '🔇' : '') + (u.deafened ? '🙉' : '');
      if (u.sharing) {
        const s = button('🖥️', (e) => { e.stopPropagation(); watchScreen(u.id); }, 'icon-btn', `${u.name} ekranını izle`);
        s.style.marginLeft = 'auto';
        s.style.width = s.style.height = '26px';
        row.appendChild(s);
      }
      if (flags) row.appendChild(el('span', 'flags', flags));
      // Aynı kanaldaki diğer kişiler için ses seviyesi kaydırıcısı
      if (u.id !== S.me && ch.id === S.myVoice) {
        const vol = el('div', 'vol');
        const r = el('input');
        r.type = 'range';
        r.min = 0;
        r.max = 100;
        r.value = Math.round((S.volumes[u.name] ?? 1) * 100);
        r.title = `${u.name} ses seviyesi`;
        r.oninput = () => {
          S.volumes[u.name] = r.value / 100;
          localStorage.setItem('volumes', JSON.stringify(S.volumes));
          const p = S.peers.get(u.id);
          if (p) applyPeerAudio(p);
        };
        vol.appendChild(r);
        row.appendChild(vol);
      }
      wrap.appendChild(row);
    }
    box.appendChild(wrap);
  }
  $('#voice-status').classList.toggle('hidden', !S.myVoice);
  $('#vs-channel').textContent = S.myVoice ? chName(S.myVoice) : '';
  $('#share-btn').classList.toggle('on', !!S.screenStream);
  $('#yt-btn').classList.toggle('on', !!S.yt?.current);
  $('#pomo-btn').classList.toggle('on', !!S.pomo);
}

function renderMembers() {
  const box = $('#member-list');
  box.replaceChildren();
  $('#online-count').textContent = S.users.length;
  for (const u of S.users) {
    const isMe = u.id === S.me;
    const row = el('div', 'member' + (isMe ? ' me' : ''));
    const info = el('div');
    info.style.minWidth = '0';
    info.appendChild(el('div', 'm-name', u.name + (isMe ? ' (sen)' : '')));
    info.appendChild(el('div', 'sub2', u.voice ? '🔊 ' + chName(u.voice) + (u.sharing ? ' · 🖥️ yayında' : '') : isMe ? 'Çevrimiçi' : '💌 Mesaj gönder'));
    if (u.status) {
      const pill = el('div', 'status-pill', `${u.status.emoji} ${u.status.text}`);
      pill.title = isMe ? 'Senin durumun' : u.voice ? 'Tıkla: odasına katıl' : 'Tıkla: mesaj gönder';
      pill.onclick = (e) => {
        e.stopPropagation();
        if (isMe) return $('#my-info').click();
        if (u.voice) joinVoice(u.voice);
        else openView({ type: 'dm', name: u.name });
      };
      info.appendChild(pill);
    }
    row.append(avatarEl(u), info);
    if (!isMe) row.onclick = () => openView({ type: 'dm', name: u.name });
    box.appendChild(row);
  }
}

function setSpeaking(id, on) {
  on ? S.speaking.add(id) : S.speaking.delete(id);
  document.querySelectorAll(`[data-speak="${CSS.escape(id)}"]`).forEach((a) => a.classList.toggle('speaking', on));
}

/* ---------------- Oda önizlemesi ---------------- */
let peekTimer;
function showPeek(ch, anchor) {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    const members = S.users.filter((u) => u.voice === ch.id);
    const box = $('#peek');
    box.replaceChildren();
    box.appendChild(el('h4', null, (ch.temp ? '⏳ ' : '🔊 ') + ch.name));
    if (!members.length) {
      box.appendChild(el('div', 'p-sub', 'Şu an kimse yok. Tıkla ve ilk sen gir!'));
    } else {
      const talking = members.filter((u) => S.speaking.has(u.id)).length;
      const mood = talking === 0 ? '🤫 Sessiz' : talking === 1 ? '🙂 Sakin' : talking <= 3 ? '😄 Hareketli' : '🎉 Çok gürültülü';
      box.appendChild(el('div', 'p-sub', `${members.length} kişi · ${mood}`));
      const noise = el('div', 'noise');
      const bar = el('div');
      bar.style.width = Math.min(100, (talking / members.length) * 100) + '%';
      noise.appendChild(bar);
      box.appendChild(noise);
      for (const u of members) {
        const r = el('div', 'p-user');
        r.append(avatarEl(u), el('span', null, u.name + (u.sharing ? ' 🖥️' : '') + (u.muted ? ' 🔇' : '')));
        box.appendChild(r);
      }
      if (members.some((u) => u.sharing)) {
        S.socket.emit('peek', ch.id, (frames) => {
          for (const f of frames || []) {
            box.appendChild(el('div', 'p-sub', `🖥️ ${f.name} ekran paylaşıyor:`));
            const img = el('img');
            img.src = f.frame;
            box.appendChild(img);
          }
        });
      }
    }
    const r = anchor.getBoundingClientRect();
    box.style.left = r.right + 12 + 'px';
    box.style.top = Math.min(r.top, window.innerHeight - 320) + 'px';
    box.classList.remove('hidden');
  }, 300);
}
function hidePeek() {
  clearTimeout(peekTimer);
  $('#peek').classList.add('hidden');
}

/* ---------------- Mikrofon ---------------- */
function micConstraints() {
  return {
    deviceId: S.micId ? { ideal: S.micId } : undefined,
    echoCancellation: S.noise,
    noiseSuppression: S.noise,
    autoGainControl: S.noise,
  };
}

// Bazı cihazlar (ör. Bluetooth ile bağlı telefon) açılırken takılabiliyor: zaman aşımı koy
function getMic(audio, ms = 6000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { done = true; reject(Object.assign(new Error('Mikrofon cevap vermedi'), { name: 'TimeoutError' })); }, ms);
    navigator.mediaDevices.getUserMedia({ audio }).then(
      (s) => { clearTimeout(t); if (done) s.getTracks().forEach((x) => x.stop()); else resolve(s); },
      (e) => { clearTimeout(t); if (!done) reject(e); },
    );
  });
}

function micErrorText(err) {
  switch (err.name) {
    case 'NotAllowedError': return 'Mikrofon izni yok. Windows Ayarlar > Gizlilik > Mikrofon kısmından masaüstü uygulamalarına izin ver.';
    case 'NotFoundError': return 'Hiç mikrofon bulunamadı.';
    case 'NotReadableError': return 'Mikrofon başka bir uygulama tarafından kullanılıyor olabilir.';
    case 'TimeoutError': return 'Mikrofon cevap vermedi. Ayarlar (⚙️) kısmından başka bir mikrofon seç.';
    default: return err.message;
  }
}

async function ensureMic() {
  if (S.stream) return S.stream;
  try {
    S.stream = await getMic(micConstraints());
  } catch (err) {
    if (err.name === 'NotAllowedError') throw err;
    // Seçili/varsayılan mikrofon çalışmadı: diğer mikrofonları sırayla dene
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'audioinput' && !['default', 'communications', S.micId].includes(d.deviceId),
    );
    for (const d of devices) {
      try {
        S.stream = await getMic({ ...micConstraints(), deviceId: { exact: d.deviceId } }, 4000);
        S.micId = d.deviceId;
        localStorage.setItem('micId', S.micId);
        toast('Mikrofon olarak "' + (d.label || 'diğer cihaz') + '" kullanılıyor.');
        break;
      } catch {}
    }
    if (!S.stream) throw err;
  }
  startAnalyser();
  applyMute();
  return S.stream;
}

function releaseMic() {
  if (!S.stream) return;
  S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  stopAnalyser();
}

async function restartMic() {
  if (!S.stream) return;
  const old = S.stream;
  try {
    S.stream = await getMic(micConstraints());
  } catch (err) {
    S.stream = old;
    throw err;
  }
  const track = S.stream.getAudioTracks()[0];
  for (const p of S.peers.values()) {
    if (p.micSender) await p.micSender.replaceTrack(track);
  }
  old.getTracks().forEach((t) => t.stop());
  applyMute();
  startAnalyser();
}

let meterTimer, srcNode;
function startAnalyser() {
  stopAnalyser();
  const ctx = audioCtx();
  srcNode = ctx.createMediaStreamSource(S.stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  srcNode.connect(analyser);
  if (clip.mix) srcNode.connect(clip.mix);
  const buf = new Float32Array(analyser.fftSize);
  let speaking = false;
  let lastLoud = 0;
  meterTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    $('#mic-meter').style.width = Math.min(100, rms * 800) + '%';
    const now = performance.now();
    const live = S.myVoice && !S.muted && !S.deafened;
    if (live && rms > 0.015) lastLoud = now;
    const sp = !!live && now - lastLoud < 300;
    if (sp !== speaking) {
      speaking = sp;
      S.socket?.emit('speaking', sp);
      setSpeaking(S.me, sp);
    }
  }, 60);
}
function stopAnalyser() {
  clearInterval(meterTimer);
  srcNode?.disconnect();
  srcNode = null;
  if (S.me && S.speaking.has(S.me)) {
    S.socket?.emit('speaking', false);
    setSpeaking(S.me, false);
  }
}

/* ---------------- Sesli sohbet (WebRTC) ---------------- */
async function joinVoice(ch) {
  if (S.myVoice === ch || !S.socket?.connected) return;
  try {
    await ensureMic();
  } catch (err) {
    toast('Mikrofona erişilemedi: ' + micErrorText(err), 6000);
    return;
  }
  if (S.myVoice) leaveVoice(true);
  S.myVoice = ch;
  S.socket.emit('join-voice', ch);
  startClip();
  applyMute();
  beep(660);
  renderVoiceChannels();
}

function leaveVoice(switching) {
  if (!S.myVoice) return;
  stopShare();
  closeStage();
  dropAllPeers();
  S.socket?.emit('leave-voice');
  S.myVoice = null;
  S.yt = null;
  onPomo({ channel: null, state: null });
  stopClip();
  if (!switching) {
    if (!S.settingsOpen) releaseMic();
    beep(330);
  }
  renderVoiceChannels();
}
$('#leave-btn').onclick = () => leaveVoice();

// "Kibar" eş çakışmada geri adım atar (perfect negotiation): bağlantı kurulduktan sonra
// ekran paylaşımı eklenip çıkarılabilsin diye her iki taraf da yeniden teklif gönderebilir
function makePeer(id, initiator) {
  closePeer(id);
  const pc = new RTCPeerConnection(ICE);
  const p = {
    id, pc, audio: null, screenAudio: null, micStream: null, screen: null, micSender: null, screenSenders: [],
    polite: S.me > id, makingOffer: false, ignoreOffer: false, tracksAdded: false, queue: Promise.resolve(), clipSrc: null,
  };
  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      S.socket.emit('signal', { to: id, data: { description: pc.localDescription } });
    } catch (err) {
      console.warn('negotiation', err);
    } finally {
      p.makingOffer = false;
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) S.socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => onTrack(p, e);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      const u = userById(id);
      toast(`${u ? u.name : 'Bir kullanıcı'} ile bağlantı kurulamadı (ağ/NAT engeli).`);
    }
  };
  S.peers.set(id, p);
  if (initiator) addLocalTracks(p);
  return p;
}

function addLocalTracks(p) {
  if (p.tracksAdded || !S.stream) return;
  p.tracksAdded = true;
  const t = S.stream.getAudioTracks()[0];
  if (t) p.micSender = p.pc.addTrack(t, S.stream);
  if (S.screenStream) p.screenSenders = S.screenStream.getTracks().map((tr) => p.pc.addTrack(tr, S.screenStream));
}

function onTrack(p, e) {
  const stream = e.streams[0];
  if (!stream) return;
  const isScreen = e.track.kind === 'video' || (p.micStream && p.micStream.id !== stream.id) || (p.screen && p.screen.id === stream.id);
  if (isScreen) {
    p.screen = stream;
    if (!p.screenAudio) {
      p.screenAudio = new Audio();
      p.screenAudio.autoplay = true;
      document.body.appendChild(p.screenAudio);
    }
    p.screenAudio.srcObject = stream;
    stream.onremovetrack = () => {
      if (!stream.getVideoTracks().length) p.screen = null;
    };
    applyPeerAudio(p);
    if (S.stage.mode === 'screen' && S.stage.user === p.id) watchScreen(p.id);
    return;
  }
  p.micStream = stream;
  if (!p.audio) {
    p.audio = new Audio();
    p.audio.autoplay = true;
    document.body.appendChild(p.audio);
  }
  p.audio.srcObject = stream;
  applyPeerAudio(p);
  p.audio.play().catch(() => {});
  clipAddPeer(p);
}

function onSignal({ from, data }) {
  if (!S.myVoice || !S.stream) return;
  let p = S.peers.get(from);
  if (!p) {
    if (data.description?.type !== 'offer') return;
    p = makePeer(from, false);
  }
  // Sinyalleri sırayla işle (ICE adayları açıklamadan önce işlenmesin)
  p.queue = p.queue
    .then(async () => {
      const pc = p.pc;
      if (data.description) {
        const d = data.description;
        const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          addLocalTracks(p); // gelen teklifin ses kanalını yeniden kullanır, fazladan pazarlık gerekmez
          await pc.setLocalDescription();
          S.socket.emit('signal', { to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!p.ignoreOffer) throw err;
        }
      }
    })
    .catch((err) => console.warn('signal', err));
}

function closePeer(id) {
  const p = S.peers.get(id);
  if (!p) return;
  p.pc.close();
  p.audio?.remove();
  p.screenAudio?.remove();
  p.clipSrc?.disconnect();
  S.peers.delete(id);
  setSpeaking(id, false);
}
function dropAllPeers() {
  [...S.peers.keys()].forEach(closePeer);
}

function applyPeerAudio(p) {
  const u = userById(p.id);
  const vol = u ? S.volumes[u.name] ?? 1 : 1;
  for (const a of [p.audio, p.screenAudio]) {
    if (!a) continue;
    a.volume = vol;
    if (S.speakerId && a.setSinkId && a.sinkId !== S.speakerId) a.setSinkId(S.speakerId).catch(() => {});
  }
  if (p.audio) p.audio.muted = S.deafened;
  // Ekran sesi sadece o ekranı izlerken duyulur
  if (p.screenAudio) p.screenAudio.muted = S.deafened || !(S.stage.mode === 'screen' && S.stage.user === p.id);
}

/* ---------------- Ekran paylaşımı ---------------- */
desktop?.onPickSource?.((list) => pickSource(list));

let pickerShown = false;
function pickSource(list) {
  pickerShown = true;
  let chosen = list.find((s) => s.id.startsWith('screen')) || list[0];
  const grid = el('div', 'src-grid');
  for (const s of list) {
    const card = el('div', 'src' + (s === chosen ? ' on' : ''));
    const img = el('img');
    img.src = s.thumb;
    card.append(img, el('div', null, s.name));
    card.onclick = () => {
      chosen = s;
      grid.querySelectorAll('.src').forEach((c) => c.classList.toggle('on', c === card));
    };
    card.ondblclick = () => closeDialog({ id: s.id, audio: audio.checked });
    grid.appendChild(card);
  }
  const audio = el('input');
  audio.type = 'checkbox';
  const lab = el('label', 'check');
  lab.append(audio, document.createTextNode(' Bilgisayar sesini de paylaş (oyun/müzik)'));
  return openDialog('🖥️ Neyi paylaşmak istersin?', [
    grid, lab,
    el('p', 'hint', 'İpucu: Ses paylaşırken kulaklık kullan, yoksa arkadaşların kendi seslerini geri duyabilir.'),
  ], [
    { label: 'Vazgeç', onClick: () => closeDialog(null) },
    { label: 'Paylaş', primary: true, onClick: () => closeDialog(chosen ? { id: chosen.id, audio: audio.checked } : null) },
  ]);
}

let peekFrameTimer;
async function startShare() {
  if (!S.myVoice) return toast('Önce bir ses odasına gir.');
  if (desktop && !desktop.onPickSource) {
    return toast('Ekran paylaşımı için uygulamanın yeni sürümü gerekiyor (yeni Muhabbet.exe).', 6000);
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
  } catch (err) {
    // Seçiciden vazgeçmek sessiz geçer; seçici hiç açılmadıysa nedenini söyle
    if (err.name === 'NotAllowedError' && !pickerShown) {
      toast('Ekran paylaşma izni verilmedi. Arkadaşından yeni Muhabbet.exe\'yi almasını iste (veya sen yeniden indir).', 7000);
    } else if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast('Ekran paylaşılamadı: ' + err.message);
    return;
  } finally {
    pickerShown = false;
  }
  if (!S.myVoice) return stream.getTracks().forEach((t) => t.stop());
  S.screenStream = stream;
  const v = stream.getVideoTracks()[0];
  if (v) {
    v.contentHint = 'motion';
    v.onended = stopShare;
  }
  for (const p of S.peers.values()) {
    if (p.tracksAdded) p.screenSenders = stream.getTracks().map((t) => p.pc.addTrack(t, stream));
  }
  S.socket.emit('sharing', true);
  // Önizleme için birkaç saniyede bir küçük görüntü gönder
  const vid = el('video');
  vid.muted = true;
  vid.srcObject = stream;
  vid.play().catch(() => {});
  const canvas = el('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const sendFrame = () => {
    if (!vid.videoWidth) return;
    canvas.getContext('2d').drawImage(vid, 0, 0, 320, 180);
    S.socket?.emit('peek-frame', canvas.toDataURL('image/jpeg', 0.6));
  };
  setTimeout(sendFrame, 1000);
  peekFrameTimer = setInterval(sendFrame, 4000);
  watchScreen(S.me);
  renderVoiceChannels();
}

function stopShare() {
  if (!S.screenStream) return;
  clearInterval(peekFrameTimer);
  S.screenStream.getTracks().forEach((t) => t.stop());
  S.screenStream = null;
  for (const p of S.peers.values()) {
    for (const s of p.screenSenders) {
      try { p.pc.removeTrack(s); } catch {}
    }
    p.screenSenders = [];
  }
  S.socket?.emit('sharing', false);
  if (S.stage.mode === 'screen' && S.stage.user === S.me) closeStage();
  renderVoiceChannels();
}
$('#share-btn').onclick = () => (S.screenStream ? stopShare() : startShare());

function watchScreen(userId) {
  const isMe = userId === S.me;
  const stream = isMe ? S.screenStream : S.peers.get(userId)?.screen;
  const u = userById(userId);
  if (!isMe && userById(userId)?.voice !== S.myVoice) return toast('İzlemek için önce o odaya gir.');
  openStage('screen', userId);
  $('#stage-title').textContent = isMe ? '🖥️ Ekranını paylaşıyorsun' : `🖥️ ${u?.name || ''} ekranı`;
  const v = $('#stage-video');
  v.classList.remove('hidden');
  if (stream) {
    v.srcObject = stream;
    v.play().catch(() => {});
  } else {
    v.srcObject = null;
    $('#stage-title').textContent += ' (bağlanıyor…)';
  }
  const actions = $('#stage-actions');
  actions.replaceChildren();
  if (isMe) actions.appendChild(button('⏹️ Durdur', stopShare, 'btn-ghost'));
  for (const p of S.peers.values()) applyPeerAudio(p);
}

/* ---------------- Sahne ---------------- */
function openStage(mode, user) {
  if (S.stage.mode === 'yt' && mode !== 'yt') destroyYtPlayer();
  S.stage = { mode, user };
  $('#stage').classList.remove('hidden');
  $('#stage-pip').classList.toggle('hidden', mode !== 'screen' || !document.pictureInPictureEnabled);
  $('#stage-video').classList.toggle('hidden', mode !== 'screen');
  $('#yt-wrap').classList.toggle('hidden', mode !== 'yt');
  $('#yt-panel').classList.toggle('hidden', mode !== 'yt');
}
function closeStage() {
  if (S.stage.mode === 'yt') destroyYtPlayer();
  setFull(false);
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  $('#stage').classList.remove('pip');
  S.stage = { mode: null, user: null };
  $('#stage').classList.add('hidden');
  const v = $('#stage-video');
  v.srcObject = null;
  for (const p of S.peers.values()) applyPeerAudio(p);
}
$('#stage-close').onclick = closeStage;
// Tam ekran: sahne önce uygulama penceresini tamamen kaplar, izin varsa ekranı da kaplar
// (eski masaüstü sürümleri tam ekran iznini reddettiği için pencereyi kaplama yedek olarak çalışır)
function setFull(on) {
  const st = $('#stage');
  if (st.classList.contains('full') === on) return;
  st.classList.toggle('full', on);
  $('#stage-full').textContent = on ? '🗗' : '⛶';
  $('#stage-full').title = on ? 'Tam ekrandan çık (Esc)' : 'Tam ekran';
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
$('#stage-full').onclick = () => setFull(!$('#stage').classList.contains('full'));

// Küçük köşe penceresi / büyük görünüm
let stageSize = localStorage.getItem('stageSize') || 'mini';
function applyStageSize() {
  const st = $('#stage');
  st.classList.toggle('mini', stageSize === 'mini');
  st.style.left = st.style.top = st.style.right = '';
  $('#stage-size').textContent = stageSize === 'mini' ? '⤢' : '⤡';
  $('#stage-size').title = stageSize === 'mini' ? 'Büyüt (mesajların üstüne)' : 'Küçült (köşeye al)';
}
$('#stage-size').onclick = () => {
  stageSize = stageSize === 'mini' ? 'large' : 'mini';
  localStorage.setItem('stageSize', stageSize);
  applyStageSize();
};
applyStageSize();

// Köşe penceresini başlığından tutup sürükle
$('#stage-head').addEventListener('mousedown', (e) => {
  const st = $('#stage');
  if (!st.classList.contains('mini') || st.classList.contains('full') || e.target.closest('button, input')) return;
  e.preventDefault();
  const chat = $('#chat').getBoundingClientRect();
  const r = st.getBoundingClientRect();
  const dx = e.clientX - r.left;
  const dy = e.clientY - r.top;
  const move = (ev) => {
    const x = Math.min(Math.max(ev.clientX - dx - chat.left, 8), chat.width - r.width - 8);
    const y = Math.min(Math.max(ev.clientY - dy - chat.top, 8), chat.height - r.height - 8);
    st.style.right = 'auto';
    st.style.left = x + 'px';
    st.style.top = y + 'px';
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

// Ayrı pencere (resim içinde resim): oyunun da üstünde duran bağımsız küçük pencere
$('#stage-pip').onclick = async () => {
  const v = $('#stage-video');
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await v.requestPictureInPicture();
  } catch (err) {
    toast('Ayrı pencere açılamadı: ' + err.message);
  }
};
$('#stage-video').addEventListener('enterpictureinpicture', () => {
  setFull(false);
  $('#stage').classList.add('pip');
  toast('⧉ Ayrı pencerede izleniyor. Kapatınca buraya geri gelir.');
});
$('#stage-video').addEventListener('leavepictureinpicture', () => $('#stage').classList.remove('pip'));
$('#stage-body').ondblclick = () => setFull(!$('#stage').classList.contains('full'));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) setFull(false);
});

/* ---------------- Ortak izleme (YouTube) ---------------- */
let ytApi = null;
let ytPlayer = null;
let ytReady = false;
let ytApplying = 0;
function loadYtApi() {
  ytApi ||= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = resolve;
    const s = el('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApi = null; reject(new Error('YouTube yüklenemedi')); };
    document.head.appendChild(s);
  });
  return ytApi;
}
const ytServerNow = () => Date.now() + S.ytOffset;
const ytTarget = () => (S.yt.paused ? S.yt.pos : (ytServerNow() - S.yt.startedAt) / 1000);

function onYt({ channel, state }) {
  if (channel !== S.myVoice) return;
  const prev = S.yt?.current?.vid;
  S.yt = state;
  if (state) S.ytOffset = state.now - Date.now();
  // Yeni video başladığında sahneyi kendiliğinden aç
  if (state?.current && state.current.vid !== prev) {
    if (S.stage.mode !== 'yt' && S.stage.mode !== 'screen') openYt();
    toast(`📺 Şimdi oynuyor: ${state.current.title} (${state.current.by} ekledi)`);
  }
  if (S.stage.mode === 'yt') renderYt();
  renderVoiceChannels();
}

function openYt() {
  if (!S.myVoice) return toast('Birlikte izlemek için önce bir ses odasına gir.');
  openStage('yt');
  renderYt();
}
$('#yt-btn').onclick = () => (S.stage.mode === 'yt' ? closeStage() : openYt());

function destroyYtPlayer() {
  try { ytPlayer?.destroy(); } catch {}
  ytPlayer = null;
  ytReady = false;
  $('#yt-wrap').replaceChildren(el('div'));
  $('#yt-wrap').firstChild.id = 'yt-player';
}

function renderYt() {
  const s = S.yt;
  $('#stage-title').textContent = s?.current ? `📺 ${s.current.title}` : '📺 Birlikte izle — sıraya video ekle';
  const actions = $('#stage-actions');
  actions.replaceChildren();
  if (s?.current) {
    actions.append(
      button('⏪', () => S.socket.emit('yt-control', { action: 'seek', t: Math.max(0, ytTarget() - 10) }), 'tool-btn', '10 sn geri'),
      button(s.paused ? '▶️' : '⏸️', () => S.socket.emit('yt-control', { action: s.paused ? 'play' : 'pause' }), 'tool-btn', 'Oynat / duraklat'),
      button('⏩', () => S.socket.emit('yt-control', { action: 'seek', t: ytTarget() + 10 }), 'tool-btn', '10 sn ileri'),
      button('⏭️', () => S.socket.emit('yt-control', { action: 'skip', vid: s.current.vid }), 'tool-btn', 'Sıradakine geç'),
      button('⏹️', () => S.socket.emit('yt-control', { action: 'stop' }), 'tool-btn', 'Hepsini durdur'),
    );
    const vol = el('input');
    vol.type = 'range';
    vol.min = 0;
    vol.max = 100;
    vol.value = localStorage.getItem('ytVol') || 60;
    vol.style.width = '80px';
    vol.title = 'Ses (sadece sende)';
    vol.oninput = () => {
      localStorage.setItem('ytVol', vol.value);
      ytPlayer?.setVolume?.(Number(vol.value));
    };
    actions.appendChild(vol);
  }
  const q = $('#yt-queue');
  q.replaceChildren();
  if (s?.queue?.length) {
    s.queue.forEach((it, i) => {
      const row = el('div', 'yt-item');
      row.append(el('span', null, `${i + 1}. ${it.title} — ${it.by}`), button('✖', () => S.socket.emit('yt-control', { action: 'remove', index: i }), '', 'Sıradan çıkar'));
      q.appendChild(row);
    });
  } else q.appendChild(el('div', null, s?.current ? 'Sırada başka video yok.' : 'Link yapıştır; herkes aynı anda izler. Müzik için de kullanabilirsin 🎵'));
  syncYt();
}

async function syncYt() {
  const s = S.yt;
  if (S.stage.mode !== 'yt') return;
  if (!s?.current) {
    if (ytPlayer) destroyYtPlayer();
    return;
  }
  try {
    await loadYtApi();
  } catch {
    return toast('YouTube oynatıcısı yüklenemedi.');
  }
  if (S.stage.mode !== 'yt' || !S.yt?.current) return;
  if (!ytPlayer) {
    ytPlayer = new YT.Player('yt-player', {
      videoId: s.current.vid,
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, playsinline: 1, start: Math.floor(ytTarget()) },
      events: {
        onReady: () => {
          ytReady = true;
          ytPlayer.setVolume(Number(localStorage.getItem('ytVol') || 60));
          syncYt();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED && S.yt?.current) S.socket.emit('yt-ended', { vid: S.yt.current.vid });
        },
        onError: () => {
          toast('Bu video gömülü oynatılamıyor, sıradakine geçiliyor.');
          if (S.yt?.current) S.socket.emit('yt-control', { action: 'skip', vid: S.yt.current.vid });
        },
      },
    });
    return;
  }
  if (!ytReady) return;
  const target = ytTarget();
  const vid = ytPlayer.getVideoData?.().video_id;
  ytApplying = Date.now();
  if (vid !== s.current.vid) {
    ytPlayer.loadVideoById(s.current.vid, target);
    if (s.paused) setTimeout(() => ytPlayer?.pauseVideo(), 500);
    return;
  }
  const cur = ytPlayer.getCurrentTime();
  if (Math.abs(cur - target) > 2) ytPlayer.seekTo(target, true);
  const st = ytPlayer.getPlayerState();
  if (s.paused && st === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
  if (!s.paused && st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING) ytPlayer.playVideo();
}
setInterval(() => S.stage.mode === 'yt' && syncYt(), 3000);

// İlerleme çubuğu: sürükleyince herkesin videosu aynı yere gider
let ytDragging = false;
function updateYtSeek() {
  const bar = $('#yt-seek');
  const dur = ytReady ? ytPlayer?.getDuration?.() || 0 : 0;
  bar.classList.toggle('hidden', !(S.stage.mode === 'yt' && S.yt?.current && dur > 0));
  if (!dur || ytDragging || !S.yt?.current) return;
  const cur = Math.min(dur, ytTarget());
  const r = $('#yt-range');
  r.max = Math.floor(dur);
  r.value = Math.floor(cur);
  $('#yt-cur').textContent = fmtTime(cur);
  $('#yt-dur').textContent = fmtTime(dur);
}
setInterval(updateYtSeek, 500);
$('#yt-range').addEventListener('input', (e) => {
  ytDragging = true;
  $('#yt-cur').textContent = fmtTime(Number(e.target.value));
});
$('#yt-range').addEventListener('change', (e) => {
  S.socket?.emit('yt-control', { action: 'seek', t: Number(e.target.value) });
  setTimeout(() => (ytDragging = false), 600);
});

$('#yt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#yt-url').value.trim();
  if (!url) return;
  S.socket.emit('yt-add', { url }, (r) => {
    if (r?.error) return toast(r.error);
    $('#yt-url').value = '';
  });
});

/* ---------------- Pomodoro ---------------- */
function onPomo({ channel, state }) {
  if (channel && channel !== S.myVoice) return;
  const prev = S.pomo?.phase;
  S.pomo = state;
  if (state) S.pomoOffset = state.now - Date.now();
  const phase = state?.phase;
  if (phase === 'work' && prev !== 'work') {
    if (!S.muted) {
      S.muted = true;
      S.pomoMuted = true;
      applyMute();
    }
    beep(500, 0.3);
    toast(`🍅 Çalışma zamanı! (${state.work} dk) Mikrofonlar kapatıldı.`, 5000);
  } else if (phase !== 'work' && prev === 'work' && S.pomoMuted) {
    S.muted = false;
    S.pomoMuted = false;
    applyMute();
    if (phase === 'break') {
      beep(800, 0.3);
      toast(`☕ Mola! (${state.brk} dk) Mikrofonlar açıldı, sohbet edebilirsiniz.`, 5000);
    }
  }
  renderPomo();
  renderVoiceChannels();
}

function renderPomo() {
  const bar = $('#pomo-bar');
  const s = S.pomo;
  if (!s) return bar.classList.add('hidden');
  bar.classList.remove('hidden');
  bar.className = 'pomo-bar ' + s.phase;
  const left = (s.endsAt - (Date.now() + S.pomoOffset)) / 1000;
  bar.replaceChildren(
    el('span', null, `${s.phase === 'work' ? '🍅 Çalışma' : '☕ Mola'} ${fmtTime(left)} · Tur ${s.round}`),
    button('⏹ Bitir', () => S.socket.emit('pomo-stop'), ''),
  );
}
setInterval(() => S.pomo && renderPomo(), 1000);

$('#pomo-btn').onclick = () => {
  if (!S.myVoice) return toast('Önce bir ses odasına gir.');
  if (S.pomo) {
    return openDialog('🍅 Pomodoro', [el('p', 'hint', 'Odada bir sayaç çalışıyor. Bitirmek ister misin?')], [
      { label: 'Devam', onClick: () => closeDialog() },
      { label: 'Bitir', primary: true, onClick: () => { S.socket.emit('pomo-stop'); closeDialog(); } },
    ]);
  }
  let work = 25, brk = 5;
  const chips = el('div', 'chips');
  for (const [w, b] of [[25, 5], [50, 10], [15, 3], [90, 15]]) {
    const c = button(`${w} dk çalış · ${b} dk mola`, () => {
      work = w;
      brk = b;
      chips.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    });
    if (w === 25) c.classList.add('on');
    chips.appendChild(c);
  }
  openDialog('🍅 Ortak çalışma (Pomodoro)', [
    chips,
    el('p', 'hint', 'Odadaki herkes için aynı sayaç başlar. Çalışma süresinde herkesin mikrofonu otomatik kapanır, molada açılır.'),
  ], [
    { label: 'Vazgeç', onClick: () => closeDialog() },
    { label: 'Başlat', primary: true, onClick: () => { S.socket.emit('pomo-start', { work, brk }); closeDialog(); } },
  ]);
};

/* ---------------- Son 30 saniye klip ---------------- */
// Odadaki tüm sesleri (sen + arkadaşların) sürekli son 30 saniyelik bir halkada tutar
const clip = { node: null, mix: null, sink: null, buf: null, pos: 0, filled: false, rate: 48000 };
function startClip() {
  if (clip.node) return;
  try {
    const ctx = audioCtx();
    clip.rate = ctx.sampleRate;
    clip.buf = new Float32Array(Math.round(clip.rate * CLIP_SECONDS));
    clip.pos = 0;
    clip.filled = false;
    clip.mix = ctx.createGain();
    clip.node = ctx.createScriptProcessor(4096, 1, 1);
    clip.sink = ctx.createGain();
    clip.sink.gain.value = 0;
    clip.node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        clip.buf[clip.pos++] = input[i];
        if (clip.pos >= clip.buf.length) { clip.pos = 0; clip.filled = true; }
      }
    };
    clip.mix.connect(clip.node);
    clip.node.connect(clip.sink).connect(ctx.destination);
    if (srcNode) srcNode.connect(clip.mix);
    for (const p of S.peers.values()) clipAddPeer(p);
  } catch (err) {
    console.warn('clip', err);
  }
}
function stopClip() {
  try {
    clip.node?.disconnect();
    clip.mix?.disconnect();
    clip.sink?.disconnect();
  } catch {}
  clip.node = clip.mix = clip.sink = null;
}
function clipAddPeer(p) {
  if (!clip.mix || !p.micStream || p.clipSrc) return;
  try {
    p.clipSrc = audioCtx().createMediaStreamSource(p.micStream);
    p.clipSrc.connect(clip.mix);
  } catch {}
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function takeClip() {
  if (!S.myVoice || !clip.buf) return toast('Klip almak için bir ses odasında olmalısın.');
  // Halkayı doğru sıraya diz
  const ordered = new Float32Array(clip.filled ? clip.buf.length : clip.pos);
  if (clip.filled) {
    ordered.set(clip.buf.subarray(clip.pos));
    ordered.set(clip.buf.subarray(0, clip.pos), clip.buf.length - clip.pos);
  } else ordered.set(clip.buf.subarray(0, clip.pos));
  if (ordered.length < clip.rate) return toast('Klip için henüz yeterli ses yok.');
  // 16 kHz'e indir (dosya küçük olsun)
  const outRate = 16000;
  const ratio = clip.rate / outRate;
  const out = new Float32Array(Math.floor(ordered.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = ordered[Math.floor(i * ratio)];
  const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }).replace(':', '.');
  const name = `klip ${chName(S.myVoice)} ${time}.wav`;
  const target = S.view.type === 'channel' ? S.view.id : 'klipler';
  toast('🎬 Klip hazırlanıyor…', 20000);
  try {
    const f = await uploadBlob(encodeWav(out, outRate), name);
    sendMessage(`🎬 ${S.myName} son ${Math.round(out.length / outRate)} saniyeyi klipledi!`, f, target);
    toast(`🎬 Klip #${chName(target)} kanalına gönderildi.`);
    beep(1200, 0.1);
  } catch (err) {
    toast('Klip gönderilemedi: ' + err.message);
  }
}
$('#clip-btn').onclick = takeClip;

/* ---------------- Sustur / Sağırlaştır ---------------- */
function applyMute() {
  S.stream?.getAudioTracks().forEach((t) => (t.enabled = !S.muted && !S.deafened));
  for (const p of S.peers.values()) applyPeerAudio(p);
  updateButtons();
  sendState();
}
function sendState() {
  S.socket?.emit('state', { muted: S.muted, deafened: S.deafened });
}
function updateButtons() {
  $('#mute-btn').classList.toggle('off', S.muted || S.deafened);
  $('#deafen-btn').classList.toggle('off', S.deafened);
}
function toggleMute() {
  if (S.deafened) {
    S.deafened = false;
    S.muted = false;
  } else S.muted = !S.muted;
  S.pomoMuted = false;
  beep(S.muted ? 300 : 600, 0.08);
  applyMute();
}
function toggleDeafen() {
  S.deafened = !S.deafened;
  beep(S.deafened ? 250 : 650, 0.08);
  applyMute();
}
$('#mute-btn').onclick = toggleMute;
$('#deafen-btn').onclick = toggleDeafen;
desktop?.onHotkey((name) => {
  if (name === 'toggle-mute') toggleMute();
  else if (name === 'toggle-deafen') toggleDeafen();
  else if (name === 'clip') takeClip();
});

/* ---------------- Ayarlar ---------------- */
async function fillDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, current) => {
    sel.replaceChildren();
    const def = el('option', null, 'Varsayılan');
    def.value = '';
    sel.appendChild(def);
    devices
      .filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => {
        const o = el('option', null, d.label || `${kind} ${i + 1}`);
        o.value = d.deviceId;
        sel.appendChild(o);
      });
    sel.value = current;
    if (sel.value !== current) sel.value = '';
  };
  fill($('#mic-select'), 'audioinput', S.micId);
  fill($('#speaker-select'), 'audiooutput', S.speakerId);
}

$('#settings-btn').onclick = async () => {
  S.settingsOpen = true;
  $('#settings').classList.remove('hidden');
  $('#noise-check').checked = S.noise;
  try {
    await ensureMic(); // cihaz adlarını görmek ve seviye göstergesi için
  } catch (err) {
    toast('Mikrofona erişilemedi: ' + micErrorText(err), 6000);
  }
  fillDevices();
};
$('#settings-close').onclick = () => {
  S.settingsOpen = false;
  $('#settings').classList.add('hidden');
  if (!S.myVoice) releaseMic();
};
$('#mic-select').onchange = (e) => {
  S.micId = e.target.value;
  localStorage.setItem('micId', S.micId);
  restartMic().catch((err) => toast('Mikrofon değiştirilemedi: ' + micErrorText(err)));
};
$('#speaker-select').onchange = (e) => {
  S.speakerId = e.target.value;
  localStorage.setItem('speakerId', S.speakerId);
  for (const p of S.peers.values()) applyPeerAudio(p);
};
$('#noise-check').onchange = (e) => {
  S.noise = e.target.checked;
  localStorage.setItem('noise', S.noise ? '1' : '0');
  restartMic().catch(() => {});
};
$('#logout-btn').onclick = () => {
  leaveVoice();
  S.settingsOpen = false;
  releaseMic();
  S.socket?.close();
  S.socket = null;
  $('#settings').classList.add('hidden');
  $('#main').classList.add('hidden');
  $('#login').classList.remove('hidden');
};
