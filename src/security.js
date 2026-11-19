const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST_SECRET_FILE = path.join(__dirname, '..', 'data', '.host-secret');
if (!fs.existsSync(HOST_SECRET_FILE)) {
  fs.writeFileSync(HOST_SECRET_FILE, crypto.randomBytes(4).toString('hex'), { mode: 0o600, flag: 'wx' });
}
const HOST_SECRET = fs.readFileSync(HOST_SECRET_FILE, 'utf8').trim();
const hostAuthFails = new Map();

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://party.goldens.cloud,http://palworld:3002,http://localhost:3002,http://127.0.0.1:3002')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

function validHostSecret(val) {
  if (typeof val !== 'string') return false;
  const a = Buffer.from(val.trim());
  const b = Buffer.from(HOST_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isPrivateAddr(addr) {
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    /^(::ffff:)?(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr) ||
    /^fe80:/i.test(addr)
  );
}

function isLocalDirectSocket(reqOrHandshake) {
  const headers = reqOrHandshake.headers || {};
  if (headers['x-forwarded-for'] || headers['x-real-ip'] || headers['cf-connecting-ip']) return false;
  const addr = reqOrHandshake.socket?.remoteAddress || reqOrHandshake.address || '';
  return !!addr && isPrivateAddr(addr);
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Der Proxy hängt die echte Client-IP rechts an X-Forwarded-For an; Einträge weiter links kann der
// Client selbst mitschicken (fälschbar). Daher von rechts die erste nicht-private Adresse nehmen.
function getSocketIp(socket) {
  const peerAddr = socket.handshake.address || '';
  if (isPrivateAddr(peerAddr)) {
    const xff = socket.handshake.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const hops = xff.split(',').map(s => s.trim()).filter(Boolean);
      for (let i = hops.length - 1; i >= 0; i--) {
        if (!isPrivateAddr(hops[i])) return hops[i];
      }
      return hops[0];
    }
  }
  return peerAddr || 'unknown';
}

function checkHostAuth(ip, secret, extraValidFn = null) {
  const now = Date.now();
  let fail = hostAuthFails.get(ip);
  if (fail && now > fail.resetAt) {
    hostAuthFails.delete(ip);
    fail = null;
  }
  if (fail && fail.count >= 5) {
    return { ok: false, locked: true, error: 'Zu viele Fehlversuche' };
  }
  const isValid = validHostSecret(secret) || (typeof extraValidFn === 'function' && extraValidFn(secret));
  if (!isValid) {
    fail = fail || { count: 0, resetAt: now + 60_000 };
    fail.count++;
    hostAuthFails.set(ip, fail);
    if (hostAuthFails.size > 2000) {
      for (const [k, v] of hostAuthFails) { if (now > v.resetAt) hostAuthFails.delete(k); }
    }
    return { ok: false, locked: false, error: 'Ungültiger Host-PIN' };
  }
  hostAuthFails.delete(ip);
  return { ok: true, locked: false };
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

module.exports = {
  HOST_SECRET,
  ALLOWED_ORIGINS,
  hostAuthFails,
  validHostSecret,
  checkHostAuth,
  isLocalDirectSocket,
  getClientIp,
  getSocketIp,
  isAllowedOrigin,
  createRateLimiter,
};
