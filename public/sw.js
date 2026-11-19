// Service Worker der Partygames.
// Grundsatz: HTML ist immer network-first (frische Seite gewinnt), damit nie eine neue Seite mit alten
// Helfer-Dateien (oder umgekehrt) kombiniert wird. Gecacht wird nur, was über den Inhalts-Hash
// eindeutig versioniert ist oder harmlos veralten darf. Song-Audio, Range-Requests, Socket.IO-Transport
// und alle dynamischen Endpunkte werden nicht angefasst.
'use strict';

const VERSION = 'v2';
const SHELL_CACHE = `pg-shell-${VERSION}`;   // HTML-Seiten (Fallback offline/langsam), Key = Pfad ohne Query
const ASSET_CACHE = `pg-asset-${VERSION}`;   // ?v=<hash>-Assets, Socket.IO-Client, Icon/Manifest
const MEDIA_CACHE = `pg-media-${VERSION}`;   // Song-Cover und Quiz-Bilder (LRU-begrenzt)
const KNOWN_CACHES = new Set([SHELL_CACHE, ASSET_CACHE, MEDIA_CACHE]);

const PAGE_PATHS = new Set(['/', '/play', '/host', '/admin', '/rooms', '/room']);
const HASHED_ASSETS = new Set(['/style.css', '/js/ux-helpers.js']);
const SWR_ASSETS = new Set(['/socket.io/socket.io.min.js', '/icon.svg', '/manifest.json']);
const PRECACHE = ['/icon.svg', '/manifest.json'];
const NAV_TIMEOUT_MS = 3000;
const MEDIA_MAX_ENTRIES = 80;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Best effort: ein fehlgeschlagenes Precache darf die Installation nicht verhindern.
    try {
      const cache = await caches.open(ASSET_CACHE);
      await cache.addAll(PRECACHE);
    } catch {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('pg-') && !KNOWN_CACHES.has(n)).map(n => caches.delete(n)));
    // Navigation Preload: Seitenabruf startet parallel zum SW-Start → kein Zusatz-Delay für network-first.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return;                                   // Audio/Video: Browser regelt Range selbst
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;

  if (PAGE_PATHS.has(p) && (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html'))) {
    event.respondWith(networkFirstPage(event, url));
    return;
  }
  if (HASHED_ASSETS.has(p)) {
    if (url.searchParams.has('v')) event.respondWith(cacheFirstHashed(event, url));
    return;                                                               // ohne ?v: immer Netz (Server revalidiert)
  }
  if (SWR_ASSETS.has(p) && !url.search) {
    event.respondWith(staleWhileRevalidate(event, req));
    return;
  }
  if (p.startsWith('/song-art/') || p.startsWith('/iq/')) {
    event.respondWith(cacheFirstMedia(event, req));
    return;
  }
  // Alles andere (/song-audio/, /socket.io/-Transport, /api/, /qr.png, /info, /health, …): nicht abfangen.
});

function isCacheableHtml(res) {
  return res && res.ok && res.status === 200 && res.type === 'basic' && !res.redirected
    && (res.headers.get('content-type') || '').includes('text/html');
}

async function networkFirstPage(event, url) {
  const key = url.origin + url.pathname;                                  // Raum steht in location.search → Pfad genügt
  let cachePut = null;
  const network = (async () => {
    // Preload/Seitenabruf sind wegen ETag oft bedingt (304) → dann selbst holen: der HTTP-Cache
    // revalidiert und liefert dem SW ein vollständiges 200.
    const pre = await event.preloadResponse;
    const res = pre && pre.status === 200
      ? pre
      : await fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' });
    // Kopie sofort ziehen, bevor die Response an den Browser geht (Body sonst evtl. schon gelesen).
    if (isCacheableHtml(res)) {
      const copy = res.clone();
      cachePut = caches.open(SHELL_CACHE).then(c => c.put(key, copy));
    }
    return res;
  })();
  // waitUntil synchron registrieren: hält den Worker für das Cache-Update am Leben, auch wenn
  // respondWith wegen Timeout längst mit der Cache-Kopie beantwortet wurde.
  event.waitUntil(network.then(() => cachePut).catch(() => {}));

  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), NAV_TIMEOUT_MS); });
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout' && first.status < 500) return first;          // 5xx (z. B. Proxy während Neustart) → Cache bevorzugen
  } catch {
    // Netzwerkfehler → Cache-Fallback unten
  } finally {
    clearTimeout(timer);
  }
  const cached = await caches.match(key, { cacheName: SHELL_CACHE });
  if (cached) return cached;
  return network;                                                         // nichts gecacht: Netz-Antwort bzw. Fehler durchreichen
}

async function cacheFirstHashed(event, url) {
  const req = event.request;
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  // Nur speichern, wenn der Server den Hash bestätigt (immutable). Bei veraltetem ?v liefert er den
  // aktuellen Inhalt mit no-cache – der darf nie unter der alten Versions-URL landen.
  if (res.ok && res.type === 'basic' && (res.headers.get('cache-control') || '').includes('immutable')) {
    const copy = res.clone();
    event.waitUntil((async () => {
      await cache.put(req, copy);
      // Ältere Versionen derselben Datei entfernen.
      for (const k of await cache.keys()) {
        const ku = new URL(k.url);
        if (ku.pathname === url.pathname && ku.search !== url.search) await cache.delete(k);
      }
    })().catch(() => {}));
  }
  return res;
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);
  const refresh = fetch(req).then(async res => {
    if (res.ok && res.type === 'basic') await cache.put(req, res.clone());
    return res;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  return refresh;
}

async function cacheFirstMedia(event, req) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.status === 200 && res.type === 'basic') {
    event.waitUntil(cache.put(req, res.clone()).then(() => trimCache(cache, MEDIA_MAX_ENTRIES)).catch(() => {}));
  }
  return res;
}

// Ältestes zuerst entfernen (Cache.keys() liefert Einfügereihenfolge).
async function trimCache(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
