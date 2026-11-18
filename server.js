const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const os = require('os');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { version: APP_VERSION } = require('./package.json');

const DATA = {
  quiz: require('./data/questions.json'),
  mostlikely: require('./data/mostlikely.json'),
  wouldyourather: require('./data/wouldyourather.json'),
  estimate: require('./data/estimates.json'),
  neverhavei: require('./data/neverhavei.json'),
  imposter: require('./data/imposter.json'),
  draw: require('./data/draw.json'),
  icebreaker: require('./data/icebreaker.json'),
  teams: require('./data/teams.json'),
  scale: require('./data/scale.json'),
  wordassoc: require('./data/wordassoc.json'),
  songs: require('./data/songs.json'),
  taboo: require('./data/taboo.json'),
  sort: require('./data/sort.json'),
  imagequiz: require('./data/imagequiz.json'),
};
DATA.songs.forEach((s, i) => { s._idx = i; });

const CUSTOM_FILE = path.join(__dirname, 'data', 'custom.json');
try {
  if (fs.existsSync(CUSTOM_FILE)) {
    const custom = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
    if (custom && typeof custom === 'object') {
      for (const [k, arr] of Object.entries(custom)) {
        if (Array.isArray(DATA[k]) && Array.isArray(arr)) DATA[k].push(...arr);
      }
    }
  }
} catch {}

const MODES = ['quiz', 'mostlikely', 'wouldyourather', 'estimate', 'reaction', 'neverhavei', 'imposter', 'draw', 'taboo', 'sort', 'icebreaker', 'teams', 'scale', 'truthlie', 'wordassoc', 'songquiz', 'imagequiz', 'mix'];
const MIX_MODES_ALL = ['quiz', 'mostlikely', 'wouldyourather', 'estimate', 'neverhavei', 'teams', 'scale', 'icebreaker', 'wordassoc', 'taboo', 'sort', 'songquiz', 'imagequiz'];
const MODE_LABELS = {
  quiz: '🎉 Party-Quiz',
  mostlikely: '🍻 Wer würde?',
  wouldyourather: '⚖️ Entweder-Oder',
  estimate: '🎯 Schätz-Duell',
  reaction: '⚡ Reaktion',
  neverhavei: '🙈 Noch nie…',
  imposter: '🕵️ Imposter',
  draw: '🎨 Zeichnen',
  taboo: '🗣️ Tabu',
  sort: '🔢 Sortieren',
  icebreaker: '🫶 Kennenlernen',
  teams: '🏆 Team-Wahl',
  scale: '📊 Skala 1–10',
  truthlie: '🎭 Wahrheit/Lüge',
  wordassoc: '⚡ Wort-Assoz.',
  songquiz: '🎵 Song-Quiz',
  imagequiz: '🖼️ Bild-Quiz',
  mix: '🎲 Party-Mix',
};
const SPIN_DURATION_MS = 4200;
const MIX_ROUNDS = 12;
const CATEGORIES = ['party', 'peinlich', 'kennenlernen', 'date', 'hot18'];
const TIME = { quiz: 20, mostlikely: 25, wouldyourather: 20, estimate: 25, reaction: 8, neverhavei: 20, imposter: 25, draw: 75, taboo: 60, sort: 30, icebreaker: 50, teams: 20, scale: 25, truthlie: 30, wordassoc: 18, songquiz: 25, imagequiz: 20 };
const TIMER_MULT = { fast: 0.7, normal: 1.0, relaxed: 1.4 };
const REACTION_ROUNDS = 5;
const HOST_SECRET_FILE = path.join(__dirname, 'data', '.host-secret');
if (!fs.existsSync(HOST_SECRET_FILE)) fs.writeFileSync(HOST_SECRET_FILE, crypto.randomBytes(4).toString('hex'), { mode: 0o600, flag: 'wx' });
const HOST_SECRET = fs.readFileSync(HOST_SECRET_FILE, 'utf8').trim();
const hostAuthFails = new Map();
function validHostSecret(val) {
  if (typeof val !== 'string') return false;
  const a = Buffer.from(val.trim()), b = Buffer.from(HOST_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'partygame.log');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function writeLog(level, event, meta = {}) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${event}${Object.keys(meta).length ? " " + JSON.stringify(meta) : ""}\n`;
  process.stdout.write(line);
  fs.appendFile(LOG_FILE, line, () => {});
}

const PORT = Number(process.env.PORT) || 3002;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 12;
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://party.goldens.cloud,http://palworld:3002,http://localhost:3002,http://127.0.0.1:3002')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const STROKE_COLORS = new Set(['#111', '#e21b3c', '#1368ce', '#26890c']);

function isLocalDirectSocket(reqOrHandshake) {
  const headers = reqOrHandshake.headers || {};
  if (headers['x-forwarded-for'] || headers['x-real-ip'] || headers['cf-connecting-ip']) return false;
  const addr = reqOrHandshake.socket?.remoteAddress || reqOrHandshake.address || '';
  if (!addr) return false;
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    /^(::ffff:)?(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr) ||
    /^fe80:/i.test(addr)
  );
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getSocketIp(socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (isLocalDirectSocket(req) && /^https?:\/\/(localhost|127\.0\.0\.1|pi(\.local)?|[a-z0-9-]+(\.local)?|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i.test(origin)) {
    return true;
  }
  return false;
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = getClientIp(req);
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
      if (hits.size > 2000) {
        for (const [k, v] of hits) { if (now > v.resetAt) hits.delete(k); }
      }
    }
    entry.count++;
    if (entry.count > max) return res.status(429).send('Zu viele Anfragen');
    next();
  };
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://*.mzstatic.com https://*.dzcdn.net data:; media-src 'self' https://*.mzstatic.com https://*.itunes.apple.com https://*.dzcdn.net; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
  );
  next();
});
app.use(createRateLimiter({ windowMs: 60_000, max: 180 }));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e4,
  pingInterval: 25000,
  pingTimeout: 30000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  allowRequest: (req, cb) => cb(null, isAllowedOrigin(req)),
  cors: {
    origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.has(origin)),
  },
});
app.use(express.static(__dirname + '/public', { etag: false, maxAge: 0 }));
const sendNoCache = file => (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(__dirname + '/public/' + file);
};
app.get('/health', (_req, res) => {
  let totalPlayers = 0;
  for (const r of rooms.values()) totalPlayers += r.getPlayerCount();
  res.json({
    ok: true,
    service: 'partygame',
    version: APP_VERSION,
    rooms: rooms.size,
    players: totalPlayers,
    uptimeSec: Math.round(process.uptime())
  });
});

app.get('/', sendNoCache('play.html'));
app.get('/play', sendNoCache('play.html'));
app.get('/host', sendNoCache('host.html'));
app.get('/admin', sendNoCache('admin.html'));
app.get('/rooms', sendNoCache('rooms.html'));
app.get('/room', sendNoCache('rooms.html'));
const IQ_IMG_DIR = path.join(__dirname, 'data', 'iq-images');
app.get('/iq/:file', (req, res) => {
  const safe = path.basename(String(req.params.file || ''));
  if (!safe || safe.startsWith('.')) return res.status(404).end();
  const full = path.join(IQ_IMG_DIR, safe);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(full);
});
const SONG_AUDIO_DIR = path.join(__dirname, 'data', 'song-audio');
app.get('/song-audio/:file', (req, res) => {
  const safe = path.basename(String(req.params.file || ''));
  if (!safe || safe.startsWith('.') || !safe.endsWith('.mp3')) return res.status(404).end();
  const full = path.join(SONG_AUDIO_DIR, safe);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(full);
});

const DEFAULT_URL_PLAY = (process.env.PUBLIC_URL || 'https://party.goldens.cloud').replace(/\/+$/, '');
const USED_FILE = path.join(__dirname, 'data', 'used.json');
const usedIndices = {}; // mode -> Set of recently played indices
try {
  if (fs.existsSync(USED_FILE)) {
    const raw = JSON.parse(fs.readFileSync(USED_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [k, arr] of Object.entries(raw)) {
        if (Array.isArray(arr)) usedIndices[k] = new Set(arr.filter(Number.isInteger));
      }
    }
  }
} catch (err) {
  writeLog('WARN', 'used_json_load_failed', { error: err?.message || String(err) });
}

let saveUsedTimer = null;
function saveUsedIndices() {
  clearTimeout(saveUsedTimer);
  saveUsedTimer = setTimeout(() => {
    const out = {};
    for (const [k, set] of Object.entries(usedIndices)) out[k] = [...set];
    fs.writeFile(USED_FILE, JSON.stringify(out), (err) => {
      if (err) writeLog('WARN', 'used_json_save_failed', { error: err?.message || String(err) });
    });
  }, 300).unref();
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rooms = new Map();
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function normalizeRoomCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
function generateRoomCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}
function getRoom(raw) {
  const code = normalizeRoomCode(raw);
  return code ? (rooms.get(code) || null) : null;
}

app.post('/api/rooms', (req, res) => {
  const code = generateRoomCode();
  const hostToken = crypto.randomBytes(8).toString('hex');
  const room = createRoom(code, hostToken);
  rooms.set(code, room);
  writeLog('INFO', 'room_created', { code });
  res.status(201).json({ ok: true, code, hostToken });
});

app.get('/api/rooms', (req, res) => {
  const secret = String(req.headers['x-host-secret'] || '');
  if (!validHostSecret(secret)) return res.status(401).json({ ok: false, error: 'Ungültiger Host-PIN' });
  const now = Date.now();
  const list = [...rooms.values()].map(r => r.getSummary(now));
  res.json({ ok: true, rooms: list });
});

app.delete('/api/rooms/:code', (req, res) => {
  const secret = String(req.headers['x-host-secret'] || '');
  if (!validHostSecret(secret)) return res.status(401).json({ ok: false, error: 'Ungültiger Host-PIN' });
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false, error: 'Raum nicht gefunden' });
  room.destroy();
  rooms.delete(room.code);
  writeLog('INFO', 'room_closed_by_admin', { code: room.code });
  res.json({ ok: true });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = getRoom(req.params.code);
  res.json({ exists: !!room, code: room ? room.code : null });
});

const qrCacheMap = new Map();
app.get('/qr.png', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const room = getRoom(req.query.room);
  const targetUrl = room ? room.getJoinUrl() : DEFAULT_URL_PLAY;
  let buf = qrCacheMap.get(targetUrl);
  if (!buf) {
    buf = await QRCode.toBuffer(targetUrl, { width: 600, margin: 1 });
    if (qrCacheMap.size >= 100) qrCacheMap.clear();
    qrCacheMap.set(targetUrl, buf);
  }
  res.type('png').send(buf);
});

app.get('/info', (req, res) => {
  const room = getRoom(req.query.room);
  res.json({ url: room ? room.getJoinUrl() : DEFAULT_URL_PLAY, room: room ? room.code : null });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.isIdleExpired(now)) {
      room.destroy();
      rooms.delete(code);
      writeLog('INFO', 'room_expired', { code });
    }
  }
}, 5 * 60_000).unref();

function createRoom(code, hostToken) {
const ROOM_CHAN = 'room:' + code;
const roomSockets = new Set();
let lastActivity = Date.now();
let publicUrl = `${DEFAULT_URL_PLAY}/?room=${code}`;

function validRoomToken(val) {
  if (typeof val !== 'string' || !val) return false;
  const a = Buffer.from(val.trim()), b = Buffer.from(hostToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let state = freshState('quiz');
let activeCategories = ['party', 'peinlich', 'kennenlernen'];
let roundLimit = 0; // 0 = Alle, sonst 5 / 10 / 15
let teamMode = false;
let displayMode = 'tv'; // 'tv' | 'notv' | 'onedevice'
let songLangs = { en: true, de: true };
  let imageQuizThemes = ['logos', 'landmarks', 'flags', 'cars'];
let russianShare = 0;
let songOnlyArtistTitle = false;
let finalDouble = true;
let wheelEnabled = true;
let secretMissions = false;
let alcoholFree = false;
let timerSpeed = 'normal';
let mixRounds = MIX_ROUNDS;
const roundTimeMs = m => Math.max(4000, Math.round((TIME[m] || 20) * (m === 'reaction' ? 1 : (TIMER_MULT[timerSpeed] || 1)) * 1000));
const SECRET_MISSIONS = [
  'Bau das Wort „Banane“ unauffällig in einen Satz ein.',
  'Bau das Wort „Montag“ unauffällig in deine Aussage ein.',
  'Stimm beim nächsten Voting für die Person links von dir.',
  'Widersprich in dieser Runde mindestens einer Person komplett.',
  'Benutze ein englisches Modewort (z. B. literally, random, vibe) in deinem Satz.',
  'Stell mindestens eine Gegenfrage, damit es wirkt, als wüsstest du mehr.',
  'Sag mindestens einmal „Ehrlich gesagt…“, bevor du antwortest.',
  'Lobe in dieser Runde die Antwort oder Zeichnung von jemand anderem übertrieben.',
  'Antworte auf die nächste Frage zuerst mit „Kommt drauf an…“.',
  'Nenne eine Zahl zwischen 17 und 99 in deinem nächsten Satz.',
  'Behaupte felsenfest, dass du dir zu 100 % sicher bist – egal ob es stimmt.',
  'Reagiere auf die nächste Aussage mit einem dramatischen Seufzer.',
  'Benutze das Wort „eigentlich“ mindestens zweimal in dieser Runde.',
  'Erwähne beiläufig ein Tier, das überhaupt nicht zum Thema passt.',
];
let mixModes = ['quiz', 'mostlikely', 'wouldyourather', 'estimate', 'neverhavei', 'teams', 'scale', 'icebreaker', 'wordassoc'];
let roundSeq = 0;
let spinSeq = 0;
let pendingSpinNext = null;
let actorQueues = {};
const TEAMS = [
  { id: 'red', label: '🔴 Team Rot', icon: '🔴' },
  { id: 'blue', label: '🔵 Team Blau', icon: '🔵' },
  { id: 'yellow', label: '🟡 Team Gelb', icon: '🟡' },
  { id: 'green', label: '🟢 Team Grün', icon: '🟢' },
  { id: 'purple', label: '🟣 Team Lila', icon: '🟣' },
  { id: 'orange', label: '🟠 Team Orange', icon: '🟠' },
  { id: 'pink', label: '🩷 Team Pink', icon: '🩷' },
  { id: 'teal', label: '🩵 Team Türkis', icon: '🩵' },
];
const players = {}; // id -> { name, avatar, team, score, drinks, answer, answeredAt, stats }
const disconnectedPlayers = new Map();
const skipVotes = new Set(); // name.toLowerCase() -> { data, timer }
let timer = null;

function freshState(mode) {
  return {
    mode, subMode: null, subIdx: -1, mixOrder: [], mixPools: {},
    phase: 'lobby', idx: -1, deadline: 0, totalMs: 0, order: [],
    paused: false, pausedLeft: 0,
    result: null, reactionGoAt: 0,
    spin: null, lobbyBanner: null,
    songStarted: false, roundStartedAt: 0,
    imposterIds: [], imposterWords: null,
    drawerName: null, drawWord: null, strokes: [], guessedBy: [],
    explainerName: null, tabooWord: null, tabooForbidden: [], tabooGuessedBy: [],
    sortOrder: [],
    storytellerName: null, tlStatements: [], tlLieIdx: -1,
    songQ: null,
    mission: null,
  };
}

const pVals = () => Object.values(players);
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const activeMode = () => (state.mode === 'mix' && state.subMode ? state.subMode : state.mode);


function effectiveRussianShare() {
  if (!songLangs.en && !songLangs.de) return 100;
  return russianShare;
}

function isSongAllowed(song) {
  if (!song) return false;
  const share = effectiveRussianShare();
  if (song.lang === 'ru') return share > 0;
  if (share >= 100) return false;
  return !!songLangs[song.lang];
}

function mixSongsByShare(ruArr, nonRuArr, sharePct) {
  const ru = shuffle(ruArr);
  const std = shuffle(nonRuArr);
  if (sharePct <= 0) return std;
  if (sharePct >= 100) return ru;
  const out = [];
  let ri = 0, si = 0, acc = 0;
  while (ri < ru.length || si < std.length) {
    if (ri >= ru.length) { out.push(std[si++]); continue; }
    if (si >= std.length) { out.push(ru[ri++]); continue; }
    acc += sharePct;
    if (acc >= 100) { acc -= 100; out.push(ru[ri++]); }
    else { out.push(std[si++]); }
  }
  return out;
}

function pickOrder(mode) {
  const all = filteredIndices(mode);
  const used = usedIndices[mode] || (usedIndices[mode] = new Set());
  const share = effectiveRussianShare();
  if (mode === 'songquiz' && share > 0 && share < 100) {
    const allRu = all.filter(i => DATA.songs[i]?.lang === 'ru');
    const allNonRu = all.filter(i => DATA.songs[i]?.lang !== 'ru');
    if (allRu.length && allNonRu.length) {
      let freshRu = allRu.filter(i => !used.has(i));
      if (!freshRu.length) {
        for (const i of allRu) used.delete(i);
        saveUsedIndices();
        freshRu = allRu;
      }
      let freshNonRu = allNonRu.filter(i => !used.has(i));
      if (!freshNonRu.length) {
        for (const i of allNonRu) used.delete(i);
        saveUsedIndices();
        freshNonRu = allNonRu;
      }
      const restRu = allRu.filter(i => used.has(i));
      const restNonRu = allNonRu.filter(i => used.has(i));
      return [...mixSongsByShare(freshRu, freshNonRu, share), ...mixSongsByShare(restRu, restNonRu, share)];
    }
  }
  let fresh = all.filter(i => !used.has(i));
  if (!fresh.length) {
    for (const i of all) used.delete(i);
    saveUsedIndices();
    fresh = all;
  }
  const rest = all.filter(i => used.has(i));
  return [...shuffle(fresh), ...shuffle(rest)];
}

function allowedSongs() {
  const list = DATA.songs.filter(isSongAllowed);
  return list.length ? list : DATA.songs;
}

function filteredIndices(mode) {
  if (mode === 'reaction' || mode === 'truthlie' || mode === 'mix') return [];
  if (mode === 'songquiz') {
    const matching = DATA.songs.map((s, i) => (isSongAllowed(s) ? i : -1)).filter(i => i !== -1);
    return matching.length ? matching : DATA.songs.map((_, i) => i);
  }
  if (mode === 'imagequiz') {
    const matching = DATA.imagequiz.map((item, i) => (imageQuizThemes.includes(item.theme) ? i : -1)).filter(i => i !== -1);
    return matching.length ? matching : DATA.imagequiz.map((_, i) => i);
  }
  const pool = DATA[mode];
  const matching = pool
    .map((item, i) => (!item.cat || activeCategories.includes(item.cat) ? i : -1))
    .filter(i => i !== -1);
  return matching.length ? matching : pool.map((_, i) => i);
}

const totalRounds = () => {
  let n;
  if (state.mode === 'reaction') n = REACTION_ROUNDS;
  else if (state.mode === 'mix') n = mixRounds;
  else if (state.mode === 'truthlie') n = state.phase === 'lobby' ? Math.max(pVals().length, 3) : Math.max(state.order.length, 1);
  else if (state.order.length && state.phase !== 'lobby') n = state.order.length;
  else n = filteredIndices(state.mode).length;
  return roundLimit > 0 ? Math.min(n, roundLimit) : n;
};

const list = () => pVals()
  .map(p => ({
    name: p.name,
    avatar: p.avatar || '😎',
    team: p.team || null,
    score: p.score,
    prevScore: p.prevScore ?? p.score,
    lastGain: p.lastGain || 0,
    streak: p.streak || 0,
    drinks: p.drinks,
    answered: p.answer !== null,
  }))
  .sort((a, b) => b.score - a.score || a.drinks - b.drinks);

function currentQuestion() {
  if (state.phase === 'lobby' || state.phase === 'end' || state.phase === 'spin') return null;
  const m = activeMode();
  if (m === 'truthlie') {
    return {
      storyteller: state.storytellerName,
      statements: state.tlStatements.map(s => s.text),
    };
  }
  const qIdx = state.mode === 'mix' ? state.subIdx : state.order[state.idx];
  const item = (m === 'reaction' || m === 'songquiz') ? null : DATA[m][qIdx];
  switch (m) {
    case 'quiz': return item ? { q: item.q, a: item.a } : null;
    case 'imagequiz': return item ? { q: item.q, a: item.a, img: '/iq/' + item.img, theme: item.theme } : null;
    case 'mostlikely': return item ? { q: item.q ?? item } : null;
    case 'wouldyourather': return item ? { a: item.a ?? item[0], b: item.b ?? item[1] } : null;
    case 'estimate': return item ? { q: item.q, unit: item.unit } : null;
    case 'neverhavei': return item ? { q: item.q ?? item } : null;
    case 'reaction': return { q: 'Drücke erst, wenn es GRÜN wird!' };
    case 'imposter': return { q: state.phase === 'discuss' ? 'Lies dein geheimes Wort und gib einen Hinweis!' : 'Wer ist der Imposter?' };
    case 'draw': return { drawer: state.drawerName, len: state.drawWord ? state.drawWord.length : 0, guessed: state.guessedBy };
    case 'taboo': return { explainer: state.explainerName, len: state.tabooWord ? state.tabooWord.length : 0, guessed: state.tabooGuessedBy };
    case 'sort': return item && state.sortOrder.length === 4 ? { q: item.q, items: state.sortOrder.map((origIdx, dispIdx) => ({ idx: dispIdx, label: item.items[origIdx].label })) } : null;
    case 'icebreaker': return item ? { q: item.q ?? item } : null;
    case 'teams': return item ? { q: item.q, a: item.a } : null;
    case 'scale': return item ? { q: item.q, min: item.min, max: item.max } : null;
    case 'wordassoc': return item ? { w: item.w } : null;
    case 'songquiz': return state.songQ ? { q: state.songQ.q, a: state.songQ.a, preview: state.songQ.preview } : null;
    default: return null;
  }
}

const isFinalRound = () => finalDouble && state.phase !== 'lobby' && state.phase !== 'end' && totalRounds() > 1 && state.idx === totalRounds() - 1;

function computeAwards() {
  if (state.phase !== 'end') return [];
  const ps = pVals();
  if (!ps.length) return [];
  const awards = [];
  const topDrinks = [...ps].sort((a, b) => b.drinks - a.drinks)[0];
  if (topDrinks && topDrinks.drinks > 0) {
    awards.push(alcoholFree
      ? { icon: '🎯', title: 'Pechvogel', name: topDrinks.name, detail: `${topDrinks.drinks} Aufgaben` }
      : { icon: '🍻', title: 'Trinkkönig', name: topDrinks.name, detail: `${topDrinks.drinks} Schlücke` });
  }
  const fastPlayers = ps.filter(p => p.stats && p.stats.fastCount > 0)
    .map(p => ({ name: p.name, avg: Math.round(p.stats.fastSum / p.stats.fastCount) }))
    .sort((a, b) => a.avg - b.avg);
  if (fastPlayers.length) {
    awards.push({ icon: '⚡', title: 'Blitzdenker', name: fastPlayers[0].name, detail: `Ø ${(fastPlayers[0].avg / 1000).toFixed(1)}s` });
  }
  const topGuesser = [...ps].filter(p => p.stats && p.stats.guessedWords > 0).sort((a, b) => b.stats.guessedWords - a.stats.guessedWords)[0];
  if (topGuesser) {
    awards.push({ icon: '🧠', title: 'Rate-Profi', name: topGuesser.name, detail: `${topGuesser.stats.guessedWords}× erraten` });
  }
  const topEst = [...ps].filter(p => p.stats && p.stats.bestEstimate > 0).sort((a, b) => b.stats.bestEstimate - a.stats.bestEstimate)[0];
  if (topEst) {
    awards.push({ icon: '🎯', title: 'Schätz-Meister', name: topEst.name, detail: `${topEst.stats.bestEstimate}× am nächsten` });
  }
  return awards;
}

function pub() {
  const m = state.phase === 'lobby' || state.phase === 'end' ? state.mode : activeMode();
  const teams = teamMode ? TEAMS.map(t => {
    const members = pVals().filter(p => p.team === t.id);
    const score = members.reduce((s, p) => s + p.score, 0);
    const prevScore = members.reduce((s, p) => s + (p.prevScore ?? p.score), 0);
    return {
      id: t.id, label: t.label, icon: t.icon,
      members: members.map(p => `${p.avatar || '😎'} ${p.name}`),
      score,
      prevScore,
      lastGain: Math.max(0, score - prevScore),
    };
  }).filter(t => t.members.length > 0).sort((a, b) => b.score - a.score) : null;
  return {
    roomCode: code, mode: m, isMix: state.mode === 'mix', phase: state.phase, idx: state.idx, total: totalRounds(),
    isFinalRound: isFinalRound(),
    categories: activeCategories, roundLimit, teamMode,
    displayMode, noTvMode: displayMode !== 'tv',
    songLangs, imageQuizThemes, russianShare, effectiveRussianShare: effectiveRussianShare(), songOnlyArtistTitle, finalDouble, wheelEnabled, secretMissions, alcoholFree, timerSpeed, mixRounds, mixModes,
    publicUrl, defaultPublicUrl: DEFAULT_URL_PLAY,
    teams,
    paused: state.paused, pausedLeft: state.pausedLeft,
    deadline: state.deadline, time: TIME[m],
    leftMs: state.deadline > 0 ? Math.max(0, state.deadline - Date.now()) : 0,
    totalMs: state.totalMs > 0 ? state.totalMs : (TIME[m] || 15) * 1000,
    spin: state.phase === 'spin' ? state.spin : null,
    lobbyBanner: state.phase === 'lobby' ? state.lobbyBanner : null,
    q: currentQuestion(),
    nextImg: (state.mode === 'imagequiz' && (state.phase === 'question' || state.phase === 'result') && state.idx + 1 < totalRounds() && DATA.imagequiz[state.order[state.idx + 1]]) ? ('/iq/' + DATA.imagequiz[state.order[state.idx + 1]].img) : null,
    nextAudio: (m === 'songquiz' && (state.phase === 'question' || state.phase === 'result') && state.idx + 1 < totalRounds() && state.order[state.idx + 1] !== undefined && fs.existsSync(path.join(SONG_AUDIO_DIR, `${state.order[state.idx + 1]}.mp3`))) ? (`/song-audio/${state.order[state.idx + 1]}.mp3`) : null,
    result: state.phase === 'result' ? state.result : null,
    skipVote: ['question', 'go', 'write', 'discuss', 'result'].includes(state.phase) && displayMode !== 'onedevice' ? (() => {
      const ps = pVals();
      const total = ps.length;
      const needed = Math.max(1, Math.ceil(total * 0.65));
      const voters = Array.from(skipVotes).filter(n => ps.some(pl => pl.name.toLowerCase() === n));
      return { count: voters.length, needed, total, voters };
    })() : null,
    missionReveal: (state.phase === 'result' && state.mission)
      ? { playerName: state.mission.playerName, text: state.mission.text, resolved: state.mission.resolved, success: state.mission.success }
      : null,
    awards: state.phase === 'end' ? computeAwards() : [],
    players: list(),
  };
}

function sendPrivate(socket, id) {
  const p = players[id];
  if (!p) return socket.emit('private', null);
  const mission = (state.mission && state.mission.playerId === id && state.phase !== 'result') ? state.mission.text : null;
  const m = activeMode();
  if (m === 'imposter' && state.imposterWords && (state.phase === 'discuss' || state.phase === 'question')) {
    const isImp = state.imposterIds.includes(id);
    return socket.emit('private', { mode: 'imposter', word: isImp ? state.imposterWords[1] : state.imposterWords[0], mission });
  }
  if (m === 'draw' && state.phase === 'question') {
    const isDrawer = p.name === state.drawerName;
    return socket.emit('private', { mode: 'draw', drawer: isDrawer, word: isDrawer ? state.drawWord : null, guessed: state.guessedBy.includes(p.name), mission });
  }
  if (m === 'taboo' && state.phase === 'question') {
    const isExplainer = p.name === state.explainerName;
    return socket.emit('private', {
      mode: 'taboo', explainer: isExplainer,
      word: isExplainer ? state.tabooWord : null,
      taboo: isExplainer ? state.tabooForbidden : [],
      guessed: state.tabooGuessedBy.includes(p.name),
      mission,
    });
  }
  socket.emit('private', mission ? { mission } : null);
}

function broadcast() {
  io.to(ROOM_CHAN).emit('state', pub());
  for (const id of roomSockets) {
    const sock = io.sockets.sockets.get(id);
    if (sock) sendPrivate(sock, id);
  }
}

function pickNextActor(mode) {
  const ps = pVals();
  if (!ps.length) return null;
  const names = ps.map(p => p.name);
  let q = (actorQueues[mode] || []).filter(n => names.includes(n));
  if (!q.length) q = shuffle(names);
  const chosen = q.shift();
  actorQueues[mode] = q;
  return chosen;
}

function runSpinsThen(spins, afterFn, forceSpin = false) {
  clearTimeout(timer);
  if ((!wheelEnabled && !forceSpin) || !spins.length) {
    state.spin = null;
    pendingSpinNext = null;
    return afterFn();
  }
  const nextSpin = spins.shift();
  state.phase = 'spin';
  state.spin = nextSpin;
  state.totalMs = nextSpin.duration;
  state.deadline = Date.now() + nextSpin.duration;
  pendingSpinNext = () => runSpinsThen(spins, afterFn, forceSpin);
  broadcast();
  timer = setTimeout(() => {
    if (state.phase === 'spin' && pendingSpinNext) {
      const fn = pendingSpinNext;
      pendingSpinNext = null;
      fn();
    }
  }, nextSpin.duration);
}

function startGame() {
  clearTimeout(timer);
  pendingSpinNext = null;
  state.spin = null;
  state.lobbyBanner = null;
  actorQueues = {};
  if (state.mode === 'reaction') {
    state.order = Array.from({ length: REACTION_ROUNDS }, (_, i) => i);
  } else if (state.mode === 'truthlie') {
    const cnt = Math.max(pVals().length, 1);
    state.order = Array.from({ length: cnt }, (_, i) => i);
  } else if (state.mode === 'mix') {
    const activeMix = mixModes.length ? mixModes : MIX_MODES_ALL;
    state.mixPools = {};
    activeMix.forEach(m => { state.mixPools[m] = pickOrder(m); });
    state.mixOrder = [];
    while (state.mixOrder.length < mixRounds) {
      state.mixOrder.push(...shuffle(activeMix));
    }
    state.mixOrder = state.mixOrder.slice(0, mixRounds);
    state.order = state.mixOrder;
  } else {
    state.order = pickOrder(state.mode);
  }
  state.idx = -1;
  pVals().forEach(p => { p.score = 0; p.prevScore = 0; p.lastGain = 0; p.streak = 0; p.drinks = 0; p.stats = { fastSum: 0, fastCount: 0, bestEstimate: 0, guessedWords: 0 }; });
  nextRound();
}

const songCache = {};
const songInFlight = {};
async function fetchSongPreview(song) {
  if (!song) return { preview: null, art: null };
  if (typeof song._idx === 'number') {
    const localFile = path.join(SONG_AUDIO_DIR, `${song._idx}.mp3`);
    if (fs.existsSync(localFile)) return { preview: `/song-audio/${song._idx}.mp3`, art: null };
  }
  const key = `${song.artist} - ${song.title}`;
  if (songCache[key]) return songCache[key];
  if (songInFlight[key]) return songInFlight[key];
  songInFlight[key] = (async () => {
    const term = song.query || key;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const normTitle = norm(String(song.title || '').replace(/\(.*?\)/g, ''));
    const primArtist = norm(String(song.artist || '').split(/[,&]|feat\.|vs\./i)[0]);
    const allowRemix = /remix/i.test(song.title || '');
    const bad = allowRemix
      ? /karaoke|tribute|cover|instrumental|live|инструмент|originally performed|made famous|in the style of/i
      : /karaoke|tribute|cover|instrumental|remix|live|инструмент|originally performed|made famous|in the style of/i;
    const ruMap = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
    const toLat = s => String(s || '').toLowerCase().replace(/[а-яё]/g, ch => ruMap[ch] ?? ch).replace(/[^\p{L}\p{N}]/gu, '');
    const qNorm = norm(song.query || '');
    const latTitle = toLat(String(song.title || '').replace(/\(.*?\)/g, ''));
    const titleMatch = tr => {
      const nt = norm(tr);
      const lt = toLat(tr);
      return (normTitle && (nt.includes(normTitle) || normTitle.includes(nt)))
        || (latTitle && (lt.includes(latTitle) || latTitle.includes(lt)));
    };
    const artistMatch = ar => {
      const na = norm(ar);
      const la = toLat(ar);
      if (!na) return false;
      if (primArtist && (na.includes(primArtist) || primArtist.includes(na) || la.includes(primArtist) || primArtist.includes(la))) return true;
      if (qNorm && na.length >= 3 && qNorm.includes(na)) return true;
      return false;
    };
    const isGood = (ar, tr) => artistMatch(ar) && titleMatch(tr) && !bad.test(tr || '') && !bad.test(ar || '');
    let results = [];
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=8&country=de`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.ok) {
        const data = await res.json();
        results = (data.results || []).filter(r => r.previewUrl);
        const exactItunes = results.find(r => isGood(r.artistName, r.trackName));
        if (exactItunes) {
          songCache[key] = {
            preview: exactItunes.previewUrl,
            art: exactItunes.artworkUrl100 ? exactItunes.artworkUrl100.replace('100x100bb', '300x300bb') : null,
          };
          return songCache[key];
        }
      }
    } catch {}
    try {
      const dzRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=8`, { signal: ctrl.signal });
      let dzHits = [];
      if (dzRes.ok) {
        const dzData = await dzRes.json();
        dzHits = (dzData.data || []).filter(r => r.preview);
      }
      const hit = dzHits.find(r => isGood(r.artist?.name, r.title))
        || results.find(r => artistMatch(r.artistName) && !bad.test(r.trackName || '') && !bad.test(r.artistName || ''))
        || dzHits.find(r => artistMatch(r.artist?.name) && !bad.test(r.title || '') && !bad.test(r.artist?.name || ''))
        || results.find(r => titleMatch(r.trackName) && !bad.test(r.trackName || '') && !bad.test(r.artistName || ''))
        || dzHits.find(r => titleMatch(r.title) && !bad.test(r.title || '') && !bad.test(r.artist?.name || ''))
        || results.find(r => !bad.test(r.trackName || '') && !bad.test(r.artistName || ''))
        || dzHits.find(r => !bad.test(r.title || '') && !bad.test(r.artist?.name || ''));
      if (hit) {
        const isItunes = !!hit.previewUrl;
        songCache[key] = isItunes
          ? { preview: hit.previewUrl, art: hit.artworkUrl100 ? hit.artworkUrl100.replace('100x100bb', '300x300bb') : null }
          : { preview: hit.preview, art: hit.album?.cover_medium || hit.album?.cover || null };
        return songCache[key];
      }
    } catch {} finally {
      clearTimeout(t);
      delete songInFlight[key];
    }
    return { preview: null, art: null };
  })();
  return songInFlight[key];
}

let songKindQueue = [];
let lastSongKind = '';
function nextSongKind() {
  const kinds = songOnlyArtistTitle ? ['artist', 'title'] : ['artist', 'title', 'type', 'year', 'decade'];
  songKindQueue = songKindQueue.filter(k => kinds.includes(k));
  if (!songKindQueue.length) {
    songKindQueue = shuffle(kinds);
    if (songKindQueue[0] === lastSongKind && songKindQueue.length > 1) {
      [songKindQueue[0], songKindQueue[1]] = [songKindQueue[1], songKindQueue[0]];
    }
  }
  lastSongKind = songKindQueue.shift();
  return lastSongKind;
}

function songDistractors(song, field, count = 3) {
  const pool = allowedSongs();
  const sameLang = pool.filter(s => s.lang === song.lang && s[field] !== song[field]);
  const primary = shuffle([...new Set(sameLang.map(s => s[field]))]);
  if (primary.length >= count) return primary.slice(0, count);
  const rest = shuffle([...new Set(pool.map(s => s[field]).filter(x => x !== song[field] && !primary.includes(x)))]);
  return [...primary, ...rest].slice(0, count);
}

function buildSongQuestion(song, meta) {
  const kind = nextSongKind();
  let q = '', a = [], c = 0;

  if (kind === 'artist') {
    q = '🎤 Von wem ist dieser Song?';
    const others = songDistractors(song, 'artist', 5);
    a = shuffle([song.artist, ...others]);
    c = a.indexOf(song.artist);
  } else if (kind === 'title') {
    q = '🎵 Wie heißt dieser Song?';
    const others = songDistractors(song, 'title');
    a = shuffle([song.title, ...others]);
    c = a.indexOf(song.title);
  } else if (kind === 'year') {
    q = '📅 Aus welchem Jahr stammt dieser Song?';
    const maxY = new Date().getFullYear();
    const yrs = new Set([song.year]);
    const offsets = shuffle([-8, -5, -3, -2, 2, 3, 5, 8]);
    for (const off of offsets) {
      if (yrs.size >= 4) break;
      const y = Math.min(maxY, song.year + off);
      if (y !== song.year) yrs.add(y);
    }
    a = shuffle([...yrs]).map(String);
    c = a.indexOf(String(song.year));
  } else if (kind === 'decade') {
    q = '🕰️ Aus welchem Jahrzehnt ist dieser Song?';
    const dec = y => `${Math.floor((y % 100) / 10) * 10 === 0 ? '2000' : Math.floor(y / 10) * 10 === 2010 ? '2010' : Math.floor(y / 10) * 10 === 2020 ? '2020' : Math.floor((y % 100) / 10) * 10}er`;
    const correctDec = dec(song.year);
    const pool = ['60er', '70er', '80er', '90er', '2000er', '2010er', '2020er'].filter(d => d !== correctDec);
    a = shuffle([correctDec, ...shuffle(pool).slice(0, 3)]);
    c = a.indexOf(correctDec);
  } else {
    q = '👥 Solo-Künstler oder Band / Gruppe?';
    a = ['👤 Solo-Künstler', '👥 Band / Gruppe'];
    c = song.type === 'solo' ? 0 : 1;
  }

  return { q, a, c, artist: song.artist, title: song.title, year: song.year, type: song.type, preview: meta.preview, art: meta.art };
}

async function nextRound() {
  clearTimeout(timer);
  skipVotes.clear();
  pendingSpinNext = null;
  state.spin = null;
  const seq = ++roundSeq;
  state.idx++;
  if (state.idx >= totalRounds()) {
    state.phase = 'end';
    state.subMode = null;
    return broadcast();
  }
  pVals().forEach(p => { p.answer = null; p.answeredAt = 0; p.prevScore = p.score || 0; p.lastGain = 0; });
  state.paused = false;
  state.pausedLeft = 0;
  state.deadline = 0;
  state.totalMs = 0;
  state.songStarted = false;
  state.roundStartedAt = 0;
  state.result = null;
  state.strokes = [];
  state.guessedBy = [];
  state.drawerName = null;
  state.explainerName = null;
  state.tabooWord = null;
  state.tabooForbidden = [];
  state.tabooGuessedBy = [];
  state.sortOrder = [];
  state.storytellerName = null;
  state.tlStatements = [];
  state.tlLieIdx = -1;

  if (state.mode === 'mix') {
    state.subMode = state.mixOrder[state.idx];
    if (!state.mixPools[state.subMode] || !state.mixPools[state.subMode].length) {
      state.mixPools[state.subMode] = pickOrder(state.subMode);
    }
    state.subIdx = state.mixPools[state.subMode].shift();
  } else {
    state.subMode = null;
    state.subIdx = -1;
  }

  const m = activeMode();
  const playedIdx = state.mode === 'mix' ? state.subIdx : state.order[state.idx];
  if (typeof playedIdx === 'number' && playedIdx >= 0 && m !== 'reaction' && m !== 'truthlie') {
    (usedIndices[m] || (usedIndices[m] = new Set())).add(playedIdx);
    saveUsedIndices();
  }

  const spins = [];
  if (state.mode === 'mix') {
    const activeMix = mixModes.length ? mixModes : MIX_MODES_ALL;
    const pool = activeMix.includes(state.subMode) ? activeMix : [...activeMix, state.subMode];
    const wIdx = Math.max(0, pool.indexOf(state.subMode));
    spins.push({
      id: ++spinSeq,
      kind: 'mode',
      title: '🎲 Welches Spiel kommt jetzt?',
      subtitle: `Party-Mix · Runde ${state.idx + 1} / ${totalRounds()}`,
      items: pool.map(k => MODE_LABELS[k] || k),
      winnerIdx: wIdx,
      winnerLabel: MODE_LABELS[state.subMode] || state.subMode,
      duration: SPIN_DURATION_MS,
    });
  }

  const ps = pVals();
  if (m === 'truthlie' || m === 'draw' || m === 'taboo') {
    const chosenName = pickNextActor(m);
    if (m === 'truthlie') state.storytellerName = chosenName;
    else if (m === 'draw') state.drawerName = chosenName;
    else if (m === 'taboo') state.explainerName = chosenName;

    if (ps.length >= 2 && chosenName) {
      const wIdx = Math.max(0, ps.findIndex(p => p.name === chosenName));
      const pObj = ps[wIdx];
      const wLabel = pObj ? `${pObj.avatar || '😎'} ${pObj.name}` : chosenName;
      const roleTitle = m === 'draw'
        ? '🎨 Wer malt als Nächstes?'
        : m === 'taboo'
        ? '🗣️ Wer erklärt als Nächstes?'
        : '🎭 Wer ist als Nächstes dran?';
      spins.push({
        id: ++spinSeq,
        kind: 'player',
        title: roleTitle,
        subtitle: `${MODE_LABELS[m] || m} · Runde ${state.idx + 1}`,
        items: ps.map(p => `${p.avatar || '😎'} ${p.name}`),
        winnerIdx: wIdx,
        winnerLabel: wLabel,
        duration: SPIN_DURATION_MS,
      });
    }
  }

  if (m === 'songquiz' && DATA.songs[playedIdx]) {
    fetchSongPreview(DATA.songs[playedIdx]).catch(() => {});
  }

  runSpinsThen(spins, () => activateRound(seq, m, playedIdx));
}

async function activateRound(seq, m, playedIdx) {
  if (seq !== roundSeq) return;
  state.mission = null;
  if (secretMissions && m !== 'reaction' && displayMode !== 'onedevice') {
    const online = Object.entries(players).filter(([, p]) => !p.isLocal);
    if (online.length >= 2 && Math.random() < 0.45) {
      const [pid, mp] = online[crypto.randomInt(online.length)];
      const text = SECRET_MISSIONS[crypto.randomInt(SECRET_MISSIONS.length)];
      state.mission = { playerId: pid, playerName: mp.name, text, resolved: false, success: null };
    }
  }

  if (m === 'truthlie') {
    if (!state.storytellerName) state.storytellerName = pickNextActor('truthlie');
    state.phase = 'write';
    state.deadline = 0;
    state.totalMs = 0;
    broadcast();
    return;
  }

  if (m === 'reaction') {
    state.phase = 'wait';
    state.deadline = 0;
    state.totalMs = 0;
    broadcast();
    const delay = 2500 + Math.floor(Math.random() * 3500);
    timer = setTimeout(() => {
      state.phase = 'go';
      state.reactionGoAt = Date.now();
      state.totalMs = TIME.reaction * 1000;
      state.deadline = state.reactionGoAt + state.totalMs;
      broadcast();
      timer = setTimeout(showResult, state.totalMs);
    }, delay);
    return;
  }

  if (state.mode === 'imposter') {
    const pair = DATA.imposter[state.order[state.idx]];
    const wA = pair.a ?? pair[0], wB = pair.b ?? pair[1];
    const ids = Object.keys(players);
    const impCount = ids.length >= 7 ? 2 : 1;
    state.imposterIds = shuffle(ids).slice(0, impCount);
    state.imposterWords = Math.random() < 0.5 ? [wA, wB] : [wB, wA];
    state.phase = 'discuss';
    state.deadline = 0;
    state.totalMs = 0;
    broadcast();
    return;
  }

  if (state.mode === 'draw') {
    if (!state.drawerName) state.drawerName = pickNextActor('draw');
    const item = DATA.draw[state.order[state.idx]];
    state.drawWord = item.w ?? item;
    state.phase = 'question';
    state.totalMs = roundTimeMs('draw');
    state.deadline = Date.now() + state.totalMs;
    io.to(ROOM_CHAN).emit('draw:clear');
    broadcast();
    timer = setTimeout(showResult, state.totalMs);
    return;
  }

  if (m === 'taboo') {
    if (!state.explainerName) state.explainerName = pickNextActor('taboo');
    const item = DATA.taboo[playedIdx];
    state.tabooWord = item.word;
    state.tabooForbidden = item.taboo || [];
    state.phase = 'question';
    state.totalMs = roundTimeMs('taboo');
    state.deadline = Date.now() + state.totalMs;
    broadcast();
    timer = setTimeout(showResult, state.totalMs);
    return;
  }

  if (m === 'sort') {
    state.sortOrder = shuffle([0, 1, 2, 3]);
    state.phase = 'question';
    state.totalMs = roundTimeMs('sort');
    state.deadline = displayMode === 'onedevice' ? 0 : Date.now() + state.totalMs;
    broadcast();
    if (displayMode !== 'onedevice') timer = setTimeout(showResult, state.totalMs);
    return;
  }

  if (m === 'songquiz') {
    const song = DATA.songs[playedIdx];
    const meta = await fetchSongPreview(song);
    if (seq !== roundSeq || activeMode() !== 'songquiz') return;
    state.songQ = buildSongQuestion(song, meta);
    state.phase = 'question';
    state.songStarted = false;
    state.roundStartedAt = Date.now();
    state.totalMs = roundTimeMs('songquiz');
    state.deadline = displayMode === 'onedevice' ? 0 : state.roundStartedAt + state.totalMs;
    broadcast();
    if (displayMode !== 'onedevice') timer = setTimeout(showResult, state.totalMs);
    return;
  }

  state.phase = 'question';
  state.totalMs = roundTimeMs(m);
  state.deadline = displayMode === 'onedevice' ? 0 : Date.now() + state.totalMs;
  broadcast();
  if (displayMode !== 'onedevice') timer = setTimeout(showResult, state.totalMs);
}

function startImposterVote() {
  skipVotes.clear();
  if (state.mode !== 'imposter' || state.phase !== 'discuss') return;
  clearTimeout(timer);
  pVals().forEach(p => { p.answer = null; });
  state.phase = 'question';
  state.totalMs = roundTimeMs('imposter');
  state.deadline = displayMode === 'onedevice' ? 0 : Date.now() + state.totalMs;
  broadcast();
  if (displayMode !== 'onedevice') timer = setTimeout(showResult, state.totalMs);
}

function showResult() {
  clearTimeout(timer);
  skipVotes.clear();
  if (state.phase !== 'question' && state.phase !== 'go' && state.phase !== 'wait') return;
  state.paused = false;
  state.pausedLeft = 0;
  const ps = pVals();
  const m = activeMode();
  const mult = isFinalRound() ? 2 : 1;
  const qIdx = state.mode === 'mix' ? state.subIdx : state.order[state.idx];
  let autoNextMs = 7000;

  if (m === 'quiz' || m === 'imagequiz') {
    const q = DATA[m][qIdx];
    ps.forEach(p => {
      if (p.answer === q.c) {
        const left = Math.max(0, state.deadline - p.answeredAt) / (TIME[m] * 1000);
        p.score += (500 + Math.round(500 * left)) * mult;
      }
    });
    const counts = q.a.map((_, i) => ps.filter(p => p.answer === i).length);
    state.result = { correct: q.c, counts };
  } else if (m === 'mostlikely') {
    const counts = Object.fromEntries(ps.map(p => [p.name, 0]));
    ps.forEach(p => { if (typeof p.answer === 'string' && counts[p.answer] !== undefined) counts[p.answer]++; });
    const votes = Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    const max = votes[0]?.count || 0;
    const winners = max > 0 ? votes.filter(v => v.count === max).map(v => v.name) : [];
    ps.forEach(p => { if (winners.includes(p.name)) { p.drinks++; p.score++; } });
    state.result = { votes, winners, max };
  } else if (m === 'wouldyourather') {
    const aNames = ps.filter(p => p.answer === 0).map(p => p.name);
    const bNames = ps.filter(p => p.answer === 1).map(p => p.name);
    const none = ps.filter(p => p.answer === null).map(p => p.name);
    let drinkers = [...none];
    let loser = 'none';
    if (aNames.length && bNames.length) {
      if (aNames.length < bNames.length) { loser = 'A'; drinkers.push(...aNames); }
      else if (bNames.length < aNames.length) { loser = 'B'; drinkers.push(...bNames); }
      else { loser = 'tie'; drinkers.push(...aNames, ...bNames); }
    } else if (aNames.length === 0 && bNames.length > 0) {
      loser = 'none';
    }
    ps.forEach(p => { if (drinkers.includes(p.name)) p.drinks++; });
    state.result = { aNames, bNames, loser, drinkers };
  } else if (m === 'estimate') {
    const item = DATA.estimate[qIdx];
    const entries = ps.map(p => ({
      name: p.name,
      val: typeof p.answer === 'number' ? p.answer : null,
      diff: typeof p.answer === 'number' ? Math.abs(p.answer - item.answer) : Infinity,
    })).sort((a, b) => a.diff - b.diff);
    const valid = entries.filter(e => e.val !== null);
    const best = valid[0]?.name || null;
    const worst = entries.length > 1 ? entries[entries.length - 1].name : null;
    ps.forEach(p => {
      if (p.name === best) {
        p.score += 1000 * mult;
        if (p.stats) p.stats.bestEstimate++;
      }
      if (p.name === worst || p.answer === null) p.drinks++;
    });
    state.result = { answer: item.answer, unit: item.unit, entries, best, worst };
    autoNextMs = 8000;
  } else if (m === 'reaction') {
    const entries = ps.map(p => ({ name: p.name, ms: p.answer }))
      .sort((a, b) => {
        const av = a.ms > 0 ? a.ms : Infinity;
        const bv = b.ms > 0 ? b.ms : Infinity;
        return av - bv;
      });
    const valid = entries.filter(e => e.ms > 0);
    const fastest = valid[0]?.name || null;
    const drinkers = entries.filter(e => e.ms === -1 || e.ms === null).map(e => e.name);
    if (valid.length > 1 && drinkers.length === 0) drinkers.push(valid[valid.length - 1].name);
    ps.forEach(p => {
      if (p.name === fastest) p.score += 1000 * mult;
      if (p.answer > 0 && p.stats) { p.stats.fastSum += p.answer; p.stats.fastCount++; }
      if (drinkers.includes(p.name)) p.drinks++;
    });
    state.result = { entries, fastest, drinkers };
  } else if (m === 'neverhavei') {
    const yes = ps.filter(p => p.answer === true).map(p => p.name);
    const no = ps.filter(p => p.answer === false).map(p => p.name);
    ps.forEach(p => { if (p.answer === true) { p.drinks++; p.score++; } });
    state.result = { yes, no };
  } else if (m === 'imposter') {
    const counts = Object.fromEntries(ps.map(p => [p.name, 0]));
    ps.forEach(p => { if (typeof p.answer === 'string' && counts[p.answer] !== undefined) counts[p.answer]++; });
    const votes = Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    const max = votes[0]?.count || 0;
    const accused = max > 0 ? votes.filter(v => v.count === max).map(v => v.name) : [];
    const imposters = state.imposterIds.map(id => players[id]?.name).filter(Boolean);
    const caught = imposters.some(n => accused.includes(n));
    const drinkers = caught ? imposters : ps.map(p => p.name).filter(n => !imposters.includes(n));
    ps.forEach(p => {
      if (drinkers.includes(p.name)) p.drinks++;
      if ((caught && !imposters.includes(p.name)) || (!caught && imposters.includes(p.name))) p.score += 1000 * mult;
    });
    state.result = { accused, imposters, words: state.imposterWords, caught, drinkers, votes };
    autoNextMs = 9000;
  } else if (m === 'draw') {
    const nonDrawers = ps.filter(p => p.name !== state.drawerName);
    const drinkers = nonDrawers.filter(p => !state.guessedBy.includes(p.name)).map(p => p.name);
    if (state.guessedBy.length === 0 && state.drawerName) drinkers.push(state.drawerName);
    ps.forEach(p => { if (drinkers.includes(p.name)) p.drinks++; });
    state.result = { word: state.drawWord, drawer: state.drawerName, guessedBy: state.guessedBy, drinkers };
  } else if (m === 'taboo') {
    const nonExplainers = ps.filter(p => p.name !== state.explainerName);
    const drinkers = nonExplainers.filter(p => !state.tabooGuessedBy.includes(p.name)).map(p => p.name);
    if (state.tabooGuessedBy.length === 0 && state.explainerName) drinkers.push(state.explainerName);
    ps.forEach(p => { if (drinkers.includes(p.name)) p.drinks++; });
    state.result = { word: state.tabooWord, explainer: state.explainerName, guessedBy: state.tabooGuessedBy, drinkers };
  } else if (m === 'sort') {
    const item = DATA.sort[qIdx];
    const entries = ps.map(p => {
      let hits = 0;
      if (Array.isArray(p.answer) && p.answer.length === 4) {
        for (let k = 0; k < 4; k++) {
          if (state.sortOrder[p.answer[k]] === k) hits++;
        }
      }
      const left = p.answeredAt ? Math.max(0, state.deadline - p.answeredAt) / (TIME.sort * 1000) : 0;
      const pts = Array.isArray(p.answer) ? (hits * 200 + (hits === 4 ? 400 + Math.round(200 * left) : 0)) * mult : 0;
      p.score += pts;
      return { name: p.name, hits, pts, answered: Array.isArray(p.answer) };
    }).sort((a, b) => b.pts - a.pts || b.hits - a.hits);
    const drinkers = entries.filter(e => !e.answered || e.hits < 2).map(e => e.name);
    ps.forEach(p => { if (drinkers.includes(p.name)) p.drinks++; });
    state.result = { items: item.items, entries, drinkers };
    autoNextMs = 8500;
  } else if (m === 'icebreaker') {
    const entries = shuffle(
      ps
        .map(p => (typeof p.answer === 'string' && p.answer.trim() ? { text: p.answer.trim() } : null))
        .filter(Boolean)
    );
    const drinkers = ps
      .filter(p => !(typeof p.answer === 'string' && p.answer.trim()))
      .map(p => p.name);
    ps.forEach(p => {
      if (typeof p.answer === 'string' && p.answer.trim()) p.score += 500 * mult;
      else p.drinks++;
    });
    state.result = { entries, drinkers };
    autoNextMs = 0;
  } else if (m === 'teams') {
    const item = DATA.teams[qIdx];
    const groups = item.a.map((_, i) => ps.filter(p => p.answer === i).map(p => p.name));
    const nonEmpty = groups.map((g, i) => ({ i, len: g.length })).filter(x => x.len > 0);
    const minLen = nonEmpty.length ? Math.min(...nonEmpty.map(x => x.len)) : 0;
    const minGroups = nonEmpty.filter(x => x.len === minLen);
    const drinkers = ps.filter(p => p.answer === null).map(p => p.name);
    if (nonEmpty.length > 1 && minGroups.length === 1) {
      drinkers.push(...groups[minGroups[0].i]);
    }
    ps.forEach(p => {
      if (p.answer !== null) p.score += 500 * mult;
      if (drinkers.includes(p.name)) p.drinks++;
    });
    state.result = { groups, drinkers };
    autoNextMs = 8000;
  } else if (m === 'scale') {
    const entries = ps.map(p => ({ name: p.name, val: typeof p.answer === 'number' ? p.answer : null }));
    const valid = entries.filter(e => e.val !== null);
    const avg = valid.length ? Math.round((valid.reduce((s, e) => s + e.val, 0) / valid.length) * 10) / 10 : null;
    const drinkers = entries.filter(e => e.val === null).map(e => e.name);
    ps.forEach(p => {
      if (typeof p.answer === 'number') p.score += 500 * mult;
      else p.drinks++;
    });
    state.result = { entries, avg, drinkers };
    autoNextMs = 8500;
  } else if (m === 'truthlie') {
    const guessers = ps.filter(p => p.name !== state.storytellerName);
    const caughtBy = guessers.filter(p => p.answer === state.tlLieIdx).map(p => p.name);
    const drinkers = guessers.filter(p => p.answer !== state.tlLieIdx).map(p => p.name);
    if (guessers.length > 0 && caughtBy.length === guessers.length && state.storytellerName) {
      drinkers.push(state.storytellerName);
    }
    ps.forEach(p => {
      if (p.name === state.storytellerName) {
        if (caughtBy.length === 0 && guessers.length > 0) p.score += 1000 * mult;
      } else if (p.answer === state.tlLieIdx) {
        p.score += 800 * mult;
      }
      if (drinkers.includes(p.name)) p.drinks++;
    });
    const counts = state.tlStatements.map((_, i) => guessers.filter(p => p.answer === i).length);
    state.result = { lieIdx: state.tlLieIdx, caughtBy, drinkers, counts, storyteller: state.storytellerName };
    autoNextMs = 9000;
  } else if (m === 'wordassoc') {
    const entries = ps.map(p => ({
      name: p.name,
      avatar: p.avatar || '😎',
      word: typeof p.answer === 'string' && p.answer.trim() ? p.answer.trim() : null,
    }));
    ps.forEach(p => { if (typeof p.answer === 'string' && p.answer.trim()) p.score += 500 * mult; });
    state.result = { entries };
    autoNextMs = 8000;
  } else if (m === 'songquiz') {
    const sq = state.songQ;
    ps.forEach(p => {
      if (p.answer === sq.c) {
        const left = Math.max(0, state.deadline - p.answeredAt) / (TIME.songquiz * 1000);
        p.score += (500 + Math.round(500 * left)) * mult;
      }
    });
    const counts = sq.a.map((_, i) => ps.filter(p => p.answer === i).length);
    state.result = { correct: sq.c, counts, artist: sq.artist, title: sq.title, year: sq.year, type: sq.type, art: sq.art };
    autoNextMs = 12000;
    if (state.mode === 'songquiz' && state.idx + 1 < totalRounds() && DATA.songs[state.order[state.idx + 1]]) {
      fetchSongPreview(DATA.songs[state.order[state.idx + 1]]).catch(() => {});
    }
  }

  ps.forEach(p => {
    const gain = (p.score || 0) - (p.prevScore ?? p.score ?? 0);
    p.lastGain = Math.max(0, gain);
    if (['quiz', 'imagequiz', 'songquiz', 'estimate', 'reaction', 'imposter', 'draw', 'taboo', 'truthlie', 'sort'].includes(m)) {
      const wonRound = m === 'sort' ? gain >= 500 : gain > 0;
      p.streak = wonRound ? (p.streak || 0) + 1 : 0;
    }
  });

  if (state.mission && !state.mission.resolved) autoNextMs = 0;
  state.phase = 'result';
  state.totalMs = autoNextMs;
  state.deadline = autoNextMs > 0 ? Date.now() + autoNextMs : 0;
  broadcast();
  if (autoNextMs > 0) timer = setTimeout(nextRound, autoNextMs);
}



function validateAnswer(m, val) {
  if (m === 'mostlikely' || m === 'imposter') {
    return typeof val === 'string' && pVals().some(x => x.name === val) ? { ok: true, val } : { ok: false };
  }
  if (m === 'estimate') {
    const n = Number(val);
    return Number.isFinite(n) ? { ok: true, val: n } : { ok: false };
  }
  if (m === 'scale') {
    const n = Math.round(Number(val));
    return Number.isFinite(n) && n >= 1 && n <= 10 ? { ok: true, val: n } : { ok: false };
  }
  if (m === 'neverhavei') return typeof val === 'boolean' ? { ok: true, val } : { ok: false };
  if (m === 'quiz' || m === 'imagequiz' || m === 'wouldyourather' || m === 'teams' || m === 'truthlie' || m === 'songquiz') {
    return Number.isInteger(val) && val >= 0 && val < 8 ? { ok: true, val } : { ok: false };
  }
  if (m === 'sort') {
    if (!Array.isArray(val) || val.length !== 4) return { ok: false };
    const clean = val.map(Number);
    return [0, 1, 2, 3].every(i => clean.includes(i)) ? { ok: true, val: clean } : { ok: false };
  }
  if (m === 'icebreaker' || m === 'wordassoc') {
    if (typeof val !== 'string') return { ok: false };
    const s = val.trim().slice(0, m === 'wordassoc' ? 30 : 120);
    return s ? { ok: true, val: s } : { ok: false };
  }
  return { ok: false };
}

function submitPlayerAnswer(p, val) {
  const m = activeMode();
  if (state.phase !== 'question') return false;
  if (m === 'truthlie' && p.name === state.storytellerName) return false;
  const res = validateAnswer(m, val);
  if (!res.ok) return false;
  p.answer = res.val;
  p.answeredAt = Date.now();
  broadcast();
  const waiters = m === 'truthlie' ? pVals().filter(x => x.name !== state.storytellerName) : pVals();
  if (waiters.length > 0 && waiters.every(x => x.answer !== null)) showResult();
  return true;
}

function attachSocket(socket, ip, allowEvent) {
  roomSockets.add(socket.id);
  socket.join(ROOM_CHAN);
  lastActivity = Date.now();

  socket.emit('state', pub());
  socket.emit('info', { url: publicUrl, room: code });
  if (state.mode === 'draw' && state.strokes.length) socket.emit('draw:history', state.strokes);

  socket.on('join', (payload, ack) => {
    if (!allowEvent('join', 30_000, 10)) return ack && ack({ ok: false, error: 'Zu viele Versuche, kurz warten' });
    const rawName = typeof payload === 'object' && payload ? payload.name : payload;
    const rawAvatar = typeof payload === 'object' && payload && payload.avatar ? String(payload.avatar).slice(0, 4) : '😎';
    const clientToken = typeof payload === 'object' && payload && payload.reconnectToken ? String(payload.reconnectToken) : '';
    const name = String(rawName || '').trim().slice(0, 16);
    if (!name) return ack && ack({ ok: false, error: 'Name fehlt' });
    const existing = Object.entries(players).find(([, p]) => p.name.toLowerCase() === name.toLowerCase());
    if (existing && existing[0] !== socket.id) return ack && ack({ ok: false, error: 'Name schon vergeben' });
    if (Object.keys(players).length >= MAX_PLAYERS && !players[socket.id])
      return ack && ack({ ok: false, error: 'Spiel ist voll' });
    let token;
    if (players[socket.id]) {
      players[socket.id].avatar = rawAvatar;
      token = players[socket.id].reconnectToken || crypto.randomBytes(16).toString('base64url');
      players[socket.id].reconnectToken = token;
    } else {
      const saved = disconnectedPlayers.get(name.toLowerCase());
      if (saved) {
        if (saved.data.reconnectToken && clientToken !== saved.data.reconnectToken) {
          return ack && ack({ ok: false, error: 'Name ist noch kurz reserviert' });
        }
        clearTimeout(saved.timer);
        disconnectedPlayers.delete(name.toLowerCase());
        token = saved.data.reconnectToken || crypto.randomBytes(16).toString('base64url');
        players[socket.id] = { ...saved.data, name, avatar: rawAvatar, reconnectToken: token, answer: null, answeredAt: 0 };
        writeLog('INFO', 'player_rejoined', { name, socketId: socket.id, score: players[socket.id].score });
      } else {
        token = crypto.randomBytes(16).toString('base64url');
        players[socket.id] = { name, avatar: rawAvatar, reconnectToken: token, team: null, score: 0, drinks: 0, answer: null, answeredAt: 0, stats: { fastSum: 0, fastCount: 0, bestEstimate: 0, guessedWords: 0 } };
        writeLog('INFO', 'player_joined', { name, socketId: socket.id });
      }
    }
    ack && ack({ ok: true, reconnectToken: token });
    broadcast();
  });

  socket.on('player:team', teamId => {
    if (!allowEvent('team', 10_000, 20)) return;
    const p = players[socket.id];
    if (!p || !TEAMS.some(t => t.id === teamId)) return;
    p.team = teamId;
    broadcast();
  });

  socket.on('player:skipVote', () => {
    if (!allowEvent('skipVote', 4_000, 10)) return;
    if (!['question', 'go', 'write', 'discuss', 'result'].includes(state.phase) || displayMode === 'onedevice') return;
    const p = players[socket.id];
    if (!p) return;
    const key = p.name.toLowerCase();
    if (skipVotes.has(key)) skipVotes.delete(key);
    else skipVotes.add(key);
    const ps = pVals();
    const needed = Math.max(1, Math.ceil(ps.length * 0.65));
    const activeCount = Array.from(skipVotes).filter(n => ps.some(pl => pl.name.toLowerCase() === n)).length;
    if (activeCount >= needed) {
      writeLog('INFO', 'skip_vote_triggered', { phase: state.phase, activeCount, needed, total: ps.length });
      if (state.phase === 'discuss') startImposterVote();
      else if (state.phase === 'write' || state.phase === 'result') nextRound();
      else showResult();
    } else {
      broadcast();
    }
  });

  socket.on('player:react', emoji => {
    if (!allowEvent('react', 4_000, 14)) return;
    const allowed = ['😂', '🔥', '💀', '🤡', '🍻', '🎉', '❤️'];
    if (!allowed.includes(emoji)) return;
    const p = players[socket.id];
    io.emit('react', {
      name: p ? p.name : '',
      avatar: p ? (p.avatar || '😎') : '🎉',
      emoji,
    });
  });

  socket.on('answer', val => {
    if (!allowEvent('answer', 10_000, 20)) return;
    const p = players[socket.id];
    if (!p || state.paused) return;

    const m = activeMode();
    if (m === 'reaction') {
      if (p.answer !== null) return;
      if (state.phase === 'wait') { p.answer = -1; broadcast(); }
      else if (state.phase === 'go') { p.answer = Math.max(1, Date.now() - state.reactionGoAt); broadcast(); }
      if ((state.phase === 'go' || state.phase === 'wait') && pVals().every(x => x.answer !== null)) {
        if (state.phase === 'go') showResult();
      }
      return;
    }

    if (state.phase !== 'question') return;
    submitPlayerAnswer(p, val);
  });

  socket.on('truthlie:submit', (arr, ack) => {
    if (!allowEvent('truthlie', 10_000, 10)) return;
    const p = players[socket.id];
    if (!p || activeMode() !== 'truthlie' || state.phase !== 'write' || p.name !== state.storytellerName) return;
    if (!Array.isArray(arr) || arr.length !== 3) return ack && ack({ ok: false });
    const clean = arr.map(s => String(s || '').trim().slice(0, 90));
    if (clean.some(s => !s)) return ack && ack({ ok: false });
    const items = shuffle([
      { text: clean[0], isLie: false },
      { text: clean[1], isLie: false },
      { text: clean[2], isLie: true },
    ]);
    state.tlStatements = items;
    state.tlLieIdx = items.findIndex(x => x.isLie);
    state.phase = 'question';
    state.totalMs = roundTimeMs('truthlie');
    state.deadline = Date.now() + state.totalMs;
    ack && ack({ ok: true });
    broadcast();
    timer = setTimeout(showResult, state.totalMs);
  });

  socket.on('song:playing', idx => {
    if (!allowEvent('songPlay', 5_000, 10)) return;
    if (activeMode() !== 'songquiz' || state.phase !== 'question' || state.paused || state.songStarted) return;
    if (idx !== state.idx || displayMode === 'onedevice') return;
    state.songStarted = true;
    const elapsed = Date.now() - state.roundStartedAt;
    if (elapsed > 150 && elapsed < 4000) {
      clearTimeout(timer);
      state.totalMs = roundTimeMs('songquiz');
      state.deadline = Date.now() + state.totalMs;
      broadcast();
      timer = setTimeout(showResult, state.totalMs);
    }
  });

  socket.on('draw:stroke', seg => {
    if (!allowEvent('stroke', 2_000, 150)) return;
    const p = players[socket.id];
    if (!p || state.mode !== 'draw' || state.phase !== 'question' || p.name !== state.drawerName) return;
    if (!seg || typeof seg !== 'object') return;
    const { x0, y0, x1, y1, c, w } = seg;
    if (![x0, y0, x1, y1].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return;
    const cleanSeg = {
      x0, y0, x1, y1,
      c: STROKE_COLORS.has(c) ? c : '#111',
      w: typeof w === 'number' && Number.isFinite(w) ? Math.min(12, Math.max(1, w)) : 6,
    };
    state.strokes.push(cleanSeg);
    if (state.strokes.length > 4000) state.strokes.shift();
    socket.broadcast.emit('draw:stroke', cleanSeg);
  });

  socket.on('draw:clear', () => {
    if (!allowEvent('clear', 5_000, 10)) return;
    const p = players[socket.id];
    if (!p || state.mode !== 'draw' || state.phase !== 'question' || p.name !== state.drawerName) return;
    state.strokes = [];
    io.emit('draw:clear');
  });

  socket.on('draw:guess', (txt, ack) => {
    if (!allowEvent('guess', 10_000, 15)) return ack && ack({ ok: false });
    const p = players[socket.id];
    if (!p || state.mode !== 'draw' || state.phase !== 'question' || p.name === state.drawerName) return;
    if (state.guessedBy.includes(p.name)) return;
    if (norm(txt) && norm(txt) === norm(state.drawWord)) {
      state.guessedBy.push(p.name);
      const mult = isFinalRound() ? 2 : 1;
      const pts = Math.max(200, 1000 - (state.guessedBy.length - 1) * 200) * mult;
      p.score += pts;
      if (p.stats) p.stats.guessedWords++;
      const drawer = pVals().find(x => x.name === state.drawerName);
      if (drawer && state.guessedBy.length === 1) drawer.score += 500 * mult;
      p.answer = true;
      p.answeredAt = Date.now();
      ack && ack({ ok: true });
      broadcast();
      const nonDrawers = pVals().filter(x => x.name !== state.drawerName);
      if (nonDrawers.length > 0 && nonDrawers.every(x => state.guessedBy.includes(x.name))) showResult();
    } else {
      io.emit('draw:msg', { name: p.name, text: String(txt || '').slice(0, 30) });
      ack && ack({ ok: false });
    }
  });

  socket.on('taboo:guess', (txt, ack) => {
    if (!allowEvent('tabooGuess', 10_000, 20)) return ack && ack({ ok: false });
    const p = players[socket.id];
    if (!p || activeMode() !== 'taboo' || state.phase !== 'question' || p.name === state.explainerName) return;
    if (state.tabooGuessedBy.includes(p.name)) return;
    if (norm(txt) && norm(txt) === norm(state.tabooWord)) {
      state.tabooGuessedBy.push(p.name);
      const mult = isFinalRound() ? 2 : 1;
      const pts = Math.max(200, 1000 - (state.tabooGuessedBy.length - 1) * 200) * mult;
      p.score += pts;
      if (p.stats) p.stats.guessedWords++;
      const exp = pVals().find(x => x.name === state.explainerName);
      if (exp && state.tabooGuessedBy.length === 1) exp.score += 500 * mult;
      p.answer = true;
      p.answeredAt = Date.now();
      ack && ack({ ok: true });
      broadcast();
      const nonExplainers = pVals().filter(x => x.name !== state.explainerName);
      if (nonExplainers.length > 0 && nonExplainers.every(x => state.tabooGuessedBy.includes(x.name))) showResult();
    } else {
      ack && ack({ ok: false });
    }
  });

  // One-Device (Pass & Play) Steuerung
  let localCounter = 0;
  socket.on('local:addPlayer', (payload, ack) => {
    if (!allowEvent('localAdd', 10_000, 20)) return ack && ack({ ok: false, error: 'Bitte kurz warten' });
    if (displayMode !== 'onedevice') return ack && ack({ ok: false, error: 'Nicht im Ein-Gerät-Modus' });
    const name = String(payload?.name || '').trim().slice(0, 16);
    const avatar = payload?.avatar ? String(payload.avatar).slice(0, 4) : '😎';
    if (!name) return ack && ack({ ok: false, error: 'Name fehlt' });
    if (pVals().some(p => p.name.toLowerCase() === name.toLowerCase())) return ack && ack({ ok: false, error: 'Name schon vergeben' });
    if (Object.keys(players).length >= MAX_PLAYERS) return ack && ack({ ok: false, error: 'Max. 12 Spieler' });
    const id = `local:${Date.now()}:${++localCounter}`;
    players[id] = { name, avatar, team: null, score: 0, drinks: 0, answer: null, answeredAt: 0, stats: { fastSum: 0, fastCount: 0, bestEstimate: 0, guessedWords: 0 }, isLocal: true };
    ack && ack({ ok: true });
    broadcast();
  });
  socket.on('local:removePlayer', name => {
    if (displayMode !== 'onedevice') return;
    for (const [id, p] of Object.entries(players)) {
      if (p.name === name && p.isLocal) delete players[id];
    }
    broadcast();
  });
  socket.on('local:team', ({ name, teamId } = {}) => {
    if (displayMode !== 'onedevice' || !TEAMS.some(t => t.id === teamId)) return;
    const p = pVals().find(x => x.name === name);
    if (p) { p.team = teamId; broadcast(); }
  });
  socket.on('local:answer', ({ name, val } = {}) => {
    if (displayMode !== 'onedevice' || state.paused) return;
    const p = pVals().find(x => x.name === name);
    if (p) submitPlayerAnswer(p, val);
  });
  socket.on('local:truthlie', ({ name, arr } = {}, ack) => {
    if (displayMode !== 'onedevice' || activeMode() !== 'truthlie' || state.phase !== 'write' || name !== state.storytellerName) return;
    if (!Array.isArray(arr) || arr.length !== 3) return ack && ack({ ok: false });
    const clean = arr.map(s => String(s || '').trim().slice(0, 90));
    if (clean.some(s => !s)) return ack && ack({ ok: false });
    const items = shuffle([
      { text: clean[0], isLie: false },
      { text: clean[1], isLie: false },
      { text: clean[2], isLie: true },
    ]);
    state.tlStatements = items;
    state.tlLieIdx = items.findIndex(x => x.isLie);
    state.phase = 'question';
    state.deadline = 0;
    ack && ack({ ok: true });
    broadcast();
  });
  socket.on('local:getSecret', (name, ack) => {
    if (displayMode !== 'onedevice') return ack && ack(null);
    const entry = Object.entries(players).find(([, p]) => p.name === name);
    if (!entry) return ack && ack(null);
    const [id] = entry;
    const m = activeMode();
    if (m === 'imposter' && state.imposterWords) {
      return ack && ack({ word: state.imposterIds.includes(id) ? state.imposterWords[1] : state.imposterWords[0] });
    }
    if (m === 'draw' && name === state.drawerName) {
      return ack && ack({ word: state.drawWord });
    }
    if (m === 'taboo' && name === state.explainerName) {
      return ack && ack({ word: state.tabooWord, taboo: state.tabooForbidden });
    }
    ack && ack(null);
  });
  socket.on('local:wordGuessed', winnerName => {
    if (displayMode !== 'onedevice' || state.phase !== 'question') return;
    const m = activeMode();
    if (m !== 'draw' && m !== 'taboo') return;
    if (!winnerName) return showResult();
    const p = pVals().find(x => x.name === winnerName);
    if (!p) return;
    const mult = isFinalRound() ? 2 : 1;
    if (m === 'draw' && !state.guessedBy.includes(p.name)) {
      state.guessedBy.push(p.name);
      p.score += 1000 * mult;
      if (p.stats) p.stats.guessedWords++;
      const drawer = pVals().find(x => x.name === state.drawerName);
      if (drawer) drawer.score += 500 * mult;
    } else if (m === 'taboo' && !state.tabooGuessedBy.includes(p.name)) {
      state.tabooGuessedBy.push(p.name);
      p.score += 1000 * mult;
      if (p.stats) p.stats.guessedWords++;
      const exp = pVals().find(x => x.name === state.explainerName);
      if (exp) exp.score += 500 * mult;
    }
    showResult();
  });

  socket.on('host:auth', (secret, ack) => {
    const now = Date.now();
    let fail = hostAuthFails.get(ip);
    if (fail && now > fail.resetAt) { hostAuthFails.delete(ip); fail = null; }
    if (fail && fail.count >= 5) return ack && ack({ ok: false, error: 'Zu viele Fehlversuche' });
    if (!validHostSecret(secret) && !validRoomToken(secret)) {
      fail = fail || { count: 0, resetAt: now + 60_000 };
      fail.count++;
      hostAuthFails.set(ip, fail);
      writeLog('WARN', 'host_auth_failed', { ip, socketId: socket.id });
      return ack && ack({ ok: false, error: 'Ungültiger Host-PIN' });
    }
    hostAuthFails.delete(ip);
    socket.data.isHost = true;
    writeLog('INFO', 'host_authenticated', { ip, socketId: socket.id });
    ack && ack({ ok: true });
  });

  const requireHost = () => socket.data.isHost || displayMode === 'onedevice';

  // Host / Admin Steuerung
  socket.on('host:mode', m => {
    if (!MODES.includes(m)) return;
    clearTimeout(timer);
    pendingSpinNext = null;
    roundSeq++;
    state = freshState(m);
    broadcast();
  });
  socket.on('host:categories', cats => {
    if (!Array.isArray(cats)) return;
    const valid = [...new Set(cats.filter(c => CATEGORIES.includes(c)))];
    if (!valid.length) return;
    activeCategories = valid;
    broadcast();
  });
  socket.on('host:rounds', n => {
    const val = Number(n);
    if ([0, 5, 10, 15].includes(val)) {
      roundLimit = val;
      broadcast();
    }
  });
  socket.on('host:teamMode', on => {
    teamMode = !!on;
    broadcast();
  });
  socket.on('host:displayMode', m => {
    if (!['tv', 'notv', 'onedevice'].includes(m)) return;
    if (displayMode === 'onedevice' && m !== 'onedevice') {
      for (const [id, p] of Object.entries(players)) { if (p.isLocal) delete players[id]; }
    }
    displayMode = m;
    broadcast();
  });
  socket.on('host:noTvMode', on => {
    if (displayMode === 'onedevice') {
      for (const [id, p] of Object.entries(players)) { if (p.isLocal) delete players[id]; }
    }
    displayMode = on ? 'notv' : 'tv';
    broadcast();
  });
  socket.on('host:songLang', ({ lang, on } = {}) => {
    if (lang !== 'en' && lang !== 'de') return;
    songLangs = { ...songLangs, [lang]: !!on };
    if (!songLangs.en && !songLangs.de && russianShare === 0) russianShare = 100;
    broadcast();
  });
  socket.on('host:imageQuizTheme', ({ theme, on } = {}) => {
    if (!['logos', 'landmarks', 'flags', 'cars'].includes(theme)) return;
    const set = new Set(imageQuizThemes);
    if (on) set.add(theme);
    else if (set.size > 1) set.delete(theme);
    imageQuizThemes = [...set];
    if (state.phase === 'lobby' && state.mode === 'imagequiz') {
      state.order = pickOrder('imagequiz');
    }
    broadcast();
  });
  socket.on('host:imageQuizThemes', arr => {
    if (!Array.isArray(arr)) return;
    const valid = [...new Set(arr.filter(t => ['logos', 'landmarks', 'flags', 'cars'].includes(t)))];
    if (!valid.length) return;
    imageQuizThemes = valid;
    if (state.phase === 'lobby' && state.mode === 'imagequiz') {
      state.order = pickOrder('imagequiz');
    }
    broadcast();
  });
  socket.on('host:russianShare', pct => {
    const val = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    russianShare = val;
    if (val === 0 && !songLangs.en && !songLangs.de) songLangs = { en: true, de: true };
    broadcast();
  });
  socket.on('host:russianSongs', on => {
    russianShare = on ? 50 : 0;
    broadcast();
  });
  socket.on('host:songDifficulty', onlyAT => {
    songOnlyArtistTitle = !!onlyAT;
    songKindQueue = [];
    broadcast();
  });
  socket.on('host:finalDouble', on => {
    finalDouble = !!on;
    broadcast();
  });
  socket.on('host:wheelEnabled', on => {
    wheelEnabled = !!on;
    broadcast();
  });
  socket.on('host:secretMissions', on => {
    secretMissions = !!on;
    if (!secretMissions) state.mission = null;
    broadcast();
  });
  socket.on('host:alcoholFree', on => {
    alcoholFree = !!on;
    broadcast();
  });
  socket.on('host:timerSpeed', sp => {
    if (TIMER_MULT[sp]) timerSpeed = sp;
    broadcast();
  });
  socket.on('host:mixRounds', n => {
    const val = Number(n);
    if ([8, 12, 16].includes(val)) mixRounds = val;
    broadcast();
  });
  socket.on('host:preset', preset => {
    if (preset === 'klassik') {
      activeCategories = ['party', 'peinlich', 'kennenlernen'];
      alcoholFree = false;
      timerSpeed = 'normal';
      secretMissions = false;
      if (state.phase === 'lobby') state = freshState('mix');
    } else if (preset === 'date') {
      activeCategories = ['date', 'kennenlernen'];
      alcoholFree = false;
      timerSpeed = 'relaxed';
      secretMissions = false;
      if (state.phase === 'lobby') state = freshState('icebreaker');
    } else if (preset === 'hot18') {
      activeCategories = ['peinlich', 'hot18'];
      alcoholFree = false;
      timerSpeed = 'normal';
      secretMissions = true;
      if (state.phase === 'lobby') state = freshState('mix');
    } else if (preset === 'musik') {
      songLangs = { en: true, de: true };
      songOnlyArtistTitle = false;
      timerSpeed = 'normal';
      if (state.phase === 'lobby') state = freshState('songquiz');
    } else if (preset === 'alkoholfrei') {
      activeCategories = ['party', 'kennenlernen'];
      alcoholFree = true;
      timerSpeed = 'normal';
      if (state.phase === 'lobby') state = freshState('mix');
    }
    broadcast();
  });
  socket.on('host:resolveMission', ok => {
    if (!state.mission || state.mission.resolved) return;
    state.mission.resolved = true;
    state.mission.success = !!ok;
    if (ok && players[state.mission.playerId]) {
      players[state.mission.playerId].score += 150;
    }
    if (state.phase === 'result') {
      clearTimeout(timer);
      state.totalMs = 3500;
      state.deadline = Date.now() + 3500;
      broadcast();
      timer = setTimeout(nextRound, 3500);
    } else {
      broadcast();
    }
  });
  socket.on('host:spinWheel', kind => {
    if (!allowEvent('spinWheel', 10_000, 10)) return;
    clearTimeout(timer);
    pendingSpinNext = null;
    roundSeq++;
    if (kind === 'player') {
      const ps = pVals();
      if (!ps.length) return;
      const wIdx = crypto.randomInt(ps.length);
      const chosen = ps[wIdx];
      const lbl = `${chosen.avatar || '😎'} ${chosen.name}`;
      const curMode = state.mode;
      state = freshState(curMode);
      state.lobbyBanner = `🎯 Ausgelost: ${lbl}`;
      runSpinsThen([{
        id: ++spinSeq,
        kind: 'lobby-player',
        title: '🎡 Wer wird ausgelost?',
        subtitle: 'Zufalls-Spieler',
        items: ps.map(p => `${p.avatar || '😎'} ${p.name}`),
        winnerIdx: wIdx,
        winnerLabel: lbl,
        duration: SPIN_DURATION_MS,
      }], () => {
        state.phase = 'lobby';
        state.deadline = 0;
        broadcast();
      }, true);
    } else {
      const pool = MODES.filter(m => m !== 'mix');
      const wIdx = crypto.randomInt(pool.length);
      const chosenMode = pool[wIdx];
      const lbl = MODE_LABELS[chosenMode] || chosenMode;
      state = freshState(chosenMode);
      state.lobbyBanner = `🎰 Ausgelostes Spiel: ${lbl}`;
      runSpinsThen([{
        id: ++spinSeq,
        kind: 'lobby-mode',
        title: '🎰 Welches Spiel spielen wir?',
        subtitle: 'Zufalls-Spielauswahl',
        items: pool.map(k => MODE_LABELS[k] || k),
        winnerIdx: wIdx,
        winnerLabel: lbl,
        duration: SPIN_DURATION_MS,
      }], () => {
        state.phase = 'lobby';
        state.deadline = 0;
        broadcast();
      }, true);
    }
  });
  socket.on('host:mixModes', arr => {
    if (!Array.isArray(arr)) return;
    const valid = [...new Set(arr.filter(m => MIX_MODES_ALL.includes(m)))];
    if (valid.length < 2) return;
    mixModes = valid;
    broadcast();
  });
  socket.on('host:publicUrl', (rawUrl, ack) => {
    if (!allowEvent('pubUrl', 10_000, 10)) return ack && ack({ ok: false, error: 'Zu viele Anfragen' });
    const trimmed = String(rawUrl || '').trim().slice(0, 200);
    if (!trimmed) {
      publicUrl = DEFAULT_URL_PLAY;
      io.emit('info', { url: publicUrl });
      broadcast();
      return ack && ack({ ok: true, url: publicUrl });
    }
    try {
      const u = new URL(trimmed);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return ack && ack({ ok: false, error: 'Nur http:// oder https://' });
      publicUrl = u.toString();
      io.emit('info', { url: publicUrl });
      broadcast();
      ack && ack({ ok: true, url: publicUrl });
    } catch {
      ack && ack({ ok: false, error: 'Ungültige URL' });
    }
  });
  socket.on('host:addCustom', (payload, ack) => {
    if (!allowEvent('addCustom', 60_000, 20)) return ack && ack({ ok: false, error: 'Zu viele Einträge, kurz warten' });
    if (!payload || typeof payload !== 'object') return ack && ack({ ok: false });
    const mode = payload.mode;
    const cat = CATEGORIES.includes(payload.cat) ? payload.cat : 'party';
    let entry = null;
    if (mode === 'mostlikely') {
      const q = String(payload.q || '').trim().slice(0, 140);
      if (!q) return ack && ack({ ok: false, error: 'Frage fehlt' });
      entry = { q, cat };
    } else if (mode === 'wouldyourather') {
      const a = String(payload.a || '').trim().slice(0, 80);
      const b = String(payload.b || '').trim().slice(0, 80);
      if (!a || !b) return ack && ack({ ok: false, error: 'Beide Optionen ausfüllen' });
      entry = { a, b, cat };
    } else if (mode === 'taboo') {
      const word = String(payload.word || '').trim().slice(0, 40);
      const taboo = String(payload.taboo || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
      if (!word || taboo.length < 2) return ack && ack({ ok: false, error: 'Wort + min. 2 Tabu-Wörter (kommagetrennt)' });
      entry = { word, taboo, cat };
    } else {
      return ack && ack({ ok: false, error: 'Unbekannter Modus' });
    }
    DATA[mode].push(entry);
    try {
      let saved = {};
      if (fs.existsSync(CUSTOM_FILE)) saved = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')) || {};
      if (!Array.isArray(saved[mode])) saved[mode] = [];
      saved[mode].push(entry);
      fs.writeFile(CUSTOM_FILE, JSON.stringify(saved, null, 2), () => {});
    } catch {}
    broadcast();
    ack && ack({ ok: true });
  });
  socket.on('host:start', () => {
    if (state.phase === 'lobby' || state.phase === 'end') startGame();
  });
  socket.on('host:next', () => {
    state.paused = false;
    state.pausedLeft = 0;
    if (state.phase === 'spin' && pendingSpinNext) {
      clearTimeout(timer);
      const fn = pendingSpinNext;
      pendingSpinNext = null;
      state.spin = null;
      fn();
    } else if (state.phase === 'discuss') startImposterVote();
    else if (state.phase === 'write') nextRound();
    else if (state.phase === 'result') nextRound();
    else if (state.phase === 'question' || state.phase === 'go') showResult();
  });
  socket.on('host:pause', () => {
    if (!['question', 'go', 'result'].includes(state.phase)) return;
    if (!state.paused) {
      clearTimeout(timer);
      state.paused = true;
      state.pausedLeft = state.deadline > 0 ? Math.max(1000, state.deadline - Date.now()) : 0;
      state.deadline = 0;
    } else {
      state.paused = false;
      if (state.pausedLeft > 0) {
        state.deadline = Date.now() + state.pausedLeft;
        timer = setTimeout(state.phase === 'result' ? nextRound : showResult, state.pausedLeft);
      }
      state.pausedLeft = 0;
    }
    broadcast();
  });
  socket.on('host:reset', () => {
    clearTimeout(timer);
    pendingSpinNext = null;
    roundSeq++;
    state = freshState(state.mode);
    broadcast();
  });
  socket.on('host:kick', name => {
    if (name) {
      const saved = disconnectedPlayers.get(String(name).toLowerCase());
      if (saved) { clearTimeout(saved.timer); disconnectedPlayers.delete(String(name).toLowerCase()); }
    }
    for (const [id, p] of Object.entries(players)) {
      if (p.name === name) { delete players[id]; io.sockets.sockets.get(id)?.disconnect(true); }
    }
    broadcast();
  });

  socket.on('disconnect', (reason) => {
    roomSockets.delete(socket.id);
    lastActivity = Date.now();
    const p = players[socket.id];
    if (p) {
      const key = p.name.toLowerCase();
      const prev = disconnectedPlayers.get(key);
      if (prev) clearTimeout(prev.timer);
      const t = setTimeout(() => disconnectedPlayers.delete(key), 900_000);
      disconnectedPlayers.set(key, {
        data: { avatar: p.avatar, team: p.team, score: p.score, drinks: p.drinks, stats: p.stats, reconnectToken: p.reconnectToken },
        timer: t,
      });
      writeLog('INFO', 'player_disconnected', { name: p.name, socketId: socket.id, reason, recovered: socket.recovered });
      delete players[socket.id];
      broadcast();
    } else {
      writeLog('INFO', 'socket_disconnected', { socketId: socket.id, reason });
    }
  });
}

return {
  code,
  hostToken,
  getJoinUrl: () => publicUrl,
  getPlayerCount: () => Object.keys(players).length,
  getSummary: (now) => ({
    code,
    mode: state.mode,
    phase: state.phase,
    playerCount: Object.keys(players).length,
    players: pVals().map(p => p.name),
    sockets: roomSockets.size,
    idleMin: Math.floor((now - lastActivity) / 60_000),
  }),
  isIdleExpired: (now) => roomSockets.size === 0 && (now - lastActivity) > 30 * 60_000,
  attachSocket,
  destroy: () => {
    clearTimeout(timer);
    for (const d of disconnectedPlayers.values()) clearTimeout(d.timer);
    disconnectedPlayers.clear();
  },
};
} // end createRoom

const ipConnections = new Map(); // ip -> count
const MAX_CONNS_PER_IP = 25;

io.on('connection', socket => {
  const ip = getSocketIp(socket);
  const curConns = ipConnections.get(ip) || 0;
  if (curConns >= MAX_CONNS_PER_IP) {
    socket.disconnect(true);
    return;
  }
  ipConnections.set(ip, curConns + 1);
  socket.on('disconnect', () => {
    const c = ipConnections.get(ip) || 0;
    if (c <= 1) ipConnections.delete(ip);
    else ipConnections.set(ip, c - 1);
  });

  const eventLimits = new Map();
  const allowEvent = (key, windowMs, max) => {
    const now = Date.now();
    let e = eventLimits.get(key);
    if (!e || now > e.resetAt) {
      e = { count: 0, resetAt: now + windowMs };
      eventLimits.set(key, e);
    }
    e.count++;
    return e.count <= max;
  };

  const rawRoom = socket.handshake?.query?.room || socket.handshake?.auth?.room || '';
  const room = getRoom(rawRoom);
  if (!room) {
    socket.emit('room:error', { error: 'Raum nicht gefunden oder abgelaufen.' });
    return;
  }
  room.attachSocket(socket, ip, allowEvent);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`PartyGame v${APP_VERSION} läuft auf http://${HOST}:${PORT} (Multi-Room)`));

  process.on('uncaughtException', (err) => {
    writeLog('ERROR', 'uncaught_exception', { message: err?.message, stack: err?.stack });
  });

  process.on('unhandledRejection', (reason) => {
    writeLog('ERROR', 'unhandled_rejection', { reason: String(reason) });
  });

  function gracefulShutdown(signal) {
    let totalP = 0; for (const r of rooms.values()) totalP += r.getPlayerCount();
    writeLog('INFO', 'server_stopping', { signal, rooms: rooms.size, players: totalP });
    io.close(() => {
      server.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = {
  app,
  server,
  io,
  APP_VERSION,
  validHostSecret,
  createRateLimiter,
  createRoom,
  getRoom,
  rooms,
};
