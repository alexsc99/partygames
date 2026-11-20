// Foto-Wand: Fotos pro Raumcode in data/photos/<CODE>/ – unabhängig davon, ob der Raum noch läuft.
// Fotos bleiben PHOTO_TTL_MS auf der Platte und werden dann automatisch gelöscht.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PHOTO_TTL_MS = 3 * 24 * 3600_000;
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
const PHOTO_MAX_PER_ROOM = 400;
const PHOTO_MAX_TOTAL_BYTES = (Number(process.env.PARTYGAME_PHOTO_MAX_MB) || 5000) * 1024 * 1024; // Schutz vor vollgeschriebener Platte
const CODE_RE = /^[A-Z0-9]{4,6}$/;
const ID_RE = /^\d{13}-[a-f0-9]{8}$/;

function createPhotoStore(dir) {
  // code -> { mtimeMs, photos }. Gültig, solange sich der Raum-Ordner nicht ändert – löscht ein Admin per SSH
  // ein Foto, ändert sich die mtime des Ordners und die Liste wird neu (ohne fehlende Dateien) eingelesen.
  const cache = new Map();
  let totalBytes = null; // belegter Platz aller Fotos, lazy berechnet

  const roomDir = code => path.join(dir, code);
  const metaFile = code => path.join(roomDir(code), 'meta.json');
  const dirMtime = code => { try { return fs.statSync(roomDir(code)).mtimeMs; } catch { return -1; } };

  function list(code) {
    if (!CODE_RE.test(code)) return [];
    const mtimeMs = dirMtime(code);
    if (mtimeMs < 0) { cache.delete(code); return []; }
    const hit = cache.get(code);
    if (hit && hit.mtimeMs === mtimeMs) return hit.photos;
    let photos = [];
    try {
      const raw = JSON.parse(fs.readFileSync(metaFile(code), 'utf8'));
      if (Array.isArray(raw)) photos = raw.filter(p => p && ID_RE.test(p.id) && fs.existsSync(path.join(roomDir(code), `${p.id}.jpg`)));
    } catch { /* noch keine Fotos */ }
    cache.set(code, { mtimeMs, photos });
    return photos;
  }

  function computeTotal() {
    let sum = 0;
    let codes = [];
    try { codes = fs.readdirSync(dir).filter(c => CODE_RE.test(c)); } catch { return 0; }
    for (const code of codes) {
      for (const f of fs.readdirSync(roomDir(code))) {
        if (f.endsWith('.jpg')) { try { sum += fs.statSync(path.join(roomDir(code), f)).size; } catch { /* gerade gelöscht */ } }
      }
    }
    return sum;
  }

  // Gruppe darf schreiben/löschen (Dienst läuft als „games“, Admins sind in der Gruppe): Ordner 2775, Dateien 664.
  // chmod explizit, weil die umask des Dienstes (022) die Rechte beim Anlegen sonst beschneidet.
  function writeShared(file, data) {
    fs.writeFileSync(file, data);
    fs.chmodSync(file, 0o664);
  }
  function ensureRoomDir(code) {
    if (fs.existsSync(roomDir(code))) return;
    const rootExisted = fs.existsSync(dir);
    fs.mkdirSync(roomDir(code), { recursive: true });
    if (!rootExisted) fs.chmodSync(dir, 0o2775);
    fs.chmodSync(roomDir(code), 0o2775);
  }

  function saveMeta(code, photos) {
    const tmp = `${metaFile(code)}.${process.pid}.tmp`;
    writeShared(tmp, JSON.stringify(photos));
    fs.renameSync(tmp, metaFile(code));
    cache.set(code, { mtimeMs: dirMtime(code), photos });
  }

  const exists = code => CODE_RE.test(code) && fs.existsSync(roomDir(code));
  const isJpeg = buf => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

  function add(code, buf, name) {
    if (!CODE_RE.test(code)) return { error: 'Ungültiger Raum' };
    if (!Buffer.isBuffer(buf) || !isJpeg(buf)) return { error: 'Nur JPEG-Bilder' };
    const photos = list(code);
    if (photos.length >= PHOTO_MAX_PER_ROOM) return { error: 'Foto-Limit für diesen Raum erreicht' };
    if (totalBytes === null) totalBytes = computeTotal();
    if (totalBytes + buf.length > PHOTO_MAX_TOTAL_BYTES) return { error: 'Foto-Speicher ist voll' };
    ensureRoomDir(code);
    const ts = Date.now();
    const id = `${ts}-${crypto.randomBytes(4).toString('hex')}`;
    writeShared(path.join(roomDir(code), `${id}.jpg`), buf);
    totalBytes += buf.length;
    // key: Lösch-Schlüssel nur für den Hochladenden (bleibt in meta.json, nie in der öffentlichen Liste)
    const entry = { id, name: String(name || '').trim().slice(0, 16), ts, key: crypto.randomBytes(12).toString('hex') };
    saveMeta(code, [...photos, entry]);
    return { entry };
  }

  const keyMatches = (code, id, key) => {
    const p = list(code).find(x => x.id === id);
    if (!p || typeof p.key !== 'string' || typeof key !== 'string' || key.length !== p.key.length) return false;
    return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(p.key));
  };

  // Ein Foto löschen (z. B. aus Versehen hochgeladen); gibt den entfernten Eintrag zurück oder null
  function remove(code, id) {
    const photos = list(code);
    const p = photos.find(x => x.id === id);
    if (!p) return null;
    fs.rmSync(path.join(roomDir(code), `${id}.jpg`), { force: true });
    saveMeta(code, photos.filter(x => x !== p));
    totalBytes = null; // beim nächsten Upload neu zählen
    return p;
  }

  const file = (code, id) => (CODE_RE.test(code) && ID_RE.test(id) ? path.join(roomDir(code), `${id}.jpg`) : null);

  // Alles älter als PHOTO_TTL_MS löschen, leere Raum-Ordner entfernen
  function cleanup(now = Date.now()) {
    let removed = 0;
    let codes = [];
    try { codes = fs.readdirSync(dir).filter(c => CODE_RE.test(c)); } catch { return 0; }
    for (const code of codes) {
      const photos = list(code);
      const keep = photos.filter(p => now - p.ts < PHOTO_TTL_MS);
      for (const p of photos) {
        if (keep.includes(p)) continue;
        fs.rmSync(path.join(roomDir(code), `${p.id}.jpg`), { force: true });
        removed++;
      }
      if (keep.length) {
        if (keep.length !== photos.length) saveMeta(code, keep);
      } else {
        fs.rmSync(roomDir(code), { recursive: true, force: true });
        cache.delete(code);
      }
    }
    totalBytes = null; // nach dem Aufräumen beim nächsten Upload neu zählen (erfasst auch manuell gelöschte Fotos)
    return removed;
  }

  // ZIP ohne Kompression (JPEGs sind schon komprimiert), Datei für Datei asynchron gestreamt (mit Backpressure),
  // damit ein großer Download weder den Server blockiert noch das ganze Archiv im RAM hält.
  async function streamZip(code, out) {
    const photos = list(code);
    const central = [];
    let offset = 0;
    const write = async b => {
      offset += b.length;
      if (!out.write(b)) await new Promise(res => { out.once('drain', res); out.once('close', res); });
    };
    for (const [i, p] of photos.entries()) {
      if (out.destroyed) return;
      let data;
      try { data = await fs.promises.readFile(path.join(roomDir(code), `${p.id}.jpg`)); } catch { continue; }
      const d = new Date(p.ts);
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const fname = Buffer.from(`party-${code}-${String(i + 1).padStart(3, '0')}${p.name ? `-${p.name.replace(/[^\p{L}\p{N}_-]+/gu, '_')}` : ''}.jpg`, 'utf8');
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8-Namen
      local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(fname.length, 26); local.writeUInt16LE(0, 28);
      const at = offset;
      await write(local); await write(fname); await write(data);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(0, 10); cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14);
      cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(fname.length, 28); cen.writeUInt32LE(at, 42);
      central.push(Buffer.concat([cen, fname]));
    }
    const cdStart = offset;
    for (const c of central) await write(c);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    out.end(end);
  }

  return { list, add, exists, file, cleanup, streamZip, keyMatches, remove };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

module.exports = { createPhotoStore, PHOTO_TTL_MS, PHOTO_MAX_BYTES };
