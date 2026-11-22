'use strict';
// Muhabbet istemcisi: yazılı sohbet (Socket.IO) + sesli sohbet (WebRTC, eşler arası)

const $ = (s) => document.querySelector(s);
const desktop = window.muhabbet || null;

// Varsayılan sunucu adresi config.js'den gelir (GitHub'a yüklenmez)
const DEFAULT_SERVER = window.MUHABBET_CONFIG?.defaultServer || 'http://localhost:3000';

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};
const COLORS = ['#5865f2', '#eb459e', '#3ba55c', '#faa61a', '#ed4245', '#9b59b6', '#1abc9c', '#e67e22'];

const S = {
  socket: null,
  me: null,
  users: [],
  textChannels: [],
  voiceChannels: [],
  history: {},
  unread: new Set(),
  currentText: null,
  myVoice: null,
  muted: false,
  deafened: false,
  stream: null,
  peers: new Map(), // userId -> { pc, audio, queue }
  speaking: new Set(),
  volumes: JSON.parse(localStorage.getItem('volumes') || '{}'), // isim -> 0..1
  micId: localStorage.getItem('micId') || '',
  speakerId: localStorage.getItem('speakerId') || '',
  noise: localStorage.getItem('noise') !== '0',
  settingsOpen: false,
};

/* ---------------- Yardımcılar ---------------- */
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function avatarEl(user, size) {
  const a = document.createElement('div');
  a.className = 'avatar';
  a.dataset.speak = user.id;
  a.style.background = colorFor(user.name);
  if (size) Object.assign(a.style, { width: size + 'px', height: size + 'px' });
  a.textContent = user.name.slice(0, 1).toUpperCase();
  if (S.speaking.has(user.id)) a.classList.add('speaking');
  return a;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
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
    }, 8000);

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
    socket.on('chat', onChat);
    socket.on('voice-peers', (ids) => ids.forEach(callPeer));
    socket.on('signal', onSignal);
    socket.on('peer-left', closePeer);
    socket.on('speaking', ({ id, speaking }) => setSpeaking(id, speaking));
    S.socket = socket;
  });
}

function onInit(d) {
  S.me = d.you;
  S.textChannels = d.textChannels;
  S.voiceChannels = d.voiceChannels;
  S.users = d.users;
  S.history = d.history;
  if (!S.textChannels.includes(S.currentText)) S.currentText = S.textChannels[0];
  $('#login').classList.add('hidden');
  $('#main').classList.remove('hidden');
  const me = userById(S.me);
  $('#my-name').textContent = me.name;
  const av = avatarEl(me);
  $('#my-avatar').replaceWith(av);
  av.id = 'my-avatar';
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
  renderVoiceChannels();
  renderMembers();
  for (const p of S.peers.values()) applyPeerAudio(p);
}

/* ---------------- Yazılı sohbet ---------------- */
function onChat(msg) {
  (S.history[msg.channel] ||= []).push(msg);
  if (msg.channel === S.currentText) {
    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.querySelector('.empty')?.remove();
    const list = S.history[msg.channel];
    box.appendChild(messageEl(msg, list[list.length - 2]));
    if (atBottom || msg.userId === S.me) box.scrollTop = box.scrollHeight;
  } else {
    S.unread.add(msg.channel);
    renderTextChannels();
  }
  if (msg.userId !== S.me && !document.hasFocus()) beep(900, 0.08);
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  S.socket.emit('chat', { channel: S.currentText, text });
  input.value = '';
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

function messageEl(msg, prev) {
  const cont = prev && prev.userId === msg.userId && msg.ts - prev.ts < 5 * 60 * 1000;
  const row = el('div', 'msg' + (cont ? ' cont' : ''));
  row.appendChild(avatarEl({ id: msg.userId, name: msg.name }, 40));
  const body = el('div', 'msg-body');
  if (!cont) {
    const head = el('div', 'msg-head');
    const n = el('span', 'msg-name', msg.name);
    n.style.color = colorFor(msg.name);
    head.append(n, el('span', 'msg-time', new Date(msg.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })));
    body.appendChild(head);
  }
  const t = el('div', 'msg-text');
  linkify(msg.text, t);
  body.appendChild(t);
  row.appendChild(body);
  return row;
}

function renderMessages() {
  const box = $('#messages');
  box.replaceChildren();
  const list = S.history[S.currentText] || [];
  if (!list.length) box.appendChild(el('div', 'empty', `#${S.currentText} kanalının başlangıcı. İlk mesajı sen yaz!`));
  list.forEach((m, i) => box.appendChild(messageEl(m, list[i - 1])));
  box.scrollTop = box.scrollHeight;
  $('#chat-title').textContent = S.currentText;
  $('#chat-input').placeholder = `#${S.currentText} kanalına mesaj gönder`;
}

/* ---------------- Arayüz ---------------- */
function renderAll() {
  renderTextChannels();
  renderVoiceChannels();
  renderMembers();
  renderMessages();
  updateButtons();
}

function renderTextChannels() {
  const box = $('#text-channels');
  box.replaceChildren();
  for (const ch of S.textChannels) {
    const d = el('div', 'channel' + (ch === S.currentText ? ' active' : ''));
    d.append(el('span', 'ico', '#'), el('span', null, ch));
    if (S.unread.has(ch)) d.appendChild(el('span', 'unread'));
    d.onclick = () => {
      S.currentText = ch;
      S.unread.delete(ch);
      renderTextChannels();
      renderMessages();
      $('#chat-input').focus();
    };
    box.appendChild(d);
  }
}

function renderVoiceChannels() {
  const box = $('#voice-channels');
  box.replaceChildren();
  for (const ch of S.voiceChannels) {
    const d = el('div', 'channel' + (ch === S.myVoice ? ' active' : ''));
    d.append(el('span', 'ico', '🔊'), el('span', null, ch));
    d.title = 'Katılmak için tıkla';
    d.onclick = () => joinVoice(ch);
    box.appendChild(d);

    const wrap = el('div', 'voice-users');
    for (const u of S.users.filter((x) => x.voice === ch)) {
      const row = el('div', 'voice-user');
      row.append(avatarEl(u), el('span', null, u.name));
      const flags = (u.muted ? '🔇' : '') + (u.deafened ? '🙉' : '');
      if (flags) row.appendChild(el('span', 'flags', flags));
      // Aynı kanaldaki diğer kişiler için ses seviyesi kaydırıcısı
      if (u.id !== S.me && ch === S.myVoice) {
        const vol = el('div', 'vol');
        const r = document.createElement('input');
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
  $('#vs-channel').textContent = S.myVoice || '';
}

function renderMembers() {
  const box = $('#member-list');
  box.replaceChildren();
  $('#online-count').textContent = S.users.length;
  for (const u of S.users) {
    const row = el('div', 'member');
    const info = el('div');
    info.appendChild(el('div', null, u.name + (u.id === S.me ? ' (sen)' : '')));
    if (u.voice) info.appendChild(el('div', 'sub2', '🔊 ' + u.voice));
    row.append(avatarEl(u), info);
    box.appendChild(row);
  }
}

function setSpeaking(id, on) {
  on ? S.speaking.add(id) : S.speaking.delete(id);
  document.querySelectorAll(`[data-speak="${CSS.escape(id)}"]`).forEach((a) => a.classList.toggle('speaking', on));
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
    for (const s of p.pc.getSenders()) if (s.track && s.track.kind === 'audio') await s.replaceTrack(track);
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
    toast('Mikrofona erişilemedi: ' + micErrorText(err));
    return;
  }
  if (S.myVoice) dropAllPeers();
  S.myVoice = ch;
  S.socket.emit('join-voice', ch);
  applyMute();
  beep(660);
}

function leaveVoice() {
  if (!S.myVoice) return;
  dropAllPeers();
  S.socket?.emit('leave-voice');
  S.myVoice = null;
  if (!S.settingsOpen) releaseMic();
  beep(330);
  renderVoiceChannels();
}
$('#leave-btn').onclick = leaveVoice;

function makePeer(id) {
  const pc = new RTCPeerConnection(ICE);
  const p = { id, pc, audio: null, queue: Promise.resolve() };
  S.stream.getAudioTracks().forEach((t) => pc.addTrack(t, S.stream));
  pc.onicecandidate = (e) => {
    if (e.candidate) S.socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    if (!p.audio) {
      p.audio = new Audio();
      p.audio.autoplay = true;
      document.body.appendChild(p.audio);
    }
    p.audio.srcObject = e.streams[0];
    applyPeerAudio(p);
    p.audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      const u = userById(id);
      toast(`${u ? u.name : 'Bir kullanıcı'} ile ses bağlantısı kurulamadı (ağ/NAT engeli).`);
    }
  };
  S.peers.set(id, p);
  return p;
}

async function callPeer(id) {
  if (!S.stream) return;
  const p = makePeer(id);
  try {
    await p.pc.setLocalDescription(await p.pc.createOffer());
    S.socket.emit('signal', { to: id, data: { description: p.pc.localDescription } });
  } catch (err) {
    console.warn('offer', err);
  }
}

function onSignal({ from, data }) {
  if (!S.myVoice || !S.stream) return;
  let p = S.peers.get(from);
  if (!p) {
    if (data.description?.type !== 'offer') return;
    p = makePeer(from);
  }
  // Sinyalleri sırayla işle (ICE adayları açıklamadan önce işlenmesin)
  p.queue = p.queue
    .then(async () => {
      if (data.description) {
        await p.pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await p.pc.setLocalDescription(await p.pc.createAnswer());
          S.socket.emit('signal', { to: from, data: { description: p.pc.localDescription } });
        }
      } else if (data.candidate) {
        await p.pc.addIceCandidate(data.candidate);
      }
    })
    .catch((err) => console.warn('signal', err));
}

function closePeer(id) {
  const p = S.peers.get(id);
  if (!p) return;
  p.pc.close();
  p.audio?.remove();
  S.peers.delete(id);
  setSpeaking(id, false);
}
function dropAllPeers() {
  [...S.peers.keys()].forEach(closePeer);
}

function applyPeerAudio(p) {
  if (!p.audio) return;
  const u = userById(p.id);
  p.audio.volume = u ? S.volumes[u.name] ?? 1 : 1;
  p.audio.muted = S.deafened;
  if (S.speakerId && p.audio.setSinkId && p.audio.sinkId !== S.speakerId) p.audio.setSinkId(S.speakerId).catch(() => {});
}

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
desktop?.onHotkey((name) => (name === 'toggle-mute' ? toggleMute() : toggleDeafen()));

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
    toast('Mikrofona erişilemedi: ' + micErrorText(err));
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
  restartMic().catch((err) => toast('Mikrofon değiştirilemedi: ' + err.message));
};
$('#speaker-select').onchange = (e) => {
  S.speakerId = e.target.value;
  localStorage.setItem('speakerId', S.speakerId);
  for (const p of S.peers.values()) p.audio?.setSinkId?.(S.speakerId).catch(() => {});
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
