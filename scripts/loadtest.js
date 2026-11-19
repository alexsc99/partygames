#!/usr/bin/env node
'use strict';
/*
 * Lasttest für PartyGame: legt Räume an, verbindet pro Raum einen Host und PLAYERS Bots,
 * spielt ROUNDS Runden und misst Latenzen und Nachrichtenvolumen.
 *
 *   node scripts/loadtest.js [--url URL] [--rooms N] [--players N] [--rounds N] [--mode MODE]
 *   URL=http://localhost:3999 ROOMS=3 PLAYERS=12 ROUNDS=5 MODE=quiz node scripts/loadtest.js
 *
 * Umgebung / Argumente (Argumente haben Vorrang):
 *   URL        Server-Basis-URL             (Standard http://localhost:3999)
 *   ROOMS      Anzahl Räume                 (Standard 3)
 *   PLAYERS    Bots pro Raum, max. 12       (Standard 12)
 *   ROUNDS     gespielte Runden pro Raum    (Standard 5)
 *   MODE       Spielmodus                   (Standard quiz)
 *   TIMEOUT_S  globales Zeitlimit in s      (Standard 180)
 *   HOST_SECRET  falls gesetzt: Räume am Ende per DELETE /api/rooms/<code> löschen
 *   FAKE_IPS   1 (Standard) = jeder Socket sendet eine eigene X-Forwarded-For-Adresse (198.18.x.y),
 *              wie echte Handys; sonst greift das Limit von 25 Verbindungen pro IP. Wirkt nur bei
 *              direkter Verbindung aus dem lokalen Netz. 0 = aus.
 *
 * Messwerte (JSON auf stdout):
 *   ackMs       answer-Emit bis Ack-Callback
 *   ownStateMs  answer-Emit bis der eigene answered-Haken im nächsten state ankommt
 *   fanoutMs    answer-Emit bis jeder andere Client des Raums (Bots + Host) den Haken sieht
 *   nextMs      host:next bis der Host den state der nächsten Phase erhält
 *   stateMsgs   state-Nachrichten und Bytes (JSON.stringify-Länge) pro Bot / Host
 *   clientLoopLagP99Ms  Event-Loop-Lag dieses Lasttest-Prozesses (hoch = Messwerte verfälscht)
 * Exit-Code 0 bei Erfolg, 1 bei Abbruch (Fehler oder Zeitlimit).
 */

const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

let io;
try {
  ({ io } = require('socket.io-client'));
} catch {
  console.error('socket.io-client fehlt – im Repo "npm install" (devDependencies) ausführen.');
  process.exit(1);
}

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/loadtest.js [--url URL] [--rooms N] [--players N] [--rounds N] [--mode MODE] [--timeout S]');
      process.exit(0);
    }
    const m = /^--?([a-z]+)(?:=(.*))?$/i.exec(a);
    if (!m) continue;
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : argv[++i];
  }
  return out;
}
const args = parseArgs();
const opt = (name, def) => args[name.toLowerCase()] ?? process.env[name] ?? def;
const cfg = {
  url: String(opt('URL', 'http://localhost:3999')).replace(/\/+$/, ''),
  rooms: Math.max(1, parseInt(opt('ROOMS', 3), 10) || 3),
  players: Math.max(1, parseInt(opt('PLAYERS', 12), 10) || 12),
  rounds: Math.max(1, parseInt(opt('ROUNDS', 5), 10) || 5),
  mode: String(opt('MODE', 'quiz')),
  timeoutS: Math.max(10, parseInt(args.timeout ?? process.env.TIMEOUT_S ?? 180, 10) || 180),
  hostSecret: process.env.HOST_SECRET || '',
  fakeIps: String(process.env.FAKE_IPS ?? '1') !== '0',
};
// Host-Rundenwahl: 5 / 10 / 15, sonst 0 = alle
const roundLimit = [5, 10, 15].find(n => n >= cfg.rounds) ?? 0;

const now = () => performance.now();
const rnd = n => Math.floor(Math.random() * n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = rnd(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

const loopLag = monitorEventLoopDelay({ resolution: 10 });
loopLag.enable();

const stats = {
  ackMs: [], ownStateMs: [], fanoutMs: [], nextMs: [],
  answersSent: 0, answersOk: 0, answersRejected: 0, ackTimeouts: 0,
  connectErrors: 0, joinFailed: 0, joinErrors: {}, disconnects: 0, unsupportedQuestions: 0,
};
const sockets = [];
const timers = new Set();
const rooms = [];
const startedAt = now();

function later(ms, fn) {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  timers.add(t);
  return t;
}

function connect(code, page, ip) {
  const opts = { query: { room: code, page }, transports: ['websocket'], forceNew: true, reconnection: false, timeout: 10_000 };
  if (cfg.fakeIps) opts.extraHeaders = { 'x-forwarded-for': ip };
  const s = io(cfg.url, opts);
  sockets.push(s);
  return s;
}

function waitConnect(s) {
  return new Promise((resolve, reject) => {
    if (s.connected) return resolve();
    s.once('connect', resolve);
    s.once('connect_error', err => { stats.connectErrors++; reject(err); });
  });
}

function emitAck(s, ev, arg, ms = 5000) {
  return new Promise((resolve, reject) => {
    s.timeout(ms).emit(ev, arg, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

// Gültige Antwort je Modus (nicht unterstützt: truthlie, draw, taboo, reaction, imposter-Diskussion)
function pickAnswer(st, self) {
  const q = st.q || {};
  switch (st.mode) {
    case 'quiz': case 'imagequiz': case 'teams': case 'songquiz':
      return Array.isArray(q.a) && q.a.length ? rnd(q.a.length) : null;
    case 'wouldyourather': return rnd(2);
    case 'mostlikely': case 'imposter': {
      const names = (st.players || []).map(p => p.name).filter(n => n !== self);
      return names.length ? names[rnd(names.length)] : null;
    }
    case 'estimate': return rnd(1000);
    case 'scale': return 1 + rnd(10);
    case 'neverhavei': return Math.random() < 0.5;
    case 'sort': return shuffle([0, 1, 2, 3]);
    case 'icebreaker': return `Lasttest ${self}`;
    case 'wordassoc': return `wort${rnd(100)}`;
    default: return null;
  }
}

// Fan-out: wann sieht jeder Empfänger den answered-Haken eines Bots?
function trackAnswered(room, receiverId, st, t) {
  if (!room.pending.size || !Array.isArray(st.players)) return;
  const answered = new Set();
  for (const p of st.players) if (p.answered) answered.add(p.name);
  for (const [name, e] of room.pending) {
    if (st.idx !== e.idx || !answered.has(name) || !e.waiting.has(receiverId)) continue;
    e.waiting.delete(receiverId);
    (receiverId === e.botId ? stats.ownStateMs : stats.fanoutMs).push(t - e.t0);
    if (!e.waiting.size) room.pending.delete(name);
  }
}

function countState(client, st) {
  const bytes = JSON.stringify(st).length;
  client.states++;
  client.bytes += bytes;
  if (bytes > client.maxMsgBytes) client.maxMsgBytes = bytes;
}

async function createRoom(i) {
  const res = await fetch(`${cfg.url}/api/rooms`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.code || !body.hostToken) throw new Error(`POST /api/rooms: HTTP ${res.status} ${body.error || ''}`.trim());
  const room = {
    i, code: body.code, hostToken: body.hostToken, bots: [], pending: new Map(),
    rounds: 0, lastResultIdx: null, last: null, nextSentAt: 0, nextFromIdx: null, done: false,
  };
  room.finished = new Promise(r => { room.finish = () => { if (!room.done) { room.done = true; r(); } }; });
  rooms.push(room);
  return room;
}

async function setupHost(room) {
  const host = { id: `h${room.i}`, states: 0, bytes: 0, maxMsgBytes: 0 };
  const s = connect(room.code, 'host', `198.18.${room.i % 256}.250`);
  host.socket = s;
  room.host = host;
  s.on('disconnect', () => { if (!room.done) stats.disconnects++; });
  s.on('state', st => {
    const t = now();
    countState(host, st);
    room.last = st;
    trackAnswered(room, host.id, st, t);
    if (room.done) return;
    if (room.nextSentAt && (st.phase !== 'result' || st.idx !== room.nextFromIdx)) {
      stats.nextMs.push(t - room.nextSentAt);
      room.nextSentAt = 0;
    }
    if (st.phase === 'end') return room.finish();
    if (st.phase === 'result' && st.idx !== room.lastResultIdx) {
      room.lastResultIdx = st.idx;
      room.rounds++;
      if (room.rounds >= cfg.rounds) return room.finish();
      const idx = st.idx;
      later(1500, () => {
        // nur weiterschalten, wenn der Server nicht schon selbst weitergeschaltet hat
        if (room.done || room.last.phase !== 'result' || room.last.idx !== idx) return;
        room.nextFromIdx = idx;
        room.nextSentAt = now();
        s.emit('host:next');
      });
    }
  });
  await waitConnect(s);
  const auth = await emitAck(s, 'host:auth', room.hostToken);
  if (!auth || !auth.ok) throw new Error(`host:auth in ${room.code}: ${auth && auth.error}`);
  s.emit('host:wheelEnabled', false);
  s.emit('host:rounds', roundLimit);
  s.emit('host:mode', cfg.mode);
  const t0 = Date.now();
  while (!(room.last && room.last.mode === cfg.mode && room.last.roundLimit === roundLimit)) {
    if (Date.now() - t0 > 5000) throw new Error(`Modus "${cfg.mode}" wurde in ${room.code} nicht übernommen`);
    await sleep(50);
  }
}

async function setupBot(room, n) {
  const name = `Bot${n}`;
  const bot = { id: `b${room.i}-${n}`, name, room, states: 0, bytes: 0, maxMsgBytes: 0, privMsgs: 0, last: null, answeredKey: null, joined: false };
  const s = connect(room.code, 'play', `198.18.${room.i % 256}.${n}`);
  bot.socket = s;
  s.on('disconnect', () => { if (!room.done) stats.disconnects++; });
  s.on('private', () => { bot.privMsgs++; });
  s.on('state', st => {
    const t = now();
    countState(bot, st);
    bot.last = st;
    trackAnswered(room, bot.id, st, t);
    if (!bot.joined || room.done || st.phase !== 'question') return;
    const key = `${st.idx}|${st.mode}`;
    if (bot.answeredKey === key) return;
    bot.answeredKey = key;
    later(300 + rnd(2201), () => answer(bot, key));
  });
  await waitConnect(s);
  const res = await emitAck(s, 'join', { name });
  if (!res || !res.ok) {
    stats.joinFailed++;
    const err = (res && res.error) || 'unbekannt';
    stats.joinErrors[err] = (stats.joinErrors[err] || 0) + 1;
    s.disconnect();
    return;
  }
  bot.joined = true;
  room.bots.push(bot);
}

function answer(bot, key) {
  const { room, last: st } = bot;
  if (room.done || !st || st.phase !== 'question' || `${st.idx}|${st.mode}` !== key || !bot.socket.connected) return;
  const val = pickAnswer(st, bot.name);
  if (val === null) { stats.unsupportedQuestions++; return; }
  const receivers = new Set([room.host.id]);
  for (const b of room.bots) if (b.socket.connected) receivers.add(b.id);
  const t0 = now();
  room.pending.set(bot.name, { t0, idx: st.idx, botId: bot.id, waiting: receivers });
  stats.answersSent++;
  bot.socket.timeout(5000).emit('answer', val, (err, res) => {
    if (err) { stats.ackTimeouts++; return; }
    stats.ackMs.push(now() - t0);
    if (res && res.ok) stats.answersOk++; else stats.answersRejected++;
  });
}

function pct(arr) {
  if (!arr.length) return { n: 0 };
  const a = Float64Array.from(arr).sort();
  const at = p => a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];
  const r = v => Math.round(v * 10) / 10;
  return { n: a.length, p50: r(at(50)), p95: r(at(95)), p99: r(at(99)), max: r(a[a.length - 1]) };
}

function msgStats(clients) {
  if (!clients.length) return { clients: 0 };
  const msgs = clients.map(c => c.states);
  const bytes = clients.map(c => c.bytes);
  const sum = xs => xs.reduce((s, x) => s + x, 0);
  const totalMsgs = sum(msgs), totalBytes = sum(bytes);
  return {
    clients: clients.length,
    msgsPerClientAvg: Math.round(totalMsgs / clients.length),
    msgsPerClientMax: Math.max(...msgs),
    kbPerClientAvg: Math.round(totalBytes / clients.length / 102.4) / 10,
    kbPerClientMax: Math.round(Math.max(...bytes) / 102.4) / 10,
    avgMsgBytes: totalMsgs ? Math.round(totalBytes / totalMsgs) : 0,
    maxMsgBytes: Math.max(...clients.map(c => c.maxMsgBytes)),
    totalMsgs,
    totalKb: Math.round(totalBytes / 102.4) / 10,
  };
}

let finishing = false;
async function finish(reason) {
  if (finishing) return;
  finishing = true;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  for (const r of rooms) r.finish();
  const bots = rooms.flatMap(r => r.bots);
  const summary = {
    result: reason,
    url: cfg.url, mode: cfg.mode, rooms: cfg.rooms, playersPerRoom: cfg.players, rounds: cfg.rounds, hostRoundLimit: roundLimit,
    durationS: Math.round((now() - startedAt) / 100) / 10,
    roundsPlayed: rooms.map(r => r.rounds),
    answers: { sent: stats.answersSent, ok: stats.answersOk, rejected: stats.answersRejected, ackTimeouts: stats.ackTimeouts, unsupported: stats.unsupportedQuestions },
    ackMs: pct(stats.ackMs),
    ownStateMs: pct(stats.ownStateMs),
    fanoutMs: pct(stats.fanoutMs),
    nextMs: pct(stats.nextMs),
    stateMsgs: { bots: msgStats(bots), hosts: msgStats(rooms.filter(r => r.host).map(r => r.host)) },
    privateMsgs: bots.reduce((s, b) => s + b.privMsgs, 0),
    errors: { connect: stats.connectErrors, joinFailed: stats.joinFailed, joinErrors: stats.joinErrors, disconnects: stats.disconnects },
    clientLoopLagP99Ms: Math.round(loopLag.percentile(99) / 1e5) / 10,
  };
  loopLag.disable();
  for (const s of sockets) s.disconnect();
  if (cfg.hostSecret) {
    summary.roomsDeleted = 0;
    await Promise.all(rooms.map(async r => {
      try {
        const res = await fetch(`${cfg.url}/api/rooms/${r.code}`, { method: 'DELETE', headers: { 'x-host-secret': cfg.hostSecret }, signal: AbortSignal.timeout(5000) });
        if (res.ok) summary.roomsDeleted++;
      } catch { /* Raum läuft nach 30 min Leerlauf ohnehin ab */ }
    }));
  }
  const code = reason === 'ok' ? 0 : 1;
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n', () => process.exit(code));
}

async function main() {
  const hardStop = setTimeout(() => finish('timeout'), cfg.timeoutS * 1000);
  hardStop.unref();
  process.once('SIGINT', () => finish('interrupted'));
  if (cfg.players > 12) console.error(`Hinweis: Server erlaubt max. 12 Spieler pro Raum, ${cfg.players} angefragt.`);

  for (let i = 0; i < cfg.rooms; i++) await createRoom(i);
  await Promise.all(rooms.map(setupHost));
  await Promise.all(rooms.flatMap(r => Array.from({ length: cfg.players }, (_, n) => setupBot(r, n + 1).catch(err => {
    stats.joinFailed++;
    const e = String(err && err.message || err);
    stats.joinErrors[e] = (stats.joinErrors[e] || 0) + 1;
  }))));
  if (!rooms.some(r => r.bots.length)) throw new Error('kein Bot konnte beitreten');
  for (const r of rooms) {
    if (r.bots.length) r.host.socket.emit('host:start');
    else r.finish();
  }
  await Promise.all(rooms.map(r => r.finished));
  await finish('ok');
}

main().catch(err => {
  console.error(`Lasttest abgebrochen: ${err && err.message || err}`);
  finish('error');
});
