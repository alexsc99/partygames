const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const os = require('os');
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { version: APP_VERSION } = require('./package.json');
const { writeLog } = require('./src/logger');
const { createPhotoStore, PHOTO_TTL_MS, PHOTO_MAX_BYTES } = require('./src/photos');
const {
  ALLOWED_ORIGINS,
  hostAuthFails,
  validHostSecret,
  checkHostAuth,
  isLocalDirectSocket,
  getClientIp,
  getSocketIp,
  isAllowedOrigin,
  createRateLimiter,
} = require('./src/security');

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
  pantomime: require('./data/pantomime.json'),
};
// Heißer Stuhl nutzt die Entweder-Oder-Paare („Was würde Alex lieber?“) – gleiches Array, eigene „schon gespielt“-Liste
DATA.hotseat = DATA.wouldyourather;
DATA.songs.forEach((s, i) => { s._idx = i; });
// Startversatz je Vorschau (scripts/analyze-song-starts.js): leise Intros/Stille überspringen
const SONG_STARTS = fs.existsSync(path.join(__dirname, 'data', 'song-starts.json')) ? require('./data/song-starts.json') : {};

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
} catch (err) {
  writeLog('WARN', 'custom_json_load_failed', { error: err?.message || String(err) });
}

const MODES = ['quiz', 'mostlikely', 'wouldyourather', 'estimate', 'reaction', 'neverhavei', 'imposter', 'draw', 'taboo', 'pantomime', 'sort', 'icebreaker', 'teams', 'scale', 'truthlie', 'wordassoc', 'songquiz', 'imagequiz', 'hotseat', 'mix'];
const MIX_MODES_ALL = ['quiz', 'mostlikely', 'wouldyourather', 'estimate', 'neverhavei', 'teams', 'scale', 'icebreaker', 'wordassoc', 'taboo', 'pantomime', 'sort', 'songquiz', 'imagequiz', 'hotseat'];
// Standard-Mix (auch für die Presets Klassik/18+/Alkoholfrei): ohne Kennenlernen, Wort-Assoziation & Skala – die bleiben manuell zuschaltbar
const DEFAULT_MIX_MODES = ['quiz', 'mostlikely', 'wouldyourather', 'estimate', 'neverhavei', 'teams', 'pantomime', 'hotseat'];
const IQ_THEMES = ['logos', 'landmarks', 'flags', 'cars', 'countries'];
// ---- Party-Karten: Aufgaben zwischen zwei Runden (Gruppe, Spitzenreiter, Letzter, Duell, Regel …) ----
const PARTY_CARDS = require('./data/partycards.json');
// Eigene Party-Karten aus /admin (global für alle Räume, nicht im Git – können Insider enthalten)
const CUSTOM_CARDS_FILE = path.join(__dirname, 'data', 'customcards.json');
const CUSTOM_CARD_TYPES = ['group', 'vote', 'duel', 'rule', 'snap', 'crowd'];
let CUSTOM_CARDS = [];
try {
  if (fs.existsSync(CUSTOM_CARDS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CUSTOM_CARDS_FILE, 'utf8'));
    if (Array.isArray(saved)) CUSTOM_CARDS = saved.filter(c => c && CUSTOM_CARD_TYPES.includes(c.type) && typeof c.text === 'string');
  }
} catch (err) {
  writeLog('WARN', 'customcards_load_failed', { error: err?.message || String(err) });
}
function saveCustomCards() {
  const tmp = `${CUSTOM_CARDS_FILE}.${process.pid}.tmp`;
  fs.writeFile(tmp, JSON.stringify(CUSTOM_CARDS, null, 2), err => {
    if (!err) fs.rename(tmp, CUSTOM_CARDS_FILE, e => e && writeLog('WARN', 'customcards_save_failed', { error: e.message }));
    else writeLog('WARN', 'customcards_save_failed', { error: err.message });
  });
}
const PARTY_CARD_GAP = { rare: 5, normal: 3, often: 2 }; // ungefährer Rundenabstand je Häufigkeit
const PARTY_CARD_TYPES = {
  group: { title: '🎉 Gruppen-Challenge', act: 'yesno', w: 3 },
  leader: { title: '👑 Kopfgeld', w: 1.5 },
  underdog: { title: '🆘 Underdog-Chance', w: 1.5 },
  vote: { title: '🎤 Reihum-Runde', act: 'vote', w: 2, min: 3 },
  pass: { title: '🔄 Weitergeben', act: 'info', w: 1, local: true }, // links/rechts → nur vor Ort
  duel: { title: '⚡ Blitz-Duell', act: 'duel', w: 2 },
  rule: { title: '📜 Neue Regel', act: 'rule', w: 1 },
  photo: { title: '📸 Foto & Pose', act: 'yesno', w: 1, local: true }, // who: 'group' (alle) oder 'pair' ({a} & {b}); seltener, damit nicht zu viele Foto-Aufgaben kommen
  snap: { title: '📸 Foto-Challenge', act: 'snap', w: 3, remote: true }, // jeder lädt ein Foto hoch, dann Abstimmung
  snapduel: { title: '📸 Foto-Duell', act: 'snap', w: 2, remote: true, min: 4 }, // nur {a} & {b} fotografieren, die anderen stimmen ab
  crowd: { title: '👥 Mitmach-Karte', act: 'info', w: 2 }, // „Alle mit Brille …“ – ohne Wertung, photo: true = Foto-Knöpfe am Handy
};
// Punkte bewusst klein (seit 3.19: 1/10 der früheren Werte), damit Spielstände nicht sofort vierstellig sind
const CARD_GROUP_PTS = 20;
const CARD_VOTE_PTS = 30;
const CARD_DUEL_PTS = 40;
const CARD_SNAP_PTS = 30; // bestes Foto
const CARD_SNAP_BONUS = 10; // jedes eingereichte Foto
const CARD_PHOTO_BONUS = 5; // Mitmach-Karte mit Foto-Aufgabe: erstes Foto pro Spieler
const CARD_RULE_ROUNDS = 3;
const CARD_AUTO_NEXT_MS = 6000;
// Statistik für die Auszeichnungen am Spielende; alte Spielstände (Neustart) haben nicht alle Felder → bumpStat
const freshStats = () => ({ fastSum: 0, fastCount: 0, bestEstimate: 0, guessedWords: 0, misses: 0, bestStreak: 0, cardPts: 0, snapVotes: 0 });
const bumpStat = (p, k, n = 1) => { if (p && p.stats) p.stats[k] = (p.stats[k] || 0) + n; };
const CARD_SKIP_DELAY_MS = 5000; // ab dann dürfen die Handys per „Weiter“-Abstimmung die Karte beenden
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
  pantomime: '🤸 Pantomime',
  sort: '🔢 Sortieren',
  icebreaker: '🫶 Kennenlernen',
  teams: '🏆 Team-Wahl',
  scale: '📊 Skala 1–10',
  truthlie: '🎭 Wahrheit/Lüge',
  wordassoc: '⚡ Wort-Assoz.',
  songquiz: '🎵 Song-Quiz',
  imagequiz: '🖼️ Bild-Quiz',
  hotseat: '🔥 Heißer Stuhl',
  mix: '🎲 Party-Mix',
};
const SPIN_DURATION_MS = 4200;
const MIX_ROUNDS = 12;
const MIX_ROUND_OPTIONS = [8, 12, 16, 20, 30, 50]; // Party-Mix: eigene Rundenzahl (Runden-Limit gilt dort nicht)
const ROUND_LIMITS = [0, 5, 10, 15, 20, 30, 50]; // 0 = Alle
const CATEGORIES = ['party', 'peinlich', 'kennenlernen', 'date', 'hot18'];
const TIME = { quiz: 20, mostlikely: 25, wouldyourather: 20, estimate: 25, reaction: 8, neverhavei: 20, imposter: 25, draw: 75, taboo: 60, pantomime: 60, sort: 30, icebreaker: 50, teams: 20, scale: 25, truthlie: 30, wordassoc: 18, songquiz: 25, imagequiz: 20, hotseat: 25 };
const MIME_SKIPS = 2; // so oft darf der Darsteller einen Begriff tauschen
const MIME_GUESS_PTS = 80; // Rater
const MIME_ACTOR_PTS = 50; // Darsteller
const MISSION_PTS = 15; // geheime Mission geschafft
// ---- Mehr Interaktion (alle in /admin abschaltbar) ----
const HOT_GUESS_PTS = 50; // Heißer Stuhl: richtig geraten, was die Person wählt
const HOT_SEAT_PTS = 10; // … die Person selbst pro richtigem Rater
const DISCUSS_MS = 15000; // „Wer würde?“/„Entweder-Oder“: erst diskutieren, dann abstimmen
const DISCUSS_MODES = ['mostlikely', 'wouldyourather'];
const STANDUP_MS = 10000; // „Ich hab noch nie“ als Aufsteh-Runde: kein Handy, nur aufstehen
// Kapitän (Teams) / Partner-Runde: ein Handy antwortet für die Gruppe, die Antwort zählt für alle
const GROUP_MODES = ['quiz', 'imagequiz', 'songquiz', 'estimate', 'sort'];
const PARTNER_CHANCE = 0.35; // Anteil der passenden Runden, die zur Partner-Runde werden (ab 4 Spielern)
const DUEL_QUESTIONS = 3; // Finale-Duell der zwei Besten nach der letzten Runde
const DUEL_MODES = ['mix', 'quiz', 'imagequiz', 'songquiz', 'estimate', 'sort', 'mostlikely', 'wouldyourather', 'neverhavei', 'teams', 'scale', 'icebreaker', 'wordassoc', 'taboo', 'pantomime', 'hotseat'];
// Joker: Rundensieger bekommen einen (max. 2), einsetzbar zwischen den Runden
const JOKER_TYPES = ['double', 'copy', 'timethief', 'steal'];
const JOKER_TARGETED = ['copy', 'timethief', 'steal'];
const JOKER_LABELS = { double: '✖️2 Doppelte Punkte', copy: '📋 Abschreiben', timethief: '⏳ Zeitdieb', steal: '💰 Punkteklau' };
const JOKER_MAX = 2;
const JOKER_STEAL_PTS = 15;
const JOKER_ANSWER_MODES = ['quiz', 'imagequiz', 'songquiz', 'estimate', 'sort', 'hotseat']; // Abschreiben/Zeitdieb
const SCORING_MODES = ['quiz', 'imagequiz', 'songquiz', 'estimate', 'reaction', 'imposter', 'draw', 'taboo', 'pantomime', 'truthlie', 'sort', 'hotseat'];
// Auflösungen mit Trommelwirbel-Overlay (Clients: SUSPENSE_MODES in ux-helpers.js) – die Pause verlängert sich um dessen Dauer
const SUSPENSE_MODES = ['quiz', 'imagequiz', 'songquiz', 'estimate', 'sort', 'truthlie', 'imposter', 'mostlikely', 'wouldyourather', 'hotseat'];
const SUSPENSE_MS = 1250;
const TIMER_MULT = { fast: 0.7, normal: 1.0, relaxed: 1.5 }; // Antwortzeit
const RESULT_MULT = { fast: 0.7, normal: 1.0, relaxed: 0 }; // Auflösung/Karten-Ergebnis; 0 = kein Auto-Weiter (Zeit zum Quatschen)
const REACTION_ROUNDS = 5;
const PORT = Number(process.env.PORT) || 3002;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 12;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 50;
const STROKE_COLORS = new Set(['#111', '#e21b3c', '#1368ce', '#26890c']);
const STROKE_MAX_COORDS = 128; // max. 64 Punkte pro Chunk
const STROKE_HISTORY_MAX = 3000; // Chunks pro Runde

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
    "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://*.mzstatic.com https://*.dzcdn.net data: blob:; media-src 'self' https://*.mzstatic.com https://*.itunes.apple.com https://*.dzcdn.net; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
  );
  next();
});
// Nur API/QR limitieren: Auf Partys teilen sich alle Handys eine öffentliche IP (NAT),
// statische Dateien und Song-/Bild-Assets dürfen deshalb nicht mitgezählt werden.
const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 180 });
// Fotos: viele Handys laden am Ende gleichzeitig (hinter einer NAT-IP) dutzende Bilder hoch → eigenes, höheres Limit
const photoLimiter = createRateLimiter({ windowMs: 60_000, max: 900 });
app.use('/api/photos', photoLimiter);
app.use(['/api', '/qr.png', '/info'], (req, res, next) => (req.originalUrl.startsWith('/api/photos') ? next() : apiLimiter(req, res, next)));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e4,
  // State-Updates sind ~2,5 KB JSON mit vielen wiederholten Schlüsseln → komprimiert ~4× kleiner (Mobilfunk)
  perMessageDeflate: { threshold: 1024 },
  httpCompression: { threshold: 1024 },
  pingInterval: 15000,
  pingTimeout: 20000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  allowRequest: (req, cb) => cb(null, isAllowedOrigin(req)),
  cors: {
    origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.has(origin)),
  },
});
// Cache-Busting: CSS/JS werden in den Seiten mit ?v=<Inhalts-Hash> referenziert und dann dauerhaft gecacht.
// Ohne ?v (alte Seiten-Kopien) wird immer revalidiert, damit nie eine alte Helfer-Datei zu neuer Seite passt.
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSIONED_ASSETS = ['/style.css', '/js/ux-helpers.js'];
const assetHashes = Object.fromEntries(VERSIONED_ASSETS.map(url => [
  url,
  crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC_DIR, url))).digest('hex').slice(0, 10),
]));
app.use((req, res, next) => {
  if (req.path === '/sw.js') res.setHeader('Cache-Control', 'no-cache'); // Service-Worker-Updates sofort ausliefern
  if (VERSIONED_ASSETS.includes(req.path)) {
    res.setHeader('Cache-Control', req.query.v === assetHashes[req.path] ? 'public, max-age=31536000, immutable' : 'no-cache');
  }
  next();
});
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: '1h' }));
// Seiten einmal beim Start mit Asset-Hashes rendern; no-cache = immer revalidieren (ETag → 304).
const PAGES = {};
for (const file of ['play.html', 'host.html', 'admin.html', 'rooms.html', 'fotos.html']) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  for (const [url, hash] of Object.entries(assetHashes)) html = html.split(`"${url}"`).join(`"${url}?v=${hash}"`);
  html = html.split('__APP_VERSION__').join(APP_VERSION);
  PAGES[file] = html;
}
const sendRevalidated = file => (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(PAGES[file]);
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
    sockets: io.of('/').sockets.size,
    uptimeSec: Math.round(process.uptime())
  });
});

app.get('/', sendRevalidated('play.html'));
app.get('/play', sendRevalidated('play.html'));
app.get('/host', sendRevalidated('host.html'));
app.get('/admin', sendRevalidated('admin.html'));
app.get('/rooms', sendRevalidated('rooms.html'));
app.get('/room', sendRevalidated('rooms.html'));
app.get('/fotos', sendRevalidated('fotos.html'));

function serveCachedAssetDir(dir, allowedExts = null) {
  return (req, res) => {
    const safe = path.basename(String(req.params.file || ''));
    if (!safe || safe.startsWith('.')) return res.status(404).end();
    if (allowedExts && !allowedExts.some(ext => safe.endsWith(ext))) return res.status(404).end();
    const full = path.join(dir, safe);
    if (!fs.existsSync(full)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(full);
  };
}

const IQ_IMG_DIR = path.join(__dirname, 'data', 'iq-images');
const SONG_AUDIO_DIR = path.join(__dirname, 'data', 'song-audio');
const SONG_ART_DIR = path.join(__dirname, 'data', 'song-art');
app.get('/iq/:file', serveCachedAssetDir(IQ_IMG_DIR));
app.get('/song-audio/:file', serveCachedAssetDir(SONG_AUDIO_DIR, ['.mp3']));
app.get('/song-art/:file', serveCachedAssetDir(SONG_ART_DIR, ['.jpg', '.jpeg', '.png', '.webp']));

function indexNumericAssets(dir, ext) {
  const set = new Set();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(ext)) {
        const id = Number(f.slice(0, -ext.length));
        if (Number.isInteger(id) && id >= 0) set.add(id);
      }
    }
  } catch {}
  return set;
}
const songAudioSet = indexNumericAssets(SONG_AUDIO_DIR, '.mp3');
const songArtSet = indexNumericAssets(SONG_ART_DIR, '.jpg');
const hasLocalSongAudio = (idx) => typeof idx === 'number' && songAudioSet.has(idx);
const hasLocalSongArt = (idx) => typeof idx === 'number' && songArtSet.has(idx);

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

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const PARTIAL_MIN_LEN = 3;

/** Initialize per-character visibility mask (separators visible immediately). */
function initWordMask(word) {
  return Array.from(String(word || '')).map(ch => !WORD_CHAR_RE.test(ch));
}

/** Reveal contiguous matching chunks (length >= PARTIAL_MIN_LEN) of guess inside word. */
function applyPartialGuess(word, revealed, guess) {
  const wordChars = Array.from(String(word || ''));
  if (!Array.isArray(revealed) || revealed.length !== wordChars.length) return false;
  const guessNorm = norm(guess).slice(0, 60);
  if (guessNorm.length < PARTIAL_MIN_LEN) return false;

  const normChars = [];
  const normToOrig = [];
  for (let i = 0; i < wordChars.length; i++) {
    if (WORD_CHAR_RE.test(wordChars[i])) {
      normChars.push(wordChars[i].toLowerCase());
      normToOrig.push(i);
    }
  }
  const wordNorm = normChars.join('');
  if (wordNorm.length < PARTIAL_MIN_LEN) return false;

  let changed = false;
  for (let gStart = 0; gStart <= guessNorm.length - PARTIAL_MIN_LEN; gStart++) {
    const chunk = guessNorm.slice(gStart, gStart + PARTIAL_MIN_LEN);
    let pos = wordNorm.indexOf(chunk);
    while (pos !== -1) {
      for (let k = 0; k < PARTIAL_MIN_LEN; k++) {
        const origIdx = normToOrig[pos + k];
        if (!revealed[origIdx]) {
          revealed[origIdx] = true;
          changed = true;
        }
      }
      pos = wordNorm.indexOf(chunk, pos + 1);
    }
  }
  return changed;
}

/** Format word mask string preserving original case and separators. */
function formatWordMask(word, revealed) {
  return Array.from(String(word || ''))
    .map((ch, i) => (!WORD_CHAR_RE.test(ch) || (revealed && revealed[i])) ? ch : '_')
    .join('');
}

const rooms = new Map();
const photos = createPhotoStore(process.env.PARTYGAME_PHOTO_DIR || path.join(__dirname, 'data', 'photos'));
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function normalizeRoomCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
function generateRoomCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)];
    if (!rooms.has(c) && !photos.exists(c)) return c; // Foto-Ordner einer früheren Party nicht wiederverwenden
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}
function getRoom(raw) {
  const code = normalizeRoomCode(raw);
  return code ? (rooms.get(code) || null) : null;
}

app.post('/api/rooms', (req, res) => {
  if (rooms.size >= MAX_ROOMS) {
    return res.status(429).json({ ok: false, error: 'Maximale Anzahl aktiver Räume erreicht' });
  }
  const code = generateRoomCode();
  const hostToken = crypto.randomBytes(8).toString('hex');
  const room = createRoom(code, hostToken);
  rooms.set(code, room);
  writeLog('INFO', 'room_created', { code });
  scheduleRoomsSnapshot();
  res.status(201).json({ ok: true, code, hostToken });
});

app.get('/api/rooms', (req, res) => {
  const secret = String(req.headers['x-host-secret'] || '');
  const auth = checkHostAuth(getClientIp(req), secret);
  if (!auth.ok) return res.status(auth.locked ? 429 : 401).json({ ok: false, error: auth.error });
  const now = Date.now();
  const list = [...rooms.values()].map(r => r.getSummary(now));
  res.json({ ok: true, rooms: list });
});

app.delete('/api/rooms/:code', (req, res) => {
  const secret = String(req.headers['x-host-secret'] || '');
  const auth = checkHostAuth(getClientIp(req), secret);
  if (!auth.ok) return res.status(auth.locked ? 429 : 401).json({ ok: false, error: auth.error });
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
  res.setHeader('Cache-Control', 'no-cache');
  const room = getRoom(req.query.room);
  // for=fotos: QR auf die Foto-Galerie des Raums (gleiche Domain wie der Spieler-Link)
  const targetUrl = room && req.query.for === 'fotos'
    ? `${new URL(room.getJoinUrl()).origin}/fotos?room=${room.code}`
    : room ? room.getJoinUrl() : DEFAULT_URL_PLAY;
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

// ---- Foto-Wand: Upload vom Handy (auch noch Tage nach der Party), Galerie für alle mit Raum-Link, ZIP ----
const publicPhoto = (code, p) => ({ id: p.id, name: p.name, ts: p.ts, url: `/photos/${code}/${p.id}.jpg` });
const photoRoomKnown = code => rooms.has(code) || photos.exists(code);
app.get('/api/photos/:code', (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!photoRoomKnown(code)) return res.status(404).json({ ok: false, error: 'Raum nicht gefunden oder Fotos schon gelöscht' });
  res.json({ ok: true, code, ttlDays: PHOTO_TTL_MS / 86_400_000, photos: photos.list(code).map(p => publicPhoto(code, p)) });
});
app.post('/api/photos/:code', express.raw({ type: 'image/jpeg', limit: PHOTO_MAX_BYTES }), (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!photoRoomKnown(code)) return res.status(404).json({ ok: false, error: 'Raum nicht gefunden' });
  let name = '';
  try { name = decodeURIComponent(String(req.headers['x-photo-name'] || '')); } catch { /* Name ist optional */ }
  const r = photos.add(code, req.body, name);
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  const photo = publicPhoto(code, r.entry);
  writeLog('INFO', 'photo_uploaded', { room: code, bytes: req.body.length });
  // x-card: Upload gehört zu einer Foto-Challenge (Remote-Party-Karte) → zählt dort statt als TV-Einblendung
  rooms.get(code)?.onPhoto(photo, { card: String(req.headers['x-card'] || ''), name });
  res.status(201).json({ ok: true, photo });
});
let zipDownloads = 0;
app.get('/api/photos/:code/zip', async (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!photos.list(code).length) return res.status(404).json({ ok: false, error: 'Keine Fotos' });
  if (zipDownloads >= 3) return res.status(503).json({ ok: false, error: 'Gerade laden viele das ZIP – bitte gleich nochmal versuchen' });
  zipDownloads++;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="party-fotos-${code}.zip"`);
  try {
    await photos.streamZip(code, res);
  } catch (err) {
    writeLog('WARN', 'photo_zip_failed', { room: code, error: err?.message || String(err) });
    res.destroy();
  } finally {
    zipDownloads--;
  }
});
app.get('/photos/:code/:file', (req, res) => {
  const f = photos.file(normalizeRoomCode(req.params.code), path.basename(String(req.params.file)).replace(/\.jpg$/, ''));
  if (!f || !fs.existsSync(f)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  if (req.query.dl) res.attachment(path.basename(f));
  res.sendFile(f);
});
setInterval(() => {
  const removed = photos.cleanup();
  if (removed) writeLog('INFO', 'photos_expired', { removed });
}, 3600_000).unref();
photos.cleanup();

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

// --- Raum-Persistenz: laufende Spiele überleben Neustarts (systemctl restart / Deploy) ---
// Schnappschuss aller Räume in data/rooms.json: entprellt, asynchron und atomar (tmp-Datei + rename).
const ROOMS_FILE = path.join(__dirname, 'data', 'rooms.json');
const ROOMS_SNAPSHOT_DEBOUNCE_MS = 1500;
const ROOMS_SNAPSHOT_MAX_WAIT_MS = 10_000; // bei Dauer-Aktivität trotzdem spätestens alle 10 s schreiben
const ROOMS_SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60_000;
const RESTORE_GRACE_MS = 4000; // Handys brauchen nach dem Neustart ein paar Sekunden zum Wiederverbinden
const SNAPSHOT_STROKES_MAX = 1500;
const RESTORED_ID_PREFIX = 'restored:'; // Platzhalter-ID bis der Spieler mit Name + Token zurückkommt
let roomsPersistEnabled = false; // nur im echten Serverbetrieb (require.main === module), nie in Tests
let snapshotTimer = null;
let snapshotFirstDirtyAt = 0;
let snapshotWriting = false;
let snapshotPending = false;
let snapshotFailLoggedAt = 0;

function scheduleRoomsSnapshot() {
  if (!roomsPersistEnabled) return;
  const now = Date.now();
  if (snapshotTimer) {
    if (now - snapshotFirstDirtyAt < ROOMS_SNAPSHOT_MAX_WAIT_MS) snapshotTimer.refresh();
    return;
  }
  snapshotFirstDirtyAt = now;
  snapshotTimer = setTimeout(flushRoomsSnapshot, ROOMS_SNAPSHOT_DEBOUNCE_MS);
  snapshotTimer.unref();
}

// Räume cachen ihr JSON und serialisieren nur nach Änderungen neu
function serializeRoomsSnapshot() {
  const parts = [];
  for (const room of rooms.values()) parts.push(room.serializeJson());
  return `{"savedAt":${Date.now()},"rooms":[${parts.join(',')}]}`;
}

function snapshotRooms() {
  return JSON.parse(serializeRoomsSnapshot());
}

function reportSnapshotFailure(err) {
  const now = Date.now();
  if (now - snapshotFailLoggedAt < 60_000) return;
  snapshotFailLoggedAt = now;
  writeLog('WARN', 'rooms_snapshot_failed', { error: err?.message || String(err) });
}

async function flushRoomsSnapshot() {
  snapshotTimer = null;
  if (!roomsPersistEnabled) return;
  if (snapshotWriting) { snapshotPending = true; return; }
  snapshotWriting = true;
  const tmp = `${ROOMS_FILE}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, serializeRoomsSnapshot());
    // Während des Herunterfahrens schreibt gracefulShutdown den finalen Stand synchron – nicht überschreiben
    if (roomsPersistEnabled) await fs.promises.rename(tmp, ROOMS_FILE);
    else await fs.promises.unlink(tmp).catch(() => {});
  } catch (err) {
    reportSnapshotFailure(err);
  } finally {
    snapshotWriting = false;
    if (snapshotPending) {
      snapshotPending = false;
      scheduleRoomsSnapshot();
    }
  }
}

function writeRoomsSnapshotSync() {
  clearTimeout(snapshotTimer);
  snapshotTimer = null;
  roomsPersistEnabled = false;
  const tmp = `${ROOMS_FILE}.${process.pid}.sync.tmp`;
  try {
    fs.writeFileSync(tmp, serializeRoomsSnapshot());
    fs.renameSync(tmp, ROOMS_FILE);
    return true;
  } catch (err) {
    writeLog('WARN', 'rooms_snapshot_failed', { error: err?.message || String(err) });
    return false;
  }
}

function restoreRooms(snapshot) {
  const result = { count: 0, players: 0 };
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.rooms)) return result;
  const ageMs = Date.now() - Number(snapshot.savedAt);
  if (!(ageMs < ROOMS_SNAPSHOT_MAX_AGE_MS)) {
    writeLog('INFO', 'rooms_restore_skipped', { reason: 'stale', ageMin: Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null });
    return result;
  }
  for (const snap of snapshot.rooms) {
    const code = normalizeRoomCode(snap && snap.code);
    const hostToken = snap && typeof snap.hostToken === 'string' ? snap.hostToken : '';
    if (!code || !hostToken || rooms.has(code) || rooms.size >= MAX_ROOMS) continue;
    try {
      rooms.set(code, createRoom(code, hostToken, snap));
      result.count++;
      result.players += Array.isArray(snap.players) ? snap.players.length : 0;
    } catch (err) {
      writeLog('WARN', 'room_restore_failed', { code, error: err?.message || String(err) });
    }
  }
  writeLog('INFO', 'rooms_restored', result);
  return result;
}

function loadRoomsFromDisk() {
  let raw;
  try {
    raw = fs.readFileSync(ROOMS_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') writeLog('WARN', 'rooms_restore_failed', { error: err?.message || String(err) });
    return { count: 0, players: 0 };
  }
  try {
    return restoreRooms(JSON.parse(raw));
  } catch (err) {
    writeLog('WARN', 'rooms_restore_failed', { error: err?.message || String(err) });
    return { count: 0, players: 0 };
  }
}

// --- Laufzeit-Metriken für Grafana/Loki: eine Zeile "metrics" pro Minute ---
const metrics = { enabled: false, broadcasts: 0, emitBytes: 0 };
const round1 = x => (Number.isFinite(x) ? Math.round(x * 10) / 10 : 0);
function startMetrics(intervalMs = 60_000) {
  if (metrics.enabled || process.env.NODE_ENV === 'test') return;
  metrics.enabled = true;
  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  let lastCpu = process.cpuUsage();
  let lastAt = performance.now();
  setInterval(() => {
    const now = performance.now();
    const elapsedMs = Math.max(1, now - lastAt);
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    let players = 0;
    for (const r of rooms.values()) players += r.getPlayerCount();
    const perMin = 60_000 / elapsedMs;
    writeLog('INFO', 'metrics', {
      rooms: rooms.size,
      players,
      sockets: io.of('/').sockets.size,
      rssMb: Math.round(mem.rss / 1048576),
      heapMb: Math.round(mem.heapUsed / 1048576),
      cpuPct: round1(((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000 / elapsedMs * 100),
      elP50Ms: round1(eld.percentile(50) / 1e6),
      elP99Ms: round1(eld.percentile(99) / 1e6),
      elMaxMs: round1(eld.max / 1e6),
      broadcastsPerMin: Math.round(metrics.broadcasts * perMin),
      emitKbPerMin: Math.round(metrics.emitBytes / 1024 * perMin),
    });
    eld.reset();
    metrics.broadcasts = 0;
    metrics.emitBytes = 0;
    lastCpu = cpu;
    lastAt = now;
  }, intervalMs).unref();
}

function createRoom(code, hostToken, snapshot = null) {
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
let activeCategories = ['party', 'peinlich'];
let roundLimit = 10; // 0 = Alle, sonst ROUND_LIMITS – Standard 10, sonst dauert z. B. das Quiz 70+ Runden
let teamMode = false;
let displayMode = 'tv'; // 'tv' | 'notv' | 'onedevice'
let songLangs = { en: true, de: true };
  let imageQuizThemes = [...IQ_THEMES];
let russianShare = 0;
let songOnlyArtistTitle = false;
let finalDouble = true;
let wheelEnabled = true;
let secretMissions = false;
let alcoholFree = false;
let partyCards = 'off'; // 'off' | 'rare' | 'normal' | 'often'
let remoteMode = false; // alle an verschiedenen Orten (Video-Call) → andere Party-Karten
// Mehr Interaktion (Standard an, in /admin abschaltbar)
let discussVotes = true; // „Wer würde?“/„Entweder-Oder“: 15 s diskutieren, dann abstimmen
let standUp = true; // „Ich hab noch nie“: aufstehen statt tippen
let captainMode = true; // Team-Modus: ein Kapitän pro Team antwortet (rotiert)
let partnerRounds = true; // ab 4 Spielern: manche Runden zu zweit auf einem Handy
let duelFinale = true; // nach der letzten Runde: Finale-Duell der zwei Besten
let jokersOn = true; // Rundensieger bekommen Joker
let timerSpeed = 'normal';
let mixRounds = MIX_ROUNDS;
const MIN_ANSWER_S = { wordassoc: 16 }; // Tipp-Modi brauchen auch bei „Schnell“ genug Zeit
const roundTimeMs = m => Math.max(4000, (MIN_ANSWER_S[m] || 0) * 1000, Math.round((TIME[m] || 20) * (m === 'reaction' ? 1 : (TIMER_MULT[timerSpeed] || 1)) * 1000));
// Pause nach Auflösung, Missions- oder Karten-Ergebnis: „Entspannt“ wartet auf „Weiter“ (Admin, TV oder Handy-Abstimmung)
function armAutoNext(baseMs, extraMs = 0) {
  clearTimeout(timer);
  const mult = RESULT_MULT[timerSpeed] ?? 1;
  // Kürzer als „Normal“, aber mind. 6 s (bzw. die Normal-Dauer, falls die schon kürzer ist), damit man die Rangliste noch lesen kann
  const ms = baseMs > 0 && mult > 0 ? Math.max(Math.min(baseMs, 6000), Math.round(baseMs * mult)) + extraMs : 0;
  state.totalMs = ms;
  state.deadline = ms ? Date.now() + ms : 0;
  broadcast();
  if (ms) timer = setTimeout(nextRound, ms);
}
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
let mixModes = [...DEFAULT_MIX_MODES];
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
const disconnectedPlayers = new Map(); // name.toLowerCase() -> { data, timer }
const pendingDisconnects = new Map(); // socketId -> timer
const RECONNECT_GRACE_MS = 4000;
const skipVotes = new Set();

function finalizePlayerDisconnect(socketId, reason, recovered) {
  const gt = pendingDisconnects.get(socketId);
  if (gt) {
    clearTimeout(gt);
    pendingDisconnects.delete(socketId);
  }
  const p = players[socketId];
  if (!p) return;
  const key = p.name.toLowerCase();
  const prev = disconnectedPlayers.get(key);
  if (prev) clearTimeout(prev.timer);
  const t = setTimeout(() => { disconnectedPlayers.delete(key); markDirty(); }, 900_000);
  if (t.unref) t.unref();
  disconnectedPlayers.set(key, {
    data: {
      name: p.name, avatar: p.avatar, team: p.team, score: p.score, prevScore: p.prevScore, lastGain: p.lastGain, streak: p.streak,
      drinks: p.drinks, stats: p.stats, jokers: p.jokers, reconnectToken: p.reconnectToken, answer: p.answer, answeredAt: p.answeredAt, roundSeq,
      prevId: socketId, // für das Umhängen der Imposter-Rolle beim Rejoin
    },
    timer: t,
  });
  writeLog('INFO', 'player_disconnected', { name: p.name, socketId, reason, recovered });
  delete players[socketId];
  recheckOpenCard();
  broadcast();
}
let timer = null;
let discussTimer = null; // Ende der Diskussionsphase → Abstimmung freigeben

function freshState(mode) {
  return {
    mode, subMode: null, subIdx: -1, mixOrder: [], mixPools: {},
    phase: 'lobby', idx: -1, deadline: 0, totalMs: 0, order: [],
    paused: false, pausedLeft: 0,
    result: null, reactionGoAt: 0,
    spin: null, lobbyBanner: null,
    songStarted: false, roundStartedAt: 0,
    imposterIds: [], imposterWords: null,
    drawerName: null, drawWord: null, drawRevealed: [], strokes: [], guessedBy: [],
    explainerName: null, tabooWord: null, tabooRevealed: [], tabooForbidden: [], tabooGuessedBy: [],
    mimeName: null, mimeWord: null, mimeIdx: -1, mimeGuessedBy: [], mimeSkips: 0,
    sortOrder: [],
    storytellerName: null, tlStatements: [], tlLieIdx: -1,
    songQ: null,
    mission: null,
    card: null, rule: null, lastCardIdx: -1, usedCards: [], cardShownAt: 0, snapHighlights: [],
    hotName: null, // Heißer Stuhl
    discussUntil: 0, // Diskussion vor der Abstimmung läuft bis …
    answerGroups: null, // [{ kind: 'captain'|'partner', lead, members }] – nur lead antwortet, zählt für alle
    duel: null, // Finale-Duell { names, n, total, order, active }
    jokerQueue: [], // gespielte Joker für die nächste passende Runde { type, by, target }
    roundJokers: [], // in dieser Runde wirksame Joker (Zeitdieb: cutAt)
    jokerNews: [], // in der Auflösung neu verteilte Joker { name, type }
  };
}

const pVals = () => Object.values(players);
const pickOf = p => ({ name: p.name, avatar: p.avatar || '😎' });
const duelActive = () => !!(state.duel && state.duel.active);
const activeMode = () => (duelActive() ? 'quiz' : state.mode === 'mix' && state.subMode ? state.subMode : state.mode);
// Index der aktuellen Frage im Pool des aktiven Modus (Mix-Unterrunde bzw. Finale-Duell über subIdx)
const curQIdx = () => (state.mode === 'mix' || duelActive() ? state.subIdx : state.order[state.idx]);


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

const roomCustom = {};
const getPool = (mode) => {
  const base = DATA[mode] || [];
  const extra = roomCustom[mode];
  return extra && extra.length ? base.concat(extra) : base;
};

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
  const pool = getPool(mode);
  const matching = pool
    .map((item, i) => (!item.cat || activeCategories.includes(item.cat) ? i : -1))
    .filter(i => i !== -1);
  return matching.length ? matching : pool.map((_, i) => i);
}

// totalRounds() läuft bei jedem pub(): in der Lobby nicht jedes Mal den ganzen Fragenpool filtern
let filteredCountKey = '';
let filteredCountVal = 0;
function filteredCount(mode) {
  const key = mode === 'songquiz' ? `songquiz|${songLangs.en}|${songLangs.de}|${effectiveRussianShare()}`
    : mode === 'imagequiz' ? `imagequiz|${imageQuizThemes.join(',')}`
    : `${mode}|${activeCategories.join(',')}|${roomCustom[mode] ? roomCustom[mode].length : 0}`;
  if (key !== filteredCountKey) {
    filteredCountVal = filteredIndices(mode).length;
    filteredCountKey = key;
  }
  return filteredCountVal;
}

const totalRounds = () => {
  let n;
  if (state.mode === 'reaction') n = REACTION_ROUNDS;
  else if (state.mode === 'mix') return mixRounds; // Party-Mix hat eigene Rundenwahl (MIX_ROUND_OPTIONS)
  else if (state.mode === 'truthlie') n = state.phase === 'lobby' ? Math.max(pVals().length, 3) : Math.max(state.order.length, 1);
  else if (state.order.length && state.phase !== 'lobby') n = state.order.length;
  else n = filteredCount(state.mode);
  return roundLimit > 0 ? Math.min(n, roundLimit) : n;
};

const list = (ps = pVals()) => ps
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
    jokers: (p.jokers || []).length,
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
  const qIdx = curQIdx();
  const item = (m === 'reaction' || m === 'songquiz') ? null : getPool(m)[qIdx];
  switch (m) {
    case 'quiz': return item ? { q: item.q, a: item.a } : null;
    case 'imagequiz': return item ? { q: item.q, a: item.a, img: '/iq/' + item.img, theme: item.theme } : null;
    case 'mostlikely': return item ? { q: item.q ?? item } : null;
    case 'wouldyourather': return item ? { a: item.a ?? item[0], b: item.b ?? item[1] } : null;
    case 'hotseat': return item ? { a: item.a ?? item[0], b: item.b ?? item[1], hot: state.hotName } : null;
    case 'estimate': return item ? { q: item.q, unit: item.unit } : null;
    case 'neverhavei': return item ? { q: item.q ?? item, standup: !!state.standup } : null;
    case 'reaction': return { q: 'Drücke erst, wenn es GRÜN wird!' };
    case 'imposter': return { q: state.phase === 'discuss' ? 'Lies dein geheimes Wort und gib einen Hinweis!' : 'Wer ist der Imposter?' };
    case 'draw': return { drawer: state.drawerName, len: state.drawWord ? state.drawWord.length : 0, mask: formatWordMask(state.drawWord, state.drawRevealed), guessed: state.guessedBy };
    case 'taboo': return { explainer: state.explainerName, len: state.tabooWord ? state.tabooWord.length : 0, mask: formatWordMask(state.tabooWord, state.tabooRevealed), guessed: state.tabooGuessedBy };
    case 'pantomime': return { actor: state.mimeName };
    case 'sort': return item && state.sortOrder.length === 4 ? { q: item.q, items: state.sortOrder.map((origIdx, dispIdx) => ({ idx: dispIdx, label: item.items[origIdx].label })) } : null;
    case 'icebreaker': return item ? { q: item.q ?? item } : null;
    case 'teams': return item ? { q: item.q, a: item.a } : null;
    case 'scale': return item ? { q: item.q, min: item.min, max: item.max } : null;
    case 'wordassoc': return item ? { w: item.w } : null;
    case 'songquiz': return state.songQ ? { q: state.songQ.q, a: state.songQ.a, preview: state.songQ.preview, artPreload: state.songQ.art } : null;
    default: return null;
  }
}

function getNextPreloadAssets(m, total) {
  let nextImg = null;
  let nextAudio = null;
  let nextArt = null;
  const nextIdx = state.phase === 'lobby' ? 0 : state.idx + 1;
  if (state.phase === 'lobby') {
    if (state.mode === 'songquiz' && state.order[0] !== undefined) {
      const sIdx = state.order[0];
      if (hasLocalSongAudio(sIdx)) nextAudio = `/song-audio/${sIdx}.mp3`;
      if (hasLocalSongArt(sIdx)) nextArt = `/song-art/${sIdx}.jpg`;
    }
    return { nextImg, nextAudio, nextArt };
  }
  if ((state.phase === 'question' || state.phase === 'result') && nextIdx < total) {
    if (state.mode === 'imagequiz' && DATA.imagequiz[state.order[nextIdx]]) {
      nextImg = '/iq/' + DATA.imagequiz[state.order[nextIdx]].img;
    } else if (state.mode === 'songquiz') {
      const sIdx = state.order[nextIdx];
      if (hasLocalSongAudio(sIdx)) nextAudio = `/song-audio/${sIdx}.mp3`;
      if (hasLocalSongArt(sIdx)) nextArt = `/song-art/${sIdx}.jpg`;
    } else if (state.mode === 'mix') {
      const nextSub = state.mixOrder[nextIdx];
      if (nextSub === 'imagequiz') {
        const iIdx = state.mixPools.imagequiz && state.mixPools.imagequiz[0];
        if (typeof iIdx === 'number' && DATA.imagequiz[iIdx]) nextImg = '/iq/' + DATA.imagequiz[iIdx].img;
      } else if (nextSub === 'songquiz') {
        const sIdx = state.mixPools.songquiz && state.mixPools.songquiz[0];
        if (hasLocalSongAudio(sIdx)) nextAudio = `/song-audio/${sIdx}.mp3`;
        if (hasLocalSongArt(sIdx)) nextArt = `/song-art/${sIdx}.jpg`;
      }
    }
  }
  return { nextImg, nextAudio, nextArt };
}

const isFinalRound = (total) => {
  if (!finalDouble || state.phase === 'lobby' || state.phase === 'end') return false;
  if (duelActive()) return true; // Finale-Duell zählt doppelt
  const n = total ?? totalRounds();
  return n > 1 && state.idx === n - 1;
};

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
  // Abend-Rückblick: Foto-Stimmen, Party-Karten-Punkte, längste Serie, am häufigsten leer ausgegangen
  const top = (key, min) => [...ps].filter(p => p.stats && (p.stats[key] || 0) >= min).sort((a, b) => b.stats[key] - a.stats[key])[0];
  const photog = top('snapVotes', 1);
  if (photog) awards.push({ icon: '📸', title: 'Fotograf des Abends', name: photog.name, detail: `${photog.stats.snapVotes} Foto-Stimmen` });
  const cardKing = top('cardPts', 1);
  if (cardKing) awards.push({ icon: '🎪', title: 'Party-Tier', name: cardKing.name, detail: `+${cardKing.stats.cardPts} aus Party-Karten` });
  const onFire = top('bestStreak', 3);
  if (onFire) awards.push({ icon: '🔥', title: 'Auf Feuer', name: onFire.name, detail: `${onFire.stats.bestStreak} Runden in Folge gepunktet` });
  const missed = top('misses', 3);
  if (missed) awards.push({ icon: '🙈', title: 'Daneben-König', name: missed.name, detail: `${missed.stats.misses}× leer ausgegangen` });
  return awards;
}

function pub() {
  const ps = pVals();
  const total = totalRounds();
  const m = state.phase === 'lobby' || state.phase === 'end' ? state.mode : activeMode();
  const { nextImg, nextAudio, nextArt } = getNextPreloadAssets(m, total);
  const teams = teamMode ? TEAMS.map(t => {
    const members = ps.filter(p => p.team === t.id);
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
    roomCode: code, mode: m, isMix: state.mode === 'mix', phase: state.phase, idx: state.idx, total,
    isFinalRound: isFinalRound(total),
    categories: activeCategories, roundLimit, teamMode,
    displayMode, noTvMode: displayMode !== 'tv',
    songLangs, imageQuizThemes, russianShare, effectiveRussianShare: effectiveRussianShare(), songOnlyArtistTitle, finalDouble, wheelEnabled, secretMissions, alcoholFree, timerSpeed, mixRounds, mixModes,
    publicUrl, defaultPublicUrl: DEFAULT_URL_PLAY,
    partyCards,
    discussVotes, standUp, captainMode, partnerRounds, duelFinale, jokersOn,
    // Diskussion vor der Abstimmung: so lange sind die Abstimm-Knöpfe gesperrt
    discussLeftMs: state.phase === 'question' && state.discussUntil > Date.now() ? state.discussUntil - Date.now() : 0,
    answerGroups: state.phase === 'question' || state.phase === 'result' ? state.answerGroups : null,
    duel: duelActive() ? { names: state.duel.names, n: state.duel.n, total: state.duel.total } : null,
    jokerQueue: state.jokerQueue || [],
    // Zeitdieb: bis wann das Ziel noch antworten darf (relativ, wie leftMs)
    roundJokers: (state.roundJokers || []).map(j => (j.type === 'timethief' && state.phase === 'question' && state.deadline > 0
      ? { ...j, cutLeftMs: Math.max(0, state.deadline - state.totalMs / 2 - Date.now()) } : j)),
    jokerNews: state.phase === 'result' ? (state.jokerNews || []) : [],
    jokerLabels: JOKER_LABELS,
    remote: remoteMode,
    photoCount: photos.list(code).length,
    card: state.phase === 'card' && state.card ? publicCard() : null,
    rule: state.rule && state.phase !== 'lobby' && state.phase !== 'end' && state.idx <= state.rule.untilIdx ? state.rule.text : null,
    teams,
    paused: state.paused, pausedLeft: state.pausedLeft,
    deadline: state.deadline, time: TIME[m],
    leftMs: state.deadline > 0 ? Math.max(0, state.deadline - Date.now()) : 0,
    totalMs: state.totalMs > 0 ? state.totalMs : (TIME[m] || 15) * 1000,
    spin: state.phase === 'spin' ? state.spin : null,
    lobbyBanner: state.phase === 'lobby' ? state.lobbyBanner : null,
    q: currentQuestion(),
    nextImg,
    nextAudio,
    nextArt,
    result: state.phase === 'result' ? state.result : null,
    skipVote: ['question', 'go', 'write', 'discuss', 'result', 'card'].includes(state.phase) && displayMode !== 'onedevice' && !snapVoteBlocked() ? (() => {
      const count = ps.length;
      const needed = Math.max(1, Math.ceil(count * 0.65));
      const voters = Array.from(skipVotes).filter(n => ps.some(pl => pl.name.toLowerCase() === n));
      const readyInMs = state.phase === 'card' ? Math.max(0, state.cardShownAt + CARD_SKIP_DELAY_MS - Date.now()) : 0;
      return { count: voters.length, needed, total: count, voters, readyInMs };
    })() : null,
    missionReveal: (state.phase === 'result' && state.mission)
      ? { playerName: state.mission.playerName, text: state.mission.text, resolved: state.mission.resolved, success: state.mission.success }
      : null,
    awards: state.phase === 'end' ? computeAwards() : [],
    // Siegerfotos der Foto-Challenges für die Diashow am Ende
    snapHighlights: state.phase === 'end' ? (state.snapHighlights || []) : [],
    customCards: CUSTOM_CARDS.map(c => ({ id: c.id, type: c.type, text: c.text, where: c.where })),
    players: list(ps),
  };
}

function sendPrivate(socket, id) {
  const p = players[id];
  const m = activeMode();
  let priv = null;
  if (p) {
    const mission = (state.mission && state.mission.playerId === id && state.phase !== 'result') ? state.mission.text : null;
    if (m === 'imposter' && state.imposterWords && (state.phase === 'discuss' || state.phase === 'question')) {
      const isImp = state.imposterIds.includes(id);
      priv = { mode: 'imposter', word: isImp ? state.imposterWords[1] : state.imposterWords[0], mission };
    } else if (m === 'draw' && state.phase === 'question') {
      const isDrawer = p.name === state.drawerName;
      priv = { mode: 'draw', drawer: isDrawer, word: isDrawer ? state.drawWord : null, guessed: state.guessedBy.includes(p.name), mission };
    } else if (m === 'taboo' && state.phase === 'question') {
      const isExplainer = p.name === state.explainerName;
      priv = {
        mode: 'taboo', explainer: isExplainer,
        word: isExplainer ? state.tabooWord : null,
        taboo: isExplainer ? state.tabooForbidden : [],
        guessed: state.tabooGuessedBy.includes(p.name),
        mission,
      };
    } else if (m === 'pantomime' && state.phase === 'question' && p.name === state.mimeName) {
      priv = { mode: 'pantomime', actor: true, word: state.mimeWord, skipsLeft: MIME_SKIPS - state.mimeSkips, mission };
    } else if (state.phase === 'card' && state.card && state.card.act === 'snap' && state.card.entries.some(e => e.name === p.name)) {
      // Foto-Challenge: welches Foto ist meins? (auch nach Neuladen, damit es bei der Abstimmung markiert ist)
      const i = state.card.entries.findIndex(e => e.name === p.name);
      priv = { mode: 'snap', snapMine: i, snapUrl: state.card.entries[i].url, mission };
    } else if (mission) {
      priv = { mission };
    }
    // Joker-Hand ist privat (die anderen sehen nur die Anzahl)
    if (p.jokers && p.jokers.length) priv = { ...(priv || {}), jokers: p.jokers };
  }
  if (!priv) {
    if (!socket.data.hasPrivate) return;
    socket.data.hasPrivate = false;
    socket.data.lastPrivJson = '';
    return socket.emit('private', null);
  }
  const privJson = JSON.stringify(priv);
  if (socket.data.lastPrivJson === privJson) return;
  socket.data.hasPrivate = true;
  socket.data.lastPrivJson = privJson;
  metrics.emitBytes += privJson.length;
  socket.emit('private', priv);
}

let broadcastN = 0;
let pubBytes = 0;
let pubBytesPhase = '';
function broadcast() {
  const payload = pub();
  // Metrik: Payload-Größe nur stichprobenartig messen (Phasenwechsel / jede 8. Übertragung) statt doppelt zu serialisieren
  if (metrics.enabled && (pubBytesPhase !== state.phase || (broadcastN++ & 7) === 0)) {
    pubBytes = JSON.stringify(payload).length;
    pubBytesPhase = state.phase;
  }
  io.to(ROOM_CHAN).emit('state', payload);
  metrics.broadcasts++;
  metrics.emitBytes += pubBytes * roomSockets.size;
  for (const id of roomSockets) {
    const sock = io.sockets.sockets.get(id);
    if (sock) sendPrivate(sock, id);
  }
  markDirty();
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
  state.card = null;
  state.snapHighlights = [];
  state.duel = null;
  state.jokerQueue = [];
  state.roundJokers = [];
  state.jokerNews = [];
  state.rule = null;
  state.lastCardIdx = -1;
  pVals().forEach(p => { p.score = 0; p.prevScore = 0; p.lastGain = 0; p.streak = 0; p.drinks = 0; p.stats = freshStats(); p.jokers = []; });
  nextRound();
}

const songCache = {};
const songInFlight = {};
async function fetchSongPreview(song) {
  if (!song) return { preview: null, art: null };
  const idx = song._idx;
  const localPreview = hasLocalSongAudio(idx) ? `/song-audio/${idx}.mp3` : null;
  const localArt = hasLocalSongArt(idx) ? `/song-art/${idx}.jpg` : null;
  if (localPreview && localArt) {
    return { preview: localPreview, art: localArt };
  }
  const key = `${song.artist} - ${song.title}`;
  if (songCache[key]) {
    return {
      preview: localPreview || songCache[key].preview,
      art: localArt || songCache[key].art,
    };
  }
  if (songInFlight[key]) {
    const res = await songInFlight[key];
    return {
      preview: localPreview || res.preview,
      art: localArt || res.art,
    };
  }
  songInFlight[key] = (async () => {
    const term = song.query || key;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const stripP = s => String(s || '').replace(/\(.*?\)|\[.*?\]/g, '').trim();
    const normTitleFull = norm(song.title);
    const normTitle = norm(stripP(song.title));
    const primArtist = norm(String(song.artist || '').split(/[,&]|feat\.|vs\./i)[0]);
    const allowRemix = /remix/i.test(song.title || '') || /remix/i.test(song.artist || '');
    const badBase = /\b(karaoke|tribute|cover|instrumental|live|demo|acoustic|sped\s*up|slowed|reverb|nightcore|lullaby|piano\s*version|8d|re-?recorded|taylor'?s\s*version|bootleg|mashup|parody|orchestral|symphonic|originally\s*performed|made\s*famous|in\s*the\s*style\s*of)\b|инструмент/i;
    const isBadText = txt => badBase.test(txt || '') || (!allowRemix && /\bremix\b/i.test(txt || ''));
    const ruMap = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
    const toLat = s => String(s || '').toLowerCase().replace(/[а-яё]/g, ch => ruMap[ch] ?? ch).replace(/j([auo])/g, 'y$1').replace(/j/g, 'y').replace(/[^\p{L}\p{N}]/gu, '');
    const qNorm = norm(song.query || '');
    const qLat = toLat(song.query || '');
    const latTitleFull = toLat(song.title);
    const latTitle = toLat(stripP(song.title));
    const titleMatch = tr => {
      const nt = norm(tr), nts = norm(stripP(tr));
      const lt = toLat(tr), lts = toLat(stripP(tr));
      return [[normTitle, nts], [normTitleFull, nt], [latTitle, lts], [latTitleFull, lt]]
        .some(([a, b]) => a && b && (b.includes(a) || a.includes(b)))
        || (qLat && lts && lts.length >= 3 && qLat.includes(lts));
    };
    const artistMatch = ar => {
      const na = norm(ar), la = toLat(ar);
      if (!na && !la) return false;
      if (primArtist && (na.includes(primArtist) || primArtist.includes(na) || la.includes(primArtist) || primArtist.includes(la))) return true;
      if (qNorm && na && na.length >= 3 && qNorm.includes(na)) return true;
      if (qLat && la && la.length >= 3 && qLat.includes(la)) return true;
      return false;
    };
    const isGood = (ar, tr) => artistMatch(ar) && titleMatch(tr) && !isBadText(tr) && !isBadText(ar);
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
        || results.find(r => artistMatch(r.artistName) && !isBadText(r.trackName) && !isBadText(r.artistName))
        || dzHits.find(r => artistMatch(r.artist?.name) && !isBadText(r.title) && !isBadText(r.artist?.name));
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
    return { preview: localPreview, art: localArt };
  })();
  const res = await songInFlight[key];
  return {
    preview: localPreview || res.preview,
    art: localArt || res.art,
  };
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

  // Lokale Vorschau mit leisem Anfang: ab der ersten lauten Stelle abspielen (#t= versteht jeder Browser)
  const start = SONG_STARTS[song._idx];
  const preview = meta.preview && start > 0 && meta.preview.startsWith('/song-audio/') ? `${meta.preview}#t=${start}` : meta.preview;
  return { q, a, c, artist: song.artist, title: song.title, year: song.year, type: song.type, preview, art: meta.art };
}

const byName = n => pVals().find(p => p.name === n);
// Auch kurz getrennte Spieler (Handy gesperrt) bekommen ihre Karten-Punkte – sie stehen in disconnectedPlayers
const anyPlayer = n => byName(n) || (n ? disconnectedPlayers.get(String(n).toLowerCase())?.data : null) || null;
const addPoints = (p, n) => { if (p) p.score = Math.max(0, (p.score || 0) + n); };
const rankedPlayers = () => [...pVals()].sort((a, b) => b.score - a.score);

function partyCardDue() {
  const gap = PARTY_CARD_GAP[partyCards];
  if (!gap || state.phase !== 'result' || displayMode === 'onedevice' || pVals().length < 2) return false;
  if (state.idx + 2 >= totalRounds()) return false; // nie vor der letzten Runde (Finalrunde) und nicht am Ende
  const since = state.idx - state.lastCardIdx;
  return since > gap || (since === gap && Math.random() < 0.7);
}

function pickPartyCard() {
  const ranked = rankedPlayers();
  const n = ranked.length;
  const hasRanking = n >= 2 && ranked[0].score > ranked[n - 1].score;
  const pool = [...PARTY_CARDS, ...CUSTOM_CARDS].filter(c => {
    const t = PARTY_CARD_TYPES[c.type];
    if (!t || n < (t.min || 2)) return false;
    // Vor Ort keine Remote-Karten (Kamera/Foto-Challenge), remote keine Karten mit Nachbarn/Gruppenfoto im selben Raum
    if (remoteMode ? (c.local || t.local) : (c.remote || t.remote)) return false;
    if (c.cat && !activeCategories.includes(c.cat)) return false;
    if ((c.type === 'leader' || c.type === 'underdog') && !hasRanking) return false;
    return c.act !== 'mode' || state.mode === 'mix';
  });
  if (!pool.length) return null;
  let fresh = pool.filter(c => !state.usedCards.includes(c.id));
  if (!fresh.length) {
    state.usedCards = [];
    fresh = pool;
  }
  // Erst den Typ gewichtet wählen, dann die Karte – sonst dominieren Typen mit vielen Karten
  const types = [...new Set(fresh.map(c => c.type))];
  let r = Math.random() * types.reduce((s, t) => s + PARTY_CARD_TYPES[t].w, 0);
  const type = types.find(t => (r -= PARTY_CARD_TYPES[t].w) < 0) || types[types.length - 1];
  const cands = fresh.filter(c => c.type === type);
  return cands[crypto.randomInt(cands.length)];
}

function maybeStartPartyCard() {
  if (!partyCardDue()) return false;
  const c = pickPartyCard();
  if (!c) return false;
  const ranked = rankedPlayers();
  const mixed = shuffle(pVals());
  const roles = { leader: ranked[0], last: ranked[ranked.length - 1], a: mixed[0], b: mixed[1], player: mixed[0] };
  const act = c.act || PARTY_CARD_TYPES[c.type].act || 'info';
  const text = (alcoholFree && c.af ? c.af : c.text).replace(/\{(leader|last|a|b|player)\}/g, (_, k) => roles[k].name);
  const target = c.type === 'leader' ? roles.leader : c.type === 'underdog' ? roles.last : null;
  clearTimeout(timer);
  state.paused = false; // eine Pause aus der Auflösung darf nicht in die Karte mitgenommen werden
  state.pausedLeft = 0;
  skipVotes.clear();
  state.usedCards.push(c.id);
  state.lastCardIdx = state.idx;
  state.cardShownAt = Date.now();
  const isPair = c.type === 'photo' && c.who === 'pair';
  const isDuel = act === 'duel' || c.type === 'snapduel';
  const reward = c.type === 'group' ? CARD_GROUP_PTS : act === 'vote' ? CARD_VOTE_PTS : isDuel ? CARD_DUEL_PTS : act === 'snap' ? CARD_SNAP_PTS : (c.pts || c.amount || 0);
  state.card = {
    id: c.id, type: c.type, title: PARTY_CARD_TYPES[c.type].title, act, text,
    target: target ? target.name : null,
    duel: isDuel ? [roles.a.name, roles.b.name] : null,
    pair: isPair ? [roles.a.name, roles.b.name] : null,
    reward, minus: c.minus || 0, amount: c.amount || 0, photo: !!c.photo || c.type === 'photo',
    votes: {}, tally: null, resolved: false, outcome: null,
    stage: act === 'snap' ? 'collect' : null, entries: [], order: null,
  };
  if (act === 'rule') state.rule = { text, untilIdx: state.idx + CARD_RULE_ROUNDS };
  state.phase = 'card';
  state.totalMs = c.sec ? c.sec * 1000 : 0;
  state.deadline = c.sec ? Date.now() + state.totalMs : 0;
  writeLog('INFO', 'party_card', { room: code, card: c.id });
  broadcast();
  // Foto-Challenge: nach Ablauf der Zeit automatisch zur Abstimmung
  if (act === 'snap') timer = setTimeout(startSnapVote, state.totalMs || 90_000);
  return true;
}

// ---- Foto-Challenge (Remote): Fotos hochladen, dann anonym das beste wählen ----
// Foto-Duell: nur die zwei Ausgelosten (card.duel) fotografieren, abstimmen dürfen nur die anderen.
function startSnapVote() {
  const card = state.card;
  if (state.phase !== 'card' || !card || card.act !== 'snap' || card.resolved || card.stage !== 'collect') return;
  clearTimeout(timer);
  if (card.entries.length < 2) return resolvePartyCard();
  card.stage = 'vote';
  card.order = shuffle(card.entries.map((_, i) => i));
  state.totalMs = 0;
  state.deadline = 0;
  broadcast();
}

// Android/iOS trennen beim Öffnen der Kamera oft kurz die Verbindung → Upload kann vor dem Rejoin ankommen,
// daher auch kurz getrennte Spieler zulassen (anyPlayer statt byName).
function cardPhoto(name, url, cardId) {
  const card = state.card;
  const p = anyPlayer(name);
  if (state.phase !== 'card' || !card || card.act !== 'snap' || card.resolved || card.id !== cardId || !p) return false;
  if (card.duel && !card.duel.includes(p.name)) return false;
  const own = card.entries.find(e => e.name === p.name);
  if (card.stage === 'vote') {
    // Zu spät, aber Abstimmung läuft noch: als weiteres Foto anhängen (ersetzen nicht mehr – darauf wurde evtl. schon gestimmt)
    if (!own) {
      card.entries.push({ name: p.name, url });
      card.order.push(card.entries.length - 1);
      broadcast();
    }
    return true;
  }
  if (own) own.url = url; // neues Foto ersetzt das alte
  else card.entries.push({ name: p.name, url });
  if (snapAllSubmitted(card)) startSnapVote();
  else broadcast();
  return true;
}

// Alle, die fotografieren sollen, haben ein Foto – aber nie mit weniger als 2 Fotos vorzeitig abbrechen:
// wer gerade in der Kamera-App ist, gilt kurz als getrennt; dann wartet die Karte bis zum Timer.
const snapAllSubmitted = card => card.entries.length >= 2 && (card.duel
  ? card.duel.every(n => card.entries.some(e => e.name === n))
  : pVals().filter(x => !x.isLocal).every(q => card.entries.some(e => e.name === q.name)));

const snapVoters = card => pVals().filter(x => !x.isLocal && !(card.duel || []).includes(x.name)).map(x => x.name);
// Fertig, wenn jeder abgestimmt hat – oder nichts wählen kann, weil nur das eigene Foto da ist
const snapVotingDone = card => snapVoters(card).every(n => n in card.votes || card.entries.every(e => e.name === n));

// Foto-Abstimmung läuft ohne Zeitlimit; „Weiter“ (Admin, TV, Handy-Abstimmung) wertet erst ab 2 Stimmen aus
function snapVoteBlocked() {
  const c = state.card;
  return state.phase === 'card' && !!c && c.act === 'snap' && !c.resolved && c.stage === 'vote' && Object.keys(c.votes).length < 2;
}

// Mitmach-Karte mit Foto-Aufgabe: das erste hochgeladene Foto pro Spieler bringt +5 (Rückgabe: vergebene Punkte)
function crowdPhotoBonus(name) {
  const card = state.card;
  if (state.phase !== 'card' || !card || card.type !== 'crowd' || !card.photo) return 0;
  const p = anyPlayer(name);
  if (!p || (card.photoBonus ||= []).includes(p.name)) return 0;
  card.photoBonus.push(p.name);
  addPoints(p, CARD_PHOTO_BONUS);
  bumpStat(p, 'cardPts', CARD_PHOTO_BONUS);
  return CARD_PHOTO_BONUS;
}

function cardNext() {
  const c = state.card;
  if (c && c.act === 'snap' && !c.resolved && c.stage === 'vote') {
    if (!snapVoteBlocked()) resolvePartyCard();
    return;
  }
  nextRound();
}

// Ja/Nein-Karten bewerten die Spieler selbst: alle außer den Betroffenen ({leader}/{last}/Foto-Paar);
// bleiben dafür weniger als 2 übrig, stimmen alle ab. Mindestens 2 Stimmen, Mehrheit entscheidet (Gleichstand = nicht gelungen).
function cardJudges(card) {
  const all = pVals().filter(p => !p.isLocal).map(p => p.name);
  const involved = new Set([card.target, ...(card.pair || [])].filter(Boolean));
  const others = all.filter(n => !involved.has(n));
  return others.length >= 2 ? others : all;
}

function checkCardJudgement() {
  const card = state.card;
  const judges = cardJudges(card);
  const vals = judges.filter(n => n in card.votes).map(n => card.votes[n]);
  const yes = vals.filter(Boolean).length;
  const no = vals.length - yes;
  const decided = vals.length >= 2
    && (vals.length === judges.length || yes > judges.length / 2 || no >= judges.length / 2);
  if (decided) resolvePartyCard({ ok: yes > no });
  else broadcast();
}

// Auswertung durch die Handys (Ja/Nein, Reihum) oder über /admin (Duell, Punkte abgeben, Spielwahl; Admin kann alles überstimmen)
function resolvePartyCard(arg) {
  const card = state.card;
  if (state.phase !== 'card' || !card || card.resolved) return;
  const ps = pVals();
  const before = new Map(ps.map(p => [p, p.score || 0]));
  const target = anyPlayer(card.target);
  let outcome;
  if (card.act === 'yesno') {
    const ok = !!(arg && arg.ok);
    if (card.type === 'photo') {
      // Foto-Karten sind zum Spaß: kein Trinken/Abzug, nur Bonus bei Erfolg
      const winners = card.pair ? card.pair.map(anyPlayer).filter(Boolean) : ps;
      if (ok) winners.forEach(p => addPoints(p, card.reward));
      outcome = ok ? `📸 Gelungen! +${card.reward} ${card.pair ? `für ${card.pair.join(' & ')}` : 'für alle'}` : '❌ Nicht ganz – diesmal keine Punkte';
    } else if (card.type === 'group') {
      if (ok) ps.forEach(p => addPoints(p, card.reward));
      else ps.forEach(p => { p.drinks = (p.drinks || 0) + 1; });
      outcome = ok ? `✅ Geschafft! +${card.reward} für alle`
        : alcoholFree ? '❌ Nicht geschafft – alle machen 5 Kniebeugen!' : '❌ Nicht geschafft – alle trinken einen Schluck!';
    } else if (ok) {
      addPoints(target, card.reward);
      outcome = `✅ Geschafft! ${card.target} +${card.reward}`;
    } else {
      addPoints(target, -card.minus);
      outcome = card.minus ? `❌ Nicht geschafft! ${card.target} −${card.minus}` : `❌ Leider nicht – keine Punkte für ${card.target}`;
    }
  } else if (card.act === 'give') {
    const other = anyPlayer(arg && arg.name);
    if (!other || !target || other === target) return;
    const amt = Math.min(card.amount, target.score || 0);
    addPoints(target, -amt);
    addPoints(other, amt);
    outcome = `💸 ${target.name} gibt ${amt} Punkte an ${other.name}`;
  } else if (card.act === 'duel') {
    const winner = anyPlayer(arg && arg.name);
    if (!winner || !card.duel.includes(winner.name)) return;
    addPoints(winner, card.reward);
    outcome = `🏆 ${winner.name} gewinnt das Duell! +${card.reward}`;
  } else if (card.act === 'vote') {
    const tally = {};
    for (const n of Object.values(card.votes)) if (anyPlayer(n)) tally[n] = (tally[n] || 0) + 1;
    const max = Math.max(0, ...Object.values(tally));
    const winners = max > 0 ? Object.keys(tally).filter(n => tally[n] === max) : [];
    winners.forEach(n => addPoints(anyPlayer(n), card.reward));
    card.tally = tally;
    outcome = winners.length ? `🏆 ${winners.join(' & ')} ${winners.length > 1 ? 'gewinnen' : 'gewinnt'}! +${card.reward}` : 'Keine Stimmen – keine Punkte';
  } else if (card.act === 'snap') {
    const what = card.duel ? 'das Foto-Duell' : 'die Foto-Challenge';
    if (!card.entries.length) {
      outcome = '📸 Keine Fotos – diesmal keine Punkte';
    } else if (card.entries.length === 1) {
      // Nur ein Foto: trotzdem zeigen, Fotograf bekommt den Foto-Bonus
      const e = card.entries[0];
      addPoints(anyPlayer(e.name), CARD_SNAP_BONUS);
      card.order = [0];
      card.tally = {};
      outcome = `📸 Nur ein Foto – ${e.name} bekommt +${CARD_SNAP_BONUS}`;
    } else {
      const tally = {};
      for (const i of Object.values(card.votes)) tally[i] = (tally[i] || 0) + 1;
      const max = Math.max(0, ...Object.values(tally));
      const winIdx = max > 0 ? Object.keys(tally).filter(i => tally[i] === max).map(Number) : [];
      const winners = winIdx.map(i => card.entries[i].name);
      card.entries.forEach(e => addPoints(anyPlayer(e.name), CARD_SNAP_BONUS));
      winners.forEach(n => addPoints(anyPlayer(n), card.reward));
      for (const [i, n] of Object.entries(tally)) bumpStat(anyPlayer(card.entries[i].name), 'snapVotes', n);
      (state.snapHighlights ||= []).push(...winIdx.map(i => ({ url: card.entries[i].url, name: card.entries[i].name, text: card.text })));
      card.tally = tally;
      outcome = winners.length
        ? `🏆 ${winners.join(' & ')} ${winners.length > 1 ? 'gewinnen' : 'gewinnt'} ${what}! +${card.reward} (jedes Foto +${CARD_SNAP_BONUS})`
        : `📸 Keine Stimmen – jedes Foto +${CARD_SNAP_BONUS}`;
    }
  } else if (card.act === 'mode') {
    const m = arg && arg.mode;
    if (state.mode !== 'mix' || !MIX_MODES_ALL.includes(m)) return;
    state.mixOrder[state.idx + 1] = m;
    outcome = `🎲 ${card.target} wählt: ${MODE_LABELS[m] || m}`;
  } else {
    return; // info/rule brauchen keine Auswertung, nur „Weiter“
  }
  for (const [p, prev] of before) {
    p.prevScore = prev;
    p.lastGain = Math.max(0, (p.score || 0) - prev);
    bumpStat(p, 'cardPts', (p.score || 0) - prev);
  }
  card.resolved = true;
  if (card.act === 'yesno' && Object.keys(card.votes).length) {
    const yes = Object.values(card.votes).filter(Boolean).length;
    outcome += ` (👍 ${yes} · 👎 ${Object.keys(card.votes).length - yes})`;
  }
  card.outcome = outcome;
  // Foto-Challenge: Siegerfoto und alle Fotos mit Namen etwas länger zeigen
  armAutoNext(card.act === 'snap' && card.entries.length >= 1 ? CARD_AUTO_NEXT_MS * 2 : CARD_AUTO_NEXT_MS);
}

function publicCard() {
  const c = state.card;
  const lbl = n => { const p = byName(n); return p ? `${p.avatar || '😎'} ${p.name}` : n; };
  return {
    id: c.id, type: c.type, title: c.title, act: c.act, text: c.text,
    target: c.target, targetLabel: c.target ? lbl(c.target) : null,
    duel: c.duel, pair: c.pair, reward: c.reward, minus: c.minus, amount: c.amount, photo: !!c.photo,
    photoBonus: c.type === 'crowd' && c.photo ? { pts: CARD_PHOTO_BONUS, got: c.photoBonus || [] } : null,
    voters: c.act === 'vote' || c.act === 'yesno' || c.act === 'snap' ? Object.keys(c.votes) : [],
    judges: c.act === 'yesno' ? cardJudges(c) : null,
    tally: c.tally, resolved: c.resolved, outcome: c.outcome,
    // Foto-Challenge: beim Sammeln nur, wer schon hat; ab der Abstimmung anonyme Fotos, Namen erst nach der Auswertung
    stage: c.stage,
    submitted: c.act === 'snap' ? c.entries.map(e => e.name) : null,
    snapVoters: c.act === 'snap' ? snapVoters(c) : null,
    photos: c.act === 'snap' && c.order ? c.order.map(i => ({
      i, url: c.entries[i].url, name: c.resolved ? c.entries[i].name : null, votes: c.resolved ? (c.tally && c.tally[i]) || 0 : null,
    })) : null,
  };
}

// Spieler weg (Timeout/Kick): offene Abstimmungs-Karten nicht hängen lassen, wenn jetzt alle Verbliebenen abgestimmt haben
function recheckOpenCard() {
  const card = state.card;
  if (state.phase !== 'card' || !card || card.resolved) return;
  if (card.act === 'yesno') return checkCardJudgement();
  if (card.act === 'vote') {
    const voters = pVals().filter(x => !x.isLocal);
    if (Object.keys(card.votes).length && voters.every(x => card.votes[x.name])) resolvePartyCard();
  }
  if (card.act === 'snap') {
    if (card.stage === 'collect' && snapAllSubmitted(card)) startSnapVote();
    else if (card.stage === 'vote' && snapVotingDone(card)) resolvePartyCard();
  }
}

async function nextRound() {
  // Nach einer Auflösung kann zuerst eine Party-Karte kommen; ihr „Weiter“ ruft nextRound erneut auf.
  if (maybeStartPartyCard()) return;
  clearTimeout(timer);
  clearTimeout(discussTimer);
  state.card = null;
  skipVotes.clear();
  pendingSpinNext = null;
  state.spin = null;
  const seq = ++roundSeq;
  state.idx++;
  // Nach der letzten Runde: Finale-Duell der zwei Besten (falls an), danach Ende
  const duelQ = state.idx >= totalRounds() ? nextDuelQuestion() : -1;
  if (state.idx >= totalRounds() && duelQ < 0) {
    if (state.duel) state.duel.active = false;
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
  state.drawWord = null;
  state.drawRevealed = [];
  state.explainerName = null;
  state.tabooWord = null;
  state.tabooRevealed = [];
  state.tabooForbidden = [];
  state.tabooGuessedBy = [];
  state.mimeName = null;
  state.mimeWord = null;
  state.mimeIdx = -1;
  state.mimeGuessedBy = [];
  state.mimeSkips = 0;
  state.sortOrder = [];
  state.storytellerName = null;
  state.tlStatements = [];
  state.tlLieIdx = -1;
  state.hotName = null;
  state.discussUntil = 0;
  state.answerGroups = null;
  state.roundJokers = [];
  state.jokerNews = [];
  state.standup = false;

  if (duelActive()) {
    state.subIdx = duelQ;
  } else if (state.mode === 'mix') {
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
  const playedIdx = curQIdx();
  if (typeof playedIdx === 'number' && playedIdx >= 0 && m !== 'reaction' && m !== 'truthlie') {
    (usedIndices[m] || (usedIndices[m] = new Set())).add(playedIdx);
    saveUsedIndices();
  }

  const spins = [];
  if (state.mode === 'mix' && !duelActive()) {
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
  if (m === 'truthlie' || m === 'draw' || m === 'taboo' || m === 'pantomime' || m === 'hotseat') {
    const chosenName = pickNextActor(m);
    if (m === 'truthlie') state.storytellerName = chosenName;
    else if (m === 'draw') state.drawerName = chosenName;
    else if (m === 'taboo') state.explainerName = chosenName;
    else if (m === 'pantomime') state.mimeName = chosenName;
    else if (m === 'hotseat') state.hotName = chosenName;

    if (ps.length >= 2 && chosenName) {
      const wIdx = Math.max(0, ps.findIndex(p => p.name === chosenName));
      const pObj = ps[wIdx];
      const wLabel = pObj ? `${pObj.avatar || '😎'} ${pObj.name}` : chosenName;
      const roleTitle = m === 'draw'
        ? '🎨 Wer malt als Nächstes?'
        : m === 'taboo'
        ? '🗣️ Wer erklärt als Nächstes?'
        : m === 'pantomime'
        ? '🤸 Wer spielt als Nächstes vor?'
        : m === 'hotseat'
        ? '🔥 Wer sitzt auf dem heißen Stuhl?'
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

function mimeGuessed(winnerName) {
  const winner = winnerName ? byName(winnerName) : null;
  if (winner && winner.name !== state.mimeName && !state.mimeGuessedBy.includes(winner.name)) {
    const mult = isFinalRound() ? 2 : 1;
    state.mimeGuessedBy.push(winner.name);
    winner.score += MIME_GUESS_PTS * mult;
    if (winner.stats) winner.stats.guessedWords++;
    const actor = byName(state.mimeName);
    if (actor) actor.score += MIME_ACTOR_PTS * mult;
  }
  showResult();
}

async function activateRound(seq, m, playedIdx) {
  if (seq !== roundSeq) return;
  state.mission = null;
  armRoundJokers(m);
  state.answerGroups = buildAnswerGroups(m);
  if (secretMissions && m !== 'reaction' && displayMode !== 'onedevice' && !duelActive()) {
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
    timer = setTimeout(startReactionGo, delay);
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
    state.drawRevealed = initWordMask(state.drawWord);
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
    state.tabooRevealed = initWordMask(state.tabooWord);
    state.tabooForbidden = item.taboo || [];
    state.phase = 'question';
    state.totalMs = roundTimeMs('taboo');
    state.deadline = Date.now() + state.totalMs;
    broadcast();
    timer = setTimeout(showResult, state.totalMs);
    return;
  }

  if (m === 'pantomime') {
    if (!state.mimeName) state.mimeName = pickNextActor('pantomime');
    state.mimeIdx = playedIdx;
    state.mimeWord = getPool('pantomime')[playedIdx].w;
    state.phase = 'question';
    state.totalMs = roundTimeMs('pantomime');
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

  if (m === 'hotseat' && !state.hotName) state.hotName = pickNextActor('hotseat');
  // „Ich hab noch nie“ als Aufsteh-Runde: kein Handy, nur kurz aufstehen
  state.standup = m === 'neverhavei' && standUp && displayMode !== 'onedevice';
  // „Wer würde?“/„Entweder-Oder“: erst diskutieren, Abstimmen erst danach (Zeit kommt oben drauf)
  const discuss = discussVotes && DISCUSS_MODES.includes(m) && displayMode !== 'onedevice' ? DISCUSS_MS : 0;
  state.phase = 'question';
  state.totalMs = state.standup ? STANDUP_MS : roundTimeMs(m) + discuss;
  state.deadline = displayMode === 'onedevice' ? 0 : Date.now() + state.totalMs;
  state.discussUntil = discuss ? Date.now() + discuss : 0;
  broadcast();
  if (displayMode !== 'onedevice') timer = setTimeout(showResult, state.totalMs);
  if (discuss) discussTimer = setTimeout(broadcast, discuss + 50); // Handys schalten die Abstimmung frei
}

// ---- Finale-Duell: die zwei Besten beantworten nach der letzten Runde DUEL_QUESTIONS Quizfragen (2× Punkte) ----
function nextDuelQuestion() {
  if (!state.duel) {
    const online = rankedPlayers().filter(p => !p.isLocal);
    if (!duelFinale || teamMode || displayMode === 'onedevice' || !DUEL_MODES.includes(state.mode) || online.length < 3) return -1;
    state.duel = { names: online.slice(0, 2).map(p => p.name), n: 0, total: DUEL_QUESTIONS, order: pickOrder('quiz').slice(0, DUEL_QUESTIONS), active: true };
  }
  if (!state.duel.active || state.duel.n >= state.duel.total) return -1;
  const q = state.duel.order[state.duel.n++];
  return Number.isInteger(q) ? q : -1;
}

// ---- Kapitän (Team-Modus) / Partner-Runde: nur der „lead“ antwortet, seine Antwort zählt für alle in der Gruppe ----
function buildAnswerGroups(m) {
  if (!GROUP_MODES.includes(m) || duelActive() || displayMode === 'onedevice') return null;
  const online = pVals().filter(p => !p.isLocal);
  if (teamMode) {
    if (!captainMode) return null;
    const groups = [];
    for (const t of TEAMS) {
      const members = online.filter(p => p.team === t.id).map(p => p.name).sort((a, b) => a.localeCompare(b));
      if (members.length >= 2) groups.push({ kind: 'captain', team: t.id, lead: members[state.idx % members.length], members });
    }
    return groups.length ? groups : null;
  }
  if (!partnerRounds || online.length < 4 || Math.random() >= PARTNER_CHANCE) return null;
  const names = shuffle(online.map(p => p.name));
  const groups = [];
  for (let i = 0; i + 1 < names.length; i += 2) groups.push({ kind: 'partner', lead: names[i], members: [names[i], names[i + 1]] });
  if (names.length % 2) groups[groups.length - 1].members.push(names[names.length - 1]); // ungerade: ein Dreier-Team
  return groups;
}

// Darf dieser Spieler gerade selbst antworten? (Finale-Duell: nur die zwei; Gruppen: nur der Antwortende)
function mayAnswer(p) {
  if (duelActive()) return state.duel.names.includes(p.name);
  const g = (state.answerGroups || []).find(x => x.members.includes(p.name));
  return !g || g.lead === p.name;
}

// ---- Joker: aus der Warteschlange die nehmen, die in dieser Runde greifen (Abschreiben/Zeitdieb nur bei Antwort-Runden) ----
function armRoundJokers(m) {
  state.roundJokers = [];
  if (!jokersOn || duelActive() || !(state.jokerQueue || []).length) return;
  const keep = [];
  for (const j of state.jokerQueue) {
    const fits = j.type === 'double' ? SCORING_MODES.includes(m) : JOKER_ANSWER_MODES.includes(m);
    (fits ? state.roundJokers : keep).push(j);
  }
  state.jokerQueue = keep;
}

// Zeitdieb: das Ziel darf nur in der ersten Hälfte der Antwortzeit antworten
const timeThiefCut = p => (state.roundJokers || []).some(j => j.type === 'timethief' && j.target === p.name)
  && state.deadline > 0 && Date.now() > state.deadline - state.totalMs / 2;

function startReactionGo() {
  if (state.phase !== 'wait') return;
  state.phase = 'go';
  state.reactionGoAt = Date.now();
  state.totalMs = TIME.reaction * 1000;
  state.deadline = state.reactionGoAt + state.totalMs;
  broadcast();
  timer = setTimeout(showResult, state.totalMs);
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
  const qIdx = curQIdx();
  let autoNextMs = 7000;
  clearTimeout(discussTimer);
  state.discussUntil = 0;

  // Kapitän/Partner: die Antwort des Antwortenden gilt für die ganze Gruppe
  for (const g of state.answerGroups || []) {
    const lead = byName(g.lead);
    if (!lead) continue;
    for (const n of g.members) {
      const p = byName(n);
      if (p && p !== lead) { p.answer = Array.isArray(lead.answer) ? [...lead.answer] : lead.answer; p.answeredAt = lead.answeredAt; }
    }
  }
  // Joker „Abschreiben“: übernimmt die Antwort des Ziels (wenn es geantwortet hat)
  for (const j of state.roundJokers || []) {
    if (j.type !== 'copy') continue;
    const by = byName(j.by), t = byName(j.target);
    if (by && t && t.answer !== null) { by.answer = Array.isArray(t.answer) ? [...t.answer] : t.answer; by.answeredAt = t.answeredAt; }
  }

  if (m === 'quiz' || m === 'imagequiz') {
    const q = getPool(m)[qIdx];
    const roundDur = Math.max(1000, state.totalMs || roundTimeMs(m));
    ps.forEach(p => {
      if (p.answer === q.c) {
        const left = Math.max(0, state.deadline - p.answeredAt) / roundDur;
        p.score += (50 + Math.round(50 * left)) * mult;
      }
    });
    const counts = q.a.map((_, i) => ps.filter(p => p.answer === i).length);
    const pickers = q.a.map((_, i) => ps.filter(p => p.answer === i).map(pickOf));
    state.result = { correct: q.c, counts, pickers };
  } else if (m === 'hotseat') {
    // Heißer Stuhl: alle tippen, was die Person wählt; sie selbst wählt geheim
    const hot = byName(state.hotName);
    const pick = hot && (hot.answer === 0 || hot.answer === 1) ? hot.answer : null;
    const guessers = ps.filter(p => p.name !== state.hotName);
    const correct = pick === null ? [] : guessers.filter(p => p.answer === pick).map(p => p.name);
    const drinkers = pick === null ? [] : guessers.filter(p => p.answer !== pick).map(p => p.name);
    ps.forEach(p => {
      if (correct.includes(p.name)) p.score += HOT_GUESS_PTS * mult;
      if (drinkers.includes(p.name)) p.drinks++;
    });
    if (hot && correct.length) hot.score += HOT_SEAT_PTS * correct.length * mult;
    state.result = {
      hot: state.hotName, pick, correct, drinkers,
      aNames: guessers.filter(p => p.answer === 0).map(pickOf),
      bNames: guessers.filter(p => p.answer === 1).map(pickOf),
    };
    autoNextMs = 9000;
  } else if (m === 'mostlikely') {
    const counts = Object.fromEntries(ps.map(p => [p.name, 0]));
    ps.forEach(p => { if (typeof p.answer === 'string' && counts[p.answer] !== undefined) counts[p.answer]++; });
    const votes = Object.entries(counts).map(([name, count]) => ({
      name, count,
      avatar: (ps.find(p => p.name === name) || {}).avatar || '😎',
      by: ps.filter(p => p.answer === name).map(pickOf),
    })).sort((a, b) => b.count - a.count);
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
        p.score += 100 * mult;
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
      if (p.name === fastest) p.score += 100 * mult;
      if (p.answer > 0 && p.stats) { p.stats.fastSum += p.answer; p.stats.fastCount++; }
      if (drinkers.includes(p.name)) p.drinks++;
    });
    state.result = { entries, fastest, drinkers };
  } else if (m === 'neverhavei') {
    const yes = ps.filter(p => p.answer === true).map(p => p.name);
    const no = ps.filter(p => p.answer === false).map(p => p.name);
    ps.forEach(p => { if (p.answer === true) { p.drinks++; p.score++; } });
    state.result = { yes, no, standup: !!state.standup };
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
      if ((caught && !imposters.includes(p.name)) || (!caught && imposters.includes(p.name))) p.score += 100 * mult;
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
  } else if (m === 'pantomime') {
    // Niemand hat's erraten → der Darsteller trinkt
    const drinkers = state.mimeGuessedBy.length === 0 && state.mimeName ? [state.mimeName] : [];
    ps.forEach(p => { if (drinkers.includes(p.name)) p.drinks++; });
    state.result = { word: state.mimeWord, actor: state.mimeName, guessedBy: state.mimeGuessedBy, drinkers };
  } else if (m === 'sort') {
    const item = DATA.sort[qIdx];
    const roundDur = Math.max(1000, state.totalMs || roundTimeMs('sort'));
    const entries = ps.map(p => {
      let hits = 0;
      if (Array.isArray(p.answer) && p.answer.length === 4) {
        for (let k = 0; k < 4; k++) {
          if (state.sortOrder[p.answer[k]] === k) hits++;
        }
      }
      const left = p.answeredAt ? Math.max(0, state.deadline - p.answeredAt) / roundDur : 0;
      const pts = Array.isArray(p.answer) ? (hits * 20 + (hits === 4 ? 40 + Math.round(20 * left) : 0)) * mult : 0;
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
      if (typeof p.answer === 'string' && p.answer.trim()) p.score += 50 * mult;
      else p.drinks++;
    });
    state.result = { entries, drinkers };
    autoNextMs = 15000;
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
      if (p.answer !== null) p.score += 50 * mult;
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
      if (typeof p.answer === 'number') p.score += 50 * mult;
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
        if (caughtBy.length === 0 && guessers.length > 0) p.score += 100 * mult;
      } else if (p.answer === state.tlLieIdx) {
        p.score += 80 * mult;
      }
      if (drinkers.includes(p.name)) p.drinks++;
    });
    const counts = state.tlStatements.map((_, i) => guessers.filter(p => p.answer === i).length);
    const pickers = state.tlStatements.map((_, i) => guessers.filter(p => p.answer === i).map(pickOf));
    state.result = { lieIdx: state.tlLieIdx, caughtBy, drinkers, counts, pickers, storyteller: state.storytellerName };
    autoNextMs = 9000;
  } else if (m === 'wordassoc') {
    const entries = ps.map(p => ({
      name: p.name,
      avatar: p.avatar || '😎',
      word: typeof p.answer === 'string' && p.answer.trim() ? p.answer.trim() : null,
    }));
    ps.forEach(p => { if (typeof p.answer === 'string' && p.answer.trim()) p.score += 50 * mult; });
    state.result = { entries };
    autoNextMs = 8000;
  } else if (m === 'songquiz') {
    const sq = state.songQ;
    const roundDur = Math.max(1000, state.totalMs || roundTimeMs('songquiz'));
    ps.forEach(p => {
      if (p.answer === sq.c) {
        const left = Math.max(0, state.deadline - p.answeredAt) / roundDur;
        p.score += (50 + Math.round(50 * left)) * mult;
      }
    });
    const counts = sq.a.map((_, i) => ps.filter(p => p.answer === i).length);
    const pickers = sq.a.map((_, i) => ps.filter(p => p.answer === i).map(pickOf));
    state.result = { correct: sq.c, counts, pickers, artist: sq.artist, title: sq.title, year: sq.year, type: sq.type, art: sq.art };
    autoNextMs = 12000;
    const nextSongIdx = state.idx + 1 < totalRounds()
      ? (state.mode === 'songquiz'
          ? state.order[state.idx + 1]
          : (state.mode === 'mix' && state.mixOrder[state.idx + 1] === 'songquiz' ? state.mixPools.songquiz?.[0] : undefined))
      : undefined;
    if (typeof nextSongIdx === 'number' && DATA.songs[nextSongIdx]) {
      fetchSongPreview(DATA.songs[nextSongIdx]).catch(() => {});
    }
  }

  // Joker „Doppelte Punkte“: Rundengewinn noch einmal obendrauf
  for (const j of state.roundJokers || []) {
    if (j.type !== 'double') continue;
    const p = byName(j.by);
    const gain = p ? (p.score || 0) - (p.prevScore ?? p.score ?? 0) : 0;
    if (gain > 0) p.score += gain;
  }

  ps.forEach(p => {
    const gain = (p.score || 0) - (p.prevScore ?? p.score ?? 0);
    p.lastGain = Math.max(0, gain);
    if (duelActive() && !state.duel.names.includes(p.name)) return; // Zuschauer im Finale-Duell
    if (SCORING_MODES.includes(m)) {
      const wonRound = m === 'sort' ? gain >= 50 : gain > 0;
      p.streak = wonRound ? (p.streak || 0) + 1 : 0;
      if (!wonRound) bumpStat(p, 'misses');
      if (p.stats && p.streak > (p.stats.bestStreak || 0)) p.stats.bestStreak = p.streak;
    }
  });

  // Joker verteilen: wer die Runde mit den meisten Punkten gewinnt, bekommt einen (max. JOKER_MAX)
  state.jokerNews = [];
  if (jokersOn && !duelActive() && displayMode !== 'onedevice' && SCORING_MODES.includes(m)) {
    const best = Math.max(0, ...ps.map(p => p.lastGain || 0));
    for (const p of best > 0 ? ps : []) {
      if (p.isLocal || p.lastGain !== best || (p.jokers ||= []).length >= JOKER_MAX) continue;
      const type = JOKER_TYPES[crypto.randomInt(JOKER_TYPES.length)];
      p.jokers.push(type);
      state.jokerNews.push({ name: p.name, type });
    }
  }

  state.phase = 'result';
  armAutoNext(state.mission && !state.mission.resolved ? 0 : autoNextMs, SUSPENSE_MODES.includes(m) ? SUSPENSE_MS : 0);
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
  if (m === 'quiz' || m === 'imagequiz' || m === 'wouldyourather' || m === 'teams' || m === 'truthlie' || m === 'songquiz' || m === 'hotseat') {
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
  if (state.standup) return false; // Aufsteh-Runde: kein Handy
  if (state.discussUntil && Date.now() < state.discussUntil) return false; // erst diskutieren
  if (!mayAnswer(p) || timeThiefCut(p)) return false;
  const res = validateAnswer(m, val);
  if (!res.ok) return false;
  p.answer = res.val;
  p.answeredAt = Date.now();
  broadcast();
  const waiters = (m === 'truthlie' ? pVals().filter(x => x.name !== state.storytellerName) : pVals()).filter(mayAnswer);
  if (waiters.length > 0 && waiters.every(x => x.answer !== null)) showResult();
  return true;
}

function attachSocket(socket, ip, allowEvent) {
  roomSockets.add(socket.id);
  // Wiederhergestellte Verbindung (gleiche Socket-ID, z. B. Handy kurz im Hintergrund): das ausstehende
  // „Spieler weg“ abbrechen – sonst fliegt der Spieler 4 s später raus, obwohl das Handy verbunden ist,
  // und Antworten/Abstimmungen werden bis zum nächsten Neuverbinden ignoriert.
  const pendingGrace = pendingDisconnects.get(socket.id);
  if (pendingGrace) {
    clearTimeout(pendingGrace);
    pendingDisconnects.delete(socket.id);
  }
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
    if (existing && existing[0] !== socket.id) {
      const [oldId, oldPlayer] = existing;
      if (!clientToken || !oldPlayer.reconnectToken || clientToken !== oldPlayer.reconnectToken) {
        return ack && ack({ ok: false, error: 'Name schon vergeben' });
      }
      const oldGrace = pendingDisconnects.get(oldId);
      if (oldGrace) {
        clearTimeout(oldGrace);
        pendingDisconnects.delete(oldId);
      }
      players[socket.id] = { ...oldPlayer, name, avatar: rawAvatar };
      delete players[oldId];
      if (state.mission && state.mission.playerId === oldId) state.mission.playerId = socket.id;
      const impPos = state.imposterIds.indexOf(oldId);
      if (impPos !== -1) state.imposterIds[impPos] = socket.id;
      io.sockets.sockets.get(oldId)?.disconnect(true);
      writeLog('INFO', 'player_socket_replaced', { name, oldId, socketId: socket.id });
    }
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
        const sameRound = saved.data.roundSeq === roundSeq;
        const { prevId, ...savedData } = saved.data;
        players[socket.id] = {
          ...savedData,
          name,
          avatar: rawAvatar,
          reconnectToken: token,
          answer: sameRound ? (savedData.answer ?? null) : null,
          answeredAt: sameRound ? (savedData.answeredAt || 0) : 0,
        };
        // Imposter-Rolle hängt an der Socket-ID → auf die neue Verbindung umhängen
        if (sameRound && prevId) {
          const impPos = state.imposterIds.indexOf(prevId);
          if (impPos !== -1) state.imposterIds[impPos] = socket.id;
        }
        if (state.mission && state.mission.playerName.toLowerCase() === name.toLowerCase()) {
          state.mission.playerId = socket.id;
        }
        writeLog('INFO', 'player_rejoined', { name, socketId: socket.id, score: players[socket.id].score });
      } else {
        token = crypto.randomBytes(16).toString('base64url');
        players[socket.id] = { name, avatar: rawAvatar, reconnectToken: token, team: null, score: 0, drinks: 0, answer: null, answeredAt: 0, stats: freshStats() };
        writeLog('INFO', 'player_joined', { name, socketId: socket.id });
      }
    }
    ack && ack({ ok: true, reconnectToken: token, myAnswer: players[socket.id].answer });
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
    if (!['question', 'go', 'write', 'discuss', 'result', 'card'].includes(state.phase) || displayMode === 'onedevice') return;
    if (state.phase === 'card' && Date.now() - state.cardShownAt < CARD_SKIP_DELAY_MS) return;
    if (snapVoteBlocked()) return;
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
      else if (state.phase === 'card') cardNext();
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
    io.to(ROOM_CHAN).emit('react', {
      name: p ? p.name : '',
      avatar: p ? (p.avatar || '😎') : '🎉',
      emoji,
    });
  });

  // ack({ ok }) lässt das Handy anzeigen, ob die Antwort angekommen ist (wichtig bei Mobilfunk)
  socket.on('answer', (val, ack) => {
    const reply = ok => { if (typeof ack === 'function') ack({ ok }); };
    if (!allowEvent('answer', 10_000, 20)) return reply(false);
    const p = players[socket.id];
    if (!p || state.paused) return reply(false);

    const m = activeMode();
    if (m === 'reaction') {
      if (p.answer !== null) return reply(false);
      if (state.phase === 'wait') { p.answer = -1; broadcast(); }
      else if (state.phase === 'go') { p.answer = Math.max(1, Date.now() - state.reactionGoAt); broadcast(); }
      else return reply(false);
      reply(true);
      if ((state.phase === 'go' || state.phase === 'wait') && pVals().every(x => x.answer !== null)) {
        if (state.phase === 'go') showResult();
      }
      return;
    }

    if (state.phase !== 'question') return reply(false);
    reply(submitPlayerAnswer(p, val));
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
    markDirty();
  });

  // Zeichnen: Der Client bündelt Punkte (~20 Chunks/s) statt einer Nachricht pro pointermove.
  // Format: { sid, c, w, p: [x0,y0,x1,y1,…] } mit ganzzahligen Koordinaten 0..1000.
  socket.on('draw:stroke', ch => {
    if (!allowEvent('stroke', 2_000, 80)) return;
    const p = players[socket.id];
    if (!p || state.mode !== 'draw' || state.phase !== 'question' || p.name !== state.drawerName) return;
    if (!ch || typeof ch !== 'object' || !Array.isArray(ch.p)) return;
    const pts = ch.p;
    if (pts.length < 4 || pts.length > STROKE_MAX_COORDS || pts.length % 2) return;
    if (!pts.every(n => Number.isInteger(n) && n >= 0 && n <= 1000)) return;
    const { c, w, sid } = ch;
    const clean = {
      c: STROKE_COLORS.has(c) ? c : '#111',
      w: typeof w === 'number' && Number.isFinite(w) ? Math.min(12, Math.max(1, w)) : 6,
      p: pts.slice(),
    };
    if (Number.isInteger(sid) && sid >= 0) clean.sid = sid;
    state.strokes.push(clean);
    if (state.strokes.length > STROKE_HISTORY_MAX) state.strokes.shift();
    socket.to(ROOM_CHAN).emit('draw:stroke', clean);
    markDirty();
  });

  socket.on('draw:undo', () => {
    if (!allowEvent('clear', 5_000, 15)) return;
    const p = players[socket.id];
    if (!p || state.mode !== 'draw' || state.phase !== 'question' || p.name !== state.drawerName) return;
    if (!state.strokes.length) return;
    const lastSid = state.strokes[state.strokes.length - 1]?.sid;
    if (typeof lastSid === 'number') {
      while (state.strokes.length && state.strokes[state.strokes.length - 1]?.sid === lastSid) {
        state.strokes.pop();
      }
    } else {
      state.strokes.splice(Math.max(0, state.strokes.length - 8));
    }
    io.to(ROOM_CHAN).emit('draw:history', state.strokes);
    markDirty();
  });

  socket.on('draw:clear', () => {
    if (!allowEvent('clear', 5_000, 10)) return;
    const p = players[socket.id];
    if (!p || state.mode !== 'draw' || state.phase !== 'question' || p.name !== state.drawerName) return;
    state.strokes = [];
    io.to(ROOM_CHAN).emit('draw:clear');
    markDirty();
  });

  function handleWordGuess(socket, txt, ack, cfg) {
    const p = players[socket.id];
    const actorName = state[cfg.actorKey];
    const word = state[cfg.wordKey];
    const guessed = state[cfg.guessedKey];
    if (!p || !cfg.isActive() || state.phase !== 'question' || p.name === actorName) return;
    if (guessed.includes(p.name)) return;
    if (norm(txt) && norm(txt) === norm(word)) {
      guessed.push(p.name);
      const mult = isFinalRound() ? 2 : 1;
      const pts = Math.max(20, 100 - (guessed.length - 1) * 20) * mult;
      p.score += pts;
      if (p.stats) p.stats.guessedWords++;
      const actor = pVals().find(x => x.name === actorName);
      if (actor && guessed.length === 1) actor.score += 50 * mult;
      p.answer = true;
      p.answeredAt = Date.now();
      ack && ack({ ok: true });
      broadcast();
      const guessers = pVals().filter(x => x.name !== actorName);
      if (guessers.length > 0 && guessers.every(x => guessed.includes(x.name))) showResult();
      return;
    }
    const partial = applyPartialGuess(word, state[cfg.revealedKey], txt);
    if (cfg.emitFeed) {
      io.to(ROOM_CHAN).emit('draw:msg', { name: p.name, text: String(txt || '').slice(0, 30), partial });
    }
    if (partial) broadcast();
    ack && ack({ ok: false, partial });
  }

  socket.on('draw:guess', (txt, ack) => {
    if (!allowEvent('guess', 10_000, 15)) return ack && ack({ ok: false });
    handleWordGuess(socket, txt, ack, {
      isActive: () => state.mode === 'draw',
      actorKey: 'drawerName',
      wordKey: 'drawWord',
      revealedKey: 'drawRevealed',
      guessedKey: 'guessedBy',
      emitFeed: true,
    });
  });

  socket.on('taboo:guess', (txt, ack) => {
    if (!allowEvent('tabooGuess', 10_000, 20)) return ack && ack({ ok: false });
    handleWordGuess(socket, txt, ack, {
      isActive: () => activeMode() === 'taboo',
      actorKey: 'explainerName',
      wordKey: 'tabooWord',
      revealedKey: 'tabooRevealed',
      guessedKey: 'tabooGuessedBy',
      emitFeed: false,
    });
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
    players[id] = { name, avatar, team: null, score: 0, drinks: 0, answer: null, answeredAt: 0, stats: freshStats(), isLocal: true };
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
    if (m === 'pantomime' && name === state.mimeName) {
      return ack && ack({ word: state.mimeWord });
    }
    ack && ack(null);
  });
  socket.on('local:wordGuessed', winnerName => {
    if (displayMode !== 'onedevice' || state.phase !== 'question') return;
    const m = activeMode();
    if (m === 'pantomime') return mimeGuessed(winnerName || null);
    if (m !== 'draw' && m !== 'taboo') return;
    if (!winnerName) return showResult();
    const p = pVals().find(x => x.name === winnerName);
    if (!p) return;
    const mult = isFinalRound() ? 2 : 1;
    if (m === 'draw' && !state.guessedBy.includes(p.name)) {
      state.guessedBy.push(p.name);
      p.score += 100 * mult;
      if (p.stats) p.stats.guessedWords++;
      const drawer = pVals().find(x => x.name === state.drawerName);
      if (drawer) drawer.score += 50 * mult;
    } else if (m === 'taboo' && !state.tabooGuessedBy.includes(p.name)) {
      state.tabooGuessedBy.push(p.name);
      p.score += 100 * mult;
      if (p.stats) p.stats.guessedWords++;
      const exp = pVals().find(x => x.name === state.explainerName);
      if (exp) exp.score += 50 * mult;
    }
    showResult();
  });
  // Pantomime: nur der Darsteller meldet am eigenen Handy, wer es erraten hat (oder niemand) bzw. tauscht den Begriff
  socket.on('mime:guessed', winnerName => {
    const p = players[socket.id];
    if (!p || activeMode() !== 'pantomime' || state.phase !== 'question' || p.name !== state.mimeName) return;
    mimeGuessed(winnerName || null);
  });
  socket.on('mime:skip', () => {
    const p = players[socket.id];
    if (!p || activeMode() !== 'pantomime' || state.phase !== 'question' || p.name !== state.mimeName) return;
    if (state.mimeSkips >= MIME_SKIPS) return;
    // Bevorzugt Begriffe, die weder gespielt noch für spätere Runden eingeplant sind
    const upcoming = new Set(state.mode === 'pantomime' ? state.order.slice(state.idx + 1) : (state.mixPools.pantomime || []));
    const used = usedIndices.pantomime || new Set();
    const all = filteredIndices('pantomime').filter(i => i !== state.mimeIdx);
    const fresh = all.filter(i => !used.has(i) && !upcoming.has(i));
    const pool = fresh.length ? fresh : all.filter(i => !upcoming.has(i)).length ? all.filter(i => !upcoming.has(i)) : all;
    if (!pool.length) return;
    state.mimeSkips++;
    state.mimeIdx = pool[crypto.randomInt(pool.length)];
    state.mimeWord = getPool('pantomime')[state.mimeIdx].w;
    (usedIndices.pantomime || (usedIndices.pantomime = new Set())).add(state.mimeIdx);
    saveUsedIndices();
    broadcast();
  });

  socket.on('host:auth', (secret, ack) => {
    const auth = checkHostAuth(ip, secret, validRoomToken);
    if (!auth.ok) {
      if (!auth.locked) writeLog('WARN', 'host_auth_failed', { ip, socketId: socket.id });
      return ack && ack({ ok: false, error: auth.error });
    }
    socket.data.isHost = true;
    writeLog('INFO', 'host_authenticated', { ip, socketId: socket.id });
    ack && ack({ ok: true });
  });

  // Host / Admin Steuerung (mehrere Geräte im selben Raum erlaubt)
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
    if (ROUND_LIMITS.includes(val)) {
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
    if (!IQ_THEMES.includes(theme)) return;
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
    const valid = [...new Set(arr.filter(t => IQ_THEMES.includes(t)))];
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
  socket.on('host:partyCards', freq => {
    if (freq !== 'off' && !PARTY_CARD_GAP[freq]) return;
    partyCards = freq;
    broadcast();
  });
  socket.on('host:cardResolve', arg => { if (!snapVoteBlocked()) resolvePartyCard(arg); });
  socket.on('host:snapVote', () => startSnapVote());
  // Eigene Party-Karten: type ∈ CUSTOM_CARD_TYPES, where = both|local|remote
  socket.on('host:addCard', (payload, ack) => {
    if (!allowEvent('addCard', 60_000, 20)) return ack && ack({ ok: false, error: 'Zu viele Karten, kurz warten' });
    const type = payload && CUSTOM_CARD_TYPES.includes(payload.type) ? payload.type : null;
    let text = String((payload && payload.text) || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const where = ['local', 'remote'].includes(payload && payload.where) ? payload.where : 'both';
    if (!type) return ack && ack({ ok: false, error: 'Kartentyp fehlt' });
    if (text.length < 5) return ack && ack({ ok: false, error: 'Text zu kurz' });
    if (type === 'duel' && !/\{a\}/.test(text)) text = `{a} gegen {b}: ${text}`;
    const card = { id: `c${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, type, text, where };
    if (where === 'local') card.local = true;
    if (where === 'remote') card.remote = true;
    if (type === 'group') card.sec = 30;
    if (type === 'snap') card.sec = 90;
    if (type === 'crowd' && /foto|selfie|bild/i.test(text)) card.photo = true;
    CUSTOM_CARDS.push(card);
    saveCustomCards();
    writeLog('INFO', 'custom_card_added', { room: code, type, where });
    broadcast();
    ack && ack({ ok: true });
  });
  socket.on('host:delCard', id => {
    const i = CUSTOM_CARDS.findIndex(c => c.id === id);
    if (i < 0) return;
    CUSTOM_CARDS.splice(i, 1);
    saveCustomCards();
    broadcast();
  });
  socket.on('host:remote', on => {
    remoteMode = !!on;
    broadcast();
  });
  // Interaktions-Optionen (an/aus) aus /admin
  const interactionToggles = {
    'host:discussVotes': v => { discussVotes = v; },
    'host:standUp': v => { standUp = v; },
    'host:captainMode': v => { captainMode = v; },
    'host:partnerRounds': v => { partnerRounds = v; },
    'host:duelFinale': v => { duelFinale = v; },
    'host:jokers': v => { jokersOn = v; },
  };
  for (const [ev, set] of Object.entries(interactionToggles)) {
    socket.on(ev, on => { set(!!on); broadcast(); });
  }
  // Joker einsetzen (zwischen den Runden): Doppelt/Abschreiben/Zeitdieb wirken in der nächsten passenden Runde, Punkteklau sofort
  socket.on('joker:use', (payload, ack) => {
    const reply = (ok, error) => { if (typeof ack === 'function') ack({ ok, error }); };
    if (!allowEvent('joker', 10_000, 6)) return reply(false, 'Kurz warten');
    const p = players[socket.id];
    const type = payload && payload.type;
    if (!jokersOn || !p || !JOKER_TYPES.includes(type) || !(p.jokers || []).includes(type)) return reply(false, 'Joker nicht verfügbar');
    if (!['result', 'card', 'spin'].includes(state.phase) || duelActive()) return reply(false, 'Joker gehen nur zwischen den Runden');
    let target = null;
    if (JOKER_TARGETED.includes(type)) {
      target = byName(payload.target);
      if (!target || target === p || target.isLocal) return reply(false, 'Bitte einen Mitspieler wählen');
    }
    if ((state.jokerQueue || []).some(j => j.by === p.name && j.type === type)) return reply(false, 'Schon gespielt – wirkt in der nächsten Runde');
    p.jokers.splice(p.jokers.indexOf(type), 1);
    let detail = '';
    if (type === 'steal') {
      const amt = Math.min(JOKER_STEAL_PTS, target.score || 0);
      target.score -= amt;
      p.score += amt;
      detail = `${amt} Punkte`;
    } else {
      (state.jokerQueue ||= []).push({ type, by: p.name, target: target ? target.name : null });
    }
    writeLog('INFO', 'joker_used', { room: code, type });
    io.to(ROOM_CHAN).emit('joker:played', { by: p.name, type, target: target ? target.name : null, label: JOKER_LABELS[type], detail });
    broadcast();
    reply(true);
  });
  socket.on('card:judge', ok => {
    const card = state.card;
    const p = players[socket.id];
    if (state.phase !== 'card' || !card || card.act !== 'yesno' || card.resolved || !p) return;
    if (!cardJudges(card).includes(p.name)) return;
    card.votes[p.name] = !!ok;
    checkCardJudgement();
  });
  socket.on('card:vote', targetName => {
    const card = state.card;
    const p = players[socket.id];
    if (state.phase !== 'card' || !card || card.resolved || !p) return;
    if (card.act === 'snap') {
      // Ziel = Index des (anonymen) Fotos; das eigene Foto zählt nicht
      const entry = card.stage === 'vote' && Number.isInteger(targetName) ? card.entries[targetName] : null;
      if (!entry || entry.name === p.name || !snapVoters(card).includes(p.name)) return;
      card.votes[p.name] = targetName;
      if (snapVotingDone(card)) return resolvePartyCard();
      return broadcast();
    }
    if (card.act !== 'vote' || !byName(targetName) || targetName === p.name) return;
    card.votes[p.name] = targetName;
    if (pVals().filter(x => !x.isLocal).every(x => card.votes[x.name])) return resolvePartyCard();
    broadcast();
  });
  socket.on('host:timerSpeed', sp => {
    if (TIMER_MULT[sp]) timerSpeed = sp;
    broadcast();
  });
  socket.on('host:mixRounds', n => {
    const val = Number(n);
    if (MIX_ROUND_OPTIONS.includes(val)) mixRounds = val;
    broadcast();
  });
  socket.on('host:preset', preset => {
    if (preset === 'klassik') {
      activeCategories = ['party', 'peinlich'];
      alcoholFree = false;
      timerSpeed = 'normal';
      secretMissions = false;
      mixModes = [...DEFAULT_MIX_MODES];
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
      mixModes = [...DEFAULT_MIX_MODES];
      if (state.phase === 'lobby') state = freshState('mix');
    } else if (preset === 'musik') {
      songLangs = { en: true, de: true };
      songOnlyArtistTitle = false;
      timerSpeed = 'normal';
      if (state.phase === 'lobby') state = freshState('songquiz');
    } else if (preset === 'alkoholfrei') {
      activeCategories = ['party'];
      alcoholFree = true;
      timerSpeed = 'normal';
      mixModes = [...DEFAULT_MIX_MODES];
      if (state.phase === 'lobby') state = freshState('mix');
    }
    broadcast();
  });
  socket.on('host:resolveMission', ok => {
    if (!state.mission || state.mission.resolved) return;
    state.mission.resolved = true;
    state.mission.success = !!ok;
    const missionTarget = players[state.mission.playerId]
      || pVals().find(p => p.name.toLowerCase() === String(state.mission.playerName || '').toLowerCase());
    if (ok && missionTarget) {
      missionTarget.score += MISSION_PTS;
      missionTarget.lastGain = (missionTarget.lastGain || 0) + MISSION_PTS;
    }
    if (state.phase === 'result') {
      armAutoNext(3500);
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
    // Ohne eigenen Raumcode im Link würde der QR-Code nicht in diesen Raum führen → immer ?room=… ergänzen.
    const withRoom = u => { if (!u.searchParams.has('room')) u.searchParams.set('room', code); return u.toString(); };
    if (!trimmed) {
      publicUrl = withRoom(new URL(DEFAULT_URL_PLAY));
      io.to(ROOM_CHAN).emit('info', { url: publicUrl, room: code });
      broadcast();
      return ack && ack({ ok: true, url: publicUrl });
    }
    try {
      const u = new URL(trimmed);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return ack && ack({ ok: false, error: 'Nur http:// oder https://' });
      publicUrl = withRoom(u);
      io.to(ROOM_CHAN).emit('info', { url: publicUrl, room: code });
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
    if (!Array.isArray(roomCustom[mode])) roomCustom[mode] = [];
    roomCustom[mode].push(entry);
    try {
      let saved = {};
      if (fs.existsSync(CUSTOM_FILE)) saved = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')) || {};
      if (!Array.isArray(saved[mode])) saved[mode] = [];
      saved[mode].push(entry);
      fs.writeFile(CUSTOM_FILE, JSON.stringify(saved, null, 2), (err) => {
        if (err) writeLog('WARN', 'custom_json_save_failed', { error: err?.message || String(err) });
      });
    } catch (err) {
      writeLog('WARN', 'custom_json_save_failed', { error: err?.message || String(err) });
    }
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
    else if (state.phase === 'card') cardNext();
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
      if (p.name === name) {
        const gt = pendingDisconnects.get(id);
        if (gt) { clearTimeout(gt); pendingDisconnects.delete(id); }
        delete players[id];
        io.sockets.sockets.get(id)?.disconnect(true);
      }
    }
    recheckOpenCard();
    broadcast();
  });

  socket.on('disconnect', (reason) => {
    roomSockets.delete(socket.id);
    lastActivity = Date.now();
    const p = players[socket.id];
    if (p) {
      const immediate = reason === 'client namespace disconnect' || reason === 'server namespace disconnect';
      if (immediate) {
        finalizePlayerDisconnect(socket.id, reason, socket.recovered);
      } else {
        const prevGt = pendingDisconnects.get(socket.id);
        if (prevGt) clearTimeout(prevGt);
        const gt = setTimeout(() => finalizePlayerDisconnect(socket.id, reason, socket.recovered), RECONNECT_GRACE_MS);
        if (gt.unref) gt.unref();
        pendingDisconnects.set(socket.id, gt);
      }
    } else {
      writeLog('INFO', 'socket_disconnected', { socketId: socket.id, reason });
    }
  });
}

// --- Persistenz (siehe snapshotRooms/restoreRooms): Socket-IDs sind keine Identität,
// Spieler werden beim Wiederherstellen per Name + reconnectToken über disconnectedPlayers zugeordnet ---
let snapDirty = true;
let snapJson = '';
function markDirty() {
  snapDirty = true;
  scheduleRoomsSnapshot();
}

const PLAYER_SNAP_KEYS = ['avatar', 'team', 'score', 'prevScore', 'lastGain', 'streak', 'drinks', 'answer', 'answeredAt', 'stats', 'jokers', 'reconnectToken'];
function playerSnap(name, p, extra) {
  const out = { name };
  for (const k of PLAYER_SNAP_KEYS) if (p[k] !== undefined) out[k] = p[k];
  return extra ? Object.assign(out, extra) : out;
}

function serialize() {
  const { imposterIds, mission, strokes, ...rest } = state;
  const snapPlayers = [];
  const seen = new Set();
  for (const [id, p] of Object.entries(players)) {
    seen.add(p.name.toLowerCase());
    snapPlayers.push(playerSnap(p.name, p, { roundSeq, local: !!p.isLocal, imposter: imposterIds.includes(id) }));
  }
  for (const [key, d] of disconnectedPlayers) {
    if (seen.has(key)) continue;
    snapPlayers.push(playerSnap(d.data.name || key, d.data, {
      roundSeq: d.data.roundSeq, local: false, imposter: !!d.data.prevId && imposterIds.includes(d.data.prevId),
    }));
  }
  return {
    v: 1,
    code,
    hostToken,
    settings: {
      activeCategories, roundLimit, teamMode, displayMode, songLangs, imageQuizThemes, russianShare, songOnlyArtistTitle,
      finalDouble, wheelEnabled, secretMissions, alcoholFree, partyCards, remoteMode, timerSpeed, mixRounds, mixModes, publicUrl,
      discussVotes, standUp, captainMode, partnerRounds, duelFinale, jokersOn,
    },
    // roomCustom wird bewusst nicht gespeichert: host:addCustom schreibt die Einträge nach data/custom.json,
    // die beim Start ohnehin in DATA landen (sonst doppelte Einträge im Pool).
    roundSeq, spinSeq, actorQueues, songKindQueue, lastSongKind,
    skipVotes: [...skipVotes],
    state: {
      ...rest,
      strokes: strokes.length > SNAPSHOT_STROKES_MAX ? strokes.slice(-SNAPSHOT_STROKES_MAX) : strokes,
      mission: mission ? { playerName: mission.playerName, text: mission.text, resolved: mission.resolved, success: mission.success } : null,
    },
    players: snapPlayers,
  };
}

function applySnapshot(snap) {
  const s = snap.settings && typeof snap.settings === 'object' ? snap.settings : {};
  const pickList = (arr, allowed) => (Array.isArray(arr) ? [...new Set(arr.filter(x => allowed.includes(x)))] : []);
  const cats = pickList(s.activeCategories, CATEGORIES);
  if (cats.length) activeCategories = cats;
  if (ROUND_LIMITS.includes(s.roundLimit)) roundLimit = s.roundLimit;
  teamMode = !!s.teamMode;
  if (['tv', 'notv', 'onedevice'].includes(s.displayMode)) displayMode = s.displayMode;
  if (s.songLangs && typeof s.songLangs === 'object') songLangs = { en: !!s.songLangs.en, de: !!s.songLangs.de };
  const themes = pickList(s.imageQuizThemes, IQ_THEMES);
  if (themes.length) imageQuizThemes = themes;
  if (Number.isFinite(s.russianShare)) russianShare = Math.max(0, Math.min(100, Math.round(s.russianShare)));
  songOnlyArtistTitle = !!s.songOnlyArtistTitle;
  if (typeof s.finalDouble === 'boolean') finalDouble = s.finalDouble;
  if (typeof s.wheelEnabled === 'boolean') wheelEnabled = s.wheelEnabled;
  secretMissions = !!s.secretMissions;
  alcoholFree = !!s.alcoholFree;
  if (s.partyCards === 'off' || PARTY_CARD_GAP[s.partyCards]) partyCards = s.partyCards;
  remoteMode = !!s.remoteMode;
  for (const [k, set] of Object.entries({
    discussVotes: v => { discussVotes = v; }, standUp: v => { standUp = v; }, captainMode: v => { captainMode = v; },
    partnerRounds: v => { partnerRounds = v; }, duelFinale: v => { duelFinale = v; }, jokersOn: v => { jokersOn = v; },
  })) if (typeof s[k] === 'boolean') set(s[k]);
  if (TIMER_MULT[s.timerSpeed]) timerSpeed = s.timerSpeed;
  if (MIX_ROUND_OPTIONS.includes(s.mixRounds)) mixRounds = s.mixRounds;
  const mm = pickList(s.mixModes, MIX_MODES_ALL);
  if (mm.length >= 2) mixModes = mm;
  if (typeof s.publicUrl === 'string' && s.publicUrl) publicUrl = s.publicUrl;
  if (Number.isInteger(snap.roundSeq)) roundSeq = snap.roundSeq;
  if (Number.isInteger(snap.spinSeq)) spinSeq = snap.spinSeq;
  if (snap.actorQueues && typeof snap.actorQueues === 'object') actorQueues = snap.actorQueues;
  if (Array.isArray(snap.songKindQueue)) songKindQueue = snap.songKindQueue;
  if (typeof snap.lastSongKind === 'string') lastSongKind = snap.lastSongKind;
  if (Array.isArray(snap.skipVotes)) for (const n of snap.skipVotes) if (typeof n === 'string') skipVotes.add(n);

  const st = snap.state && typeof snap.state === 'object' ? snap.state : {};
  state = Object.assign(freshState('quiz'), st, { imposterIds: [], mission: null });
  if (!MODES.includes(state.mode)) state.mode = 'quiz';
  if (!Array.isArray(state.strokes)) state.strokes = [];
  if (st.mission && typeof st.mission.playerName === 'string') {
    // Rejoin hängt die Mission über playerName wieder an die neue Socket-ID
    state.mission = { ...st.mission, playerId: RESTORED_ID_PREFIX + st.mission.playerName.toLowerCase() };
  }

  let localN = 0;
  for (const ps of Array.isArray(snap.players) ? snap.players : []) {
    if (!ps || typeof ps.name !== 'string' || !ps.name.trim()) continue;
    const name = ps.name.trim().slice(0, 16);
    const data = {
      team: null, score: 0, drinks: 0, answer: null, answeredAt: 0,
      stats: freshStats(),
      ...playerSnap(name, ps),
    };
    if (ps.local) {
      // Ein-Gerät-Spieler haben keine eigene Verbindung → direkt wieder aktiv
      const id = `local:restored:${++localN}`;
      players[id] = { ...data, isLocal: true };
      if (ps.imposter) state.imposterIds.push(id);
      continue;
    }
    const key = name.toLowerCase();
    const prevId = RESTORED_ID_PREFIX + key;
    if (ps.imposter) state.imposterIds.push(prevId);
    const t = setTimeout(() => { disconnectedPlayers.delete(key); markDirty(); }, 900_000);
    if (t.unref) t.unref();
    disconnectedPlayers.set(key, {
      data: { ...data, roundSeq: Number.isInteger(ps.roundSeq) ? ps.roundSeq : -1, prevId },
      timer: t,
    });
  }
  lastActivity = Date.now();
  rearmAfterRestore();
}

// Timer der aktuellen Phase neu stellen. Abgelaufene Deadlines laufen nach kurzer Schonfrist weiter,
// damit die Handys vorher wieder verbunden sind (sonst würden ihre Antworten nicht gewertet).
function rearmAfterRestore() {
  clearTimeout(timer);
  pendingSpinNext = null;
  const delayUntil = deadline => Math.max(RESTORE_GRACE_MS, deadline - Date.now());
  if (state.phase === 'spin') {
    if (!state.spin || String(state.spin.kind || '').startsWith('lobby') || state.idx < 0) {
      state.phase = 'lobby';
      state.spin = null;
      state.deadline = 0;
      state.totalMs = 0;
      return;
    }
    // Weitere (Spieler-)Räder entfallen, der Akteur steht bereits fest
    const seq = roundSeq;
    const m = activeMode();
    const playedIdx = curQIdx();
    pendingSpinNext = () => {
      state.spin = null;
      activateRound(seq, m, playedIdx);
    };
    timer = setTimeout(() => {
      if (state.phase === 'spin' && pendingSpinNext) {
        const fn = pendingSpinNext;
        pendingSpinNext = null;
        fn();
      }
    }, delayUntil(state.deadline));
    return;
  }
  if (state.paused) return; // Pausierte Räume bleiben pausiert (pausedLeft bleibt erhalten)
  if (state.phase === 'wait') {
    timer = setTimeout(startReactionGo, RESTORE_GRACE_MS + 2500 + Math.floor(Math.random() * 3500));
  } else if (state.deadline > 0 && (state.phase === 'question' || state.phase === 'go')) {
    timer = setTimeout(showResult, delayUntil(state.deadline));
    if (state.discussUntil > Date.now()) discussTimer = setTimeout(broadcast, state.discussUntil - Date.now() + 50);
  } else if (state.deadline > 0 && state.phase === 'result') {
    timer = setTimeout(nextRound, delayUntil(state.deadline));
  } else if (state.deadline > 0 && state.phase === 'card' && state.card && state.card.resolved) {
    timer = setTimeout(nextRound, delayUntil(state.deadline));
  } else if (state.deadline > 0 && state.phase === 'card' && state.card && state.card.stage === 'collect') {
    timer = setTimeout(startSnapVote, delayUntil(state.deadline));
  }
}

if (snapshot) applySnapshot(snapshot);

return {
  code,
  hostToken,
  getJoinUrl: () => publicUrl,
  // Neues Foto: TV blendet es kurz ein, Zähler in Admin/Handys aktualisieren
  onPhoto: (photo, { card, name } = {}) => {
    if (card && cardPhoto(name, photo.url, card)) return; // Foto-Challenge: erst bei der Abstimmung zeigen
    const bonus = crowdPhotoBonus(name);
    io.to(ROOM_CHAN).emit('photo:new', bonus ? { ...photo, bonus } : photo);
    broadcast();
  },
  serialize,
  serializeJson: () => {
    if (snapDirty || !snapJson) {
      snapJson = JSON.stringify(serialize());
      snapDirty = false;
    }
    return snapJson;
  },
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
    markDirty(); // nächster Schnappschuss enthält den Raum nicht mehr
    clearTimeout(timer);
    clearTimeout(discussTimer);
    for (const gt of pendingDisconnects.values()) clearTimeout(gt);
    pendingDisconnects.clear();
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

  const ua = String(socket.handshake.headers['user-agent'] || '');
  const device = /iPad|iPhone|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : /Macintosh|Windows|Linux|CrOS/.test(ua) ? 'desktop' : 'other';
  const rawRoom = socket.handshake?.query?.room || socket.handshake?.auth?.room || '';
  const page = String(socket.handshake?.query?.page || '').slice(0, 10);

  // JS-Fehler der Clients landen im Server-Log (gedrosselt), damit Probleme auf Handys sichtbar werden
  socket.on('client:error', e => {
    if (!allowEvent('clientError', 60_000, 5) || !e || typeof e !== 'object') return;
    writeLog('WARN', 'client_error', {
      room: normalizeRoomCode(rawRoom), page, device, ip,
      msg: String(e.msg || '').slice(0, 300),
      src: String(e.src || '').slice(0, 120),
      line: Number(e.line) || 0,
      ver: String(e.ver || '').slice(0, 20),
    });
  });

  const room = getRoom(rawRoom);
  writeLog('INFO', 'socket_connected', {
    socketId: socket.id, room: room ? room.code : null, page, device,
    transport: socket.conn.transport.name, recovered: socket.recovered,
  });
  if (!room) {
    socket.emit('room:error', { error: 'Raum nicht gefunden oder abgelaufen.' });
    return;
  }
  room.attachSocket(socket, ip, allowEvent);
});

if (require.main === module) {
  const restored = loadRoomsFromDisk();
  roomsPersistEnabled = true;
  if (restored.count > 0) scheduleRoomsSnapshot();
  startMetrics();
  server.listen(PORT, HOST, () => console.log(`PartyGame v${APP_VERSION} läuft auf http://${HOST}:${PORT} (Multi-Room)`));

  process.on('uncaughtException', (err) => {
    writeLog('ERROR', 'uncaught_exception', { message: err?.message, stack: err?.stack });
  });

  process.on('unhandledRejection', (reason) => {
    writeLog('ERROR', 'unhandled_rejection', { reason: String(reason) });
  });

  let shuttingDown = false;
  function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    let totalP = 0; for (const r of rooms.values()) totalP += r.getPlayerCount();
    writeLog('INFO', 'server_stopping', { signal, rooms: rooms.size, players: totalP });
    writeRoomsSnapshotSync(); // finaler Stand vor dem Trennen der Sockets
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
  MAX_ROOMS,
  validHostSecret,
  checkHostAuth,
  hostAuthFails,
  getSocketIp,
  createRateLimiter,
  createRoom,
  getRoom,
  rooms,
  snapshotRooms,
  restoreRooms,
  initWordMask,
  applyPartialGuess,
  formatWordMask,
};
