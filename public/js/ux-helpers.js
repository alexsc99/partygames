(function () {
  let wakeLock = null;
  let videoEl = null;
  let videoActive = false;
  let useVideoFallback = false;
  let statusCb = null;

  function notifyStatus() {
    if (typeof statusCb !== 'function') return;
    const active = Boolean(wakeLock || videoActive);
    const mode = wakeLock && videoActive ? 'wakelock+video' : wakeLock ? 'wakelock' : videoActive ? 'video' : 'idle';
    try {
      statusCb({ active, mode });
    } catch {}
  }

  function ensureVideoEl() {
    if (videoEl || !document.body) return videoEl;
    const v = document.createElement('video');
    v.src = '/keepalive.mp4';
    v.loop = true;
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.tabIndex = -1;
    v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.001;pointer-events:none;left:0;bottom:0;z-index:-1;';
    v.addEventListener('playing', () => { videoActive = true; notifyStatus(); });
    v.addEventListener('pause', () => { videoActive = false; notifyStatus(); });
    document.body.appendChild(v);
    videoEl = v;
    return videoEl;
  }

  async function startVideoKeepalive() {
    if (!useVideoFallback || document.visibilityState !== 'visible') return false;
    const v = ensureVideoEl();
    if (!v) return false;
    if (!v.paused) {
      videoActive = true;
      notifyStatus();
      return true;
    }
    try {
      await v.play();
      videoActive = !v.paused;
      notifyStatus();
      return videoActive;
    } catch {
      return false;
    }
  }

  async function acquireWakeLock(fromGesture = false) {
    if (document.visibilityState !== 'visible') return;
    if ('wakeLock' in navigator && !wakeLock) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
          notifyStatus();
        });
        notifyStatus();
      } catch {
        // Battery saver, unsupported PWA standalone mode, or policy denied
      }
    }
    if (fromGesture && useVideoFallback && (!wakeLock || !videoActive)) {
      await startVideoKeepalive();
    }
  }

  window.pgEnsureWakeLock = function () {
    return acquireWakeLock(true);
  };

  window.pgInitWakeLock = function (opts = {}) {
    useVideoFallback = Boolean(opts && opts.videoFallback);
    statusCb = typeof opts?.onChange === 'function' ? opts.onChange : null;

    acquireWakeLock(false);

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        acquireWakeLock(useVideoFallback && videoActive);
      }
    };
    const onGesture = () => {
      if (!wakeLock || (useVideoFallback && !videoActive)) {
        acquireWakeLock(true);
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('touchend', onGesture, { passive: true });
    window.addEventListener('keydown', onGesture, { passive: true });
    notifyStatus();
  };

  window.pgVibrate = function (pattern) {
    try {
      if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
    } catch {
      // Ignored on unsupported browsers
    }
  };

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  window.esc = function (s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  };

  // ---- Zeichnen: Punkt-Chunks { c, w, p:[x0,y0,x1,y1,…] } mit Koordinaten 0..1000 ----
  window.pgDrawChunk = function (ctx, cvs, ch, lineWidth) {
    const p = ch && ch.p;
    if (!Array.isArray(p) || p.length < 4) return;
    const sx = cvs.width / 1000, sy = cvs.height / 1000;
    ctx.strokeStyle = ch.c || '#111';
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p[0] * sx, p[1] * sy);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * sx, p[i + 1] * sy);
    ctx.stroke();
  };

  // ---- Emoji-Reaktionen: begrenzte Anzahl, Aufräumen per animationend ----
  const EMOJI_MAX = 18;
  window.pgFloatEmoji = function (html, leftMin, leftSpan) {
    const layer = document.getElementById('emojiLayer');
    if (!layer || document.hidden) return;
    while (layer.childElementCount >= EMOJI_MAX) layer.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'floatEmoji';
    el.style.left = (leftMin + Math.random() * leftSpan) + '%';
    el.innerHTML = html;
    el.addEventListener('animationend', () => el.remove());
    setTimeout(() => el.remove(), 4000); // Fallback, falls animationend ausbleibt (reduced motion)
    layer.appendChild(el);
  };

  // ---- Audio-Preload: erst wenn der aktuelle Song komplett gepuffert ist (oder in der Auflösung) ----
  let lastPreloadAudio = '';
  function fullyBuffered(el) {
    const b = el.buffered, d = el.duration;
    return b.length > 0 && Number.isFinite(d) && b.end(b.length - 1) >= d - 0.5;
  }
  window.pgPreloadNextAudio = function (s, currentAudioEl) {
    if (!s || !s.nextAudio || s.nextAudio === lastPreloadAudio) return;
    // Während der aktuelle Song noch lädt, keine Bandbreite für den nächsten abzweigen (Mobilfunk!)
    if (s.mode === 'songquiz' && s.phase === 'question' && currentAudioEl && currentAudioEl.getAttribute('src') && !fullyBuffered(currentAudioEl)) return;
    lastPreloadAudio = s.nextAudio;
    fetch(s.nextAudio).catch(() => { lastPreloadAudio = ''; });
  };

  // ---- Glücksrad: Scheibe einmal offscreen rendern, pro Frame nur rotiert blitten ----
  // cfg: { R, cyOff, rimPad, rimLine, sliceLine, winLine, font(N), labelMax, labelInset,
  //        hubLine, hubFont, ptr:{w,h,top,line}, shadow, onTick(), onWin(), isActive() }
  window.pgRunWheel = function (cvs, spin, cfg) {
    const items = spin.items;
    const N = items.length;
    const slice = (Math.PI * 2) / N;
    const winIdx = Math.max(0, Math.min(N - 1, Number(spin.winnerIdx) || 0));
    const jitter = N > 1 ? (((spin.id * 37) % 41 - 20) / 100) * slice * 0.42 : 0;
    const targetRot = (Math.PI * 2 * 5) - (winIdx + 0.5) * slice - Math.PI / 2 + jitter;
    const spinDur = 3000;
    const W = cvs.width, H = cvs.height, cx = W / 2, cy = H / 2 + cfg.cyOff, R = Math.min(W, H) * cfg.R;
    const D = Math.ceil(2 * (R + cfg.rimPad + 8));
    const ctx = cvs.getContext('2d');

    function renderDisc(highlight) {
      const off = document.createElement('canvas');
      off.width = off.height = D;
      const o = off.getContext('2d');
      const c = D / 2;
      o.beginPath();
      o.arc(c, c, R + cfg.rimPad, 0, Math.PI * 2);
      o.fillStyle = '#ffd33d';
      o.fill();
      o.lineWidth = cfg.rimLine;
      o.strokeStyle = '#1b1340';
      o.stroke();
      const fSize = cfg.font(N);
      for (let i = 0; i < N; i++) {
        const a0 = i * slice, a1 = a0 + slice;
        let colIdx = i % WHEEL_COLS.length;
        if (i === N - 1 && N > 1 && colIdx === 0) colIdx = 1;
        o.save();
        o.beginPath();
        o.moveTo(c, c);
        o.arc(c, c, R, a0, a1);
        o.closePath();
        o.fillStyle = WHEEL_COLS[colIdx];
        o.fill();
        o.lineWidth = highlight && i === winIdx ? cfg.winLine : cfg.sliceLine;
        o.strokeStyle = highlight && i === winIdx ? '#ffd33d' : 'rgba(27,19,64,0.85)';
        o.stroke();
        o.translate(c, c);
        o.rotate(a0 + slice / 2);
        o.textAlign = 'right';
        o.textBaseline = 'middle';
        o.fillStyle = '#fff';
        o.font = `800 ${fSize}px system-ui, sans-serif`;
        const raw = String(items[i] || '');
        o.fillText(raw.length > cfg.labelMax ? raw.slice(0, cfg.labelMax - 1) + '…' : raw, R - cfg.labelInset, 0);
        o.restore();
      }
      if (cfg.pins) {
        for (let i = 0; i < N; i++) {
          const pa = i * slice;
          o.beginPath();
          o.arc(c + Math.cos(pa) * (R + 4), c + Math.sin(pa) * (R + 4), 5, 0, Math.PI * 2);
          o.fillStyle = '#fff';
          o.fill();
          o.lineWidth = 2;
          o.strokeStyle = '#1b1340';
          o.stroke();
        }
      }
      return off;
    }

    // Statischer Schatten (ersetzt CSS filter: drop-shadow, das jeden Frame neu berechnet wird)
    let shadow = null;
    if (cfg.shadow) {
      shadow = document.createElement('canvas');
      shadow.width = W; shadow.height = H;
      const s = shadow.getContext('2d');
      s.shadowColor = 'rgba(0,0,0,.55)';
      s.shadowBlur = 28;
      s.shadowOffsetY = 12;
      s.beginPath();
      s.arc(cx, cy, R + cfg.rimPad, 0, Math.PI * 2);
      s.fillStyle = '#ffd33d';
      s.fill();
    }

    let disc = renderDisc(false);
    const start = performance.now();
    let lastTickIdx = -1, flapper = 0, winShown = false, raf = 0;

    function frame(now) {
      const t = Math.min(1, (now - start) / spinDur);
      const rot = targetRot * (1 - Math.pow(1 - t, 4));
      if (N > 1 && t < 1) {
        const pointerRel = ((-Math.PI / 2 - rot) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        const curIdx = Math.floor(pointerRel / slice) + Math.floor(rot / (Math.PI * 2)) * N;
        if (lastTickIdx !== -1 && curIdx !== lastTickIdx) {
          flapper = 1;
          if (cfg.onTick) cfg.onTick();
        }
        lastTickIdx = curIdx;
      }
      flapper *= 0.84;
      if (t >= 1 && !winShown) {
        winShown = true;
        disc = renderDisc(true);
        if (cfg.onWin) cfg.onWin(spin.winnerLabel || items[winIdx]);
      }

      ctx.clearRect(0, 0, W, H);
      if (shadow) ctx.drawImage(shadow, 0, 0);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.drawImage(disc, -D / 2, -D / 2);
      ctx.restore();

      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.17, 0, Math.PI * 2);
      ctx.fillStyle = '#1b1340';
      ctx.fill();
      ctx.lineWidth = cfg.hubLine;
      ctx.strokeStyle = '#ffd33d';
      ctx.stroke();
      ctx.font = `${cfg.hubFont}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🎡', cx, cy + 1);

      const pw = cfg.ptr.w, ph = cfg.ptr.h;
      ctx.save();
      ctx.translate(cx, cy - R - cfg.ptr.top);
      ctx.rotate(-flapper * 0.42);
      ctx.beginPath();
      ctx.moveTo(-pw, -ph);
      ctx.lineTo(pw, -ph);
      ctx.lineTo(0, cfg.ptr.tip);
      ctx.closePath();
      ctx.fillStyle = '#ffd33d';
      ctx.fill();
      ctx.lineWidth = cfg.ptr.line;
      ctx.strokeStyle = '#1b1340';
      ctx.stroke();
      ctx.restore();

      // Nach dem Ausschwingen stoppen statt identische Frames zu malen
      if ((t < 1 || flapper > 0.01) && cfg.isActive()) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  };
  const WHEEL_COLS = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#7c4dff', '#ff6b9d', '#00897b', '#e86c00'];

  // ---- Timer-Balken: transform statt width (kein Layout pro Tick) ----
  window.pgSetBar = function (el, ratio) {
    if (!el) return;
    const v = 'scaleX(' + Math.max(0, Math.min(1, ratio)).toFixed(3) + ')';
    if (el.style.transform !== v) el.style.transform = v;
  };
  window.pgSetText = function (el, txt) {
    if (el && el.textContent !== txt) el.textContent = txt;
  };

  // ---- Text kopieren: Clipboard-API gibt es nur auf HTTPS/localhost. Über http://<IP> fehlt sie →
  // execCommand-Fallback, sonst Eingabedialog zum manuellen Kopieren. true = automatisch kopiert.
  window.pgCopyText = async function (text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch {}
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    if (!ok) prompt('Link kopieren:', text);
    return ok;
  };

  // ---- Trommelwirbel vor der Auflösung: kurzes Overlay, damit TV und Handys nicht sofort verraten, was richtig ist ----
  const SUSPENSE_MODES = ['quiz', 'imagequiz', 'songquiz', 'estimate', 'sort', 'truthlie', 'imposter', 'mostlikely', 'wouldyourather'];
  window.PG_SUSPENSE_MS = 1250;
  let suspenseUntil = 0, suspenseDeferT = 0, lastConnectAt = 0;
  function hideSuspense() {
    const el = document.getElementById('pgSuspense');
    suspenseUntil = 0;
    if (!el || !el.classList.contains('on')) return;
    clearTimeout(el._t);
    el.classList.add('out');
    el._t = setTimeout(() => el.classList.remove('on', 'out'), 300);
  }
  // Nur beim echten Übergang Frage → Auflösung derselben Runde. Nicht beim ersten State nach einem (Re-)Connect –
  // dann läuft die Auflösung schon. Jeder andere Phasenwechsel (z. B. „Weiter“ während des Wirbels) beendet das Overlay.
  window.pgSuspense = function (prev, s) {
    if (!s || s.phase !== 'result' || (prev && prev.idx !== s.idx)) { hideSuspense(); return false; }
    if (!prev || prev.phase === 'result' || !SUSPENSE_MODES.includes(s.mode)) return false;
    if (performance.now() - lastConnectAt < 1500) return false;
    let el = document.getElementById('pgSuspense');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pgSuspense';
      el.className = 'suspense';
      el.innerHTML = '<div class="suspenseDrum">🥁</div><div class="suspenseTxt">Und die Auflösung …</div>';
      document.body.appendChild(el);
    }
    clearTimeout(el._t);
    el.classList.remove('out');
    el.classList.add('on');
    suspenseUntil = performance.now() + window.PG_SUSPENSE_MS;
    el._t = setTimeout(hideSuspense, window.PG_SUSPENSE_MS);
    return true;
  };
  // Solange der Wirbel läuft, wird die Auflösung nicht gezeichnet (sonst laufen Animationen, Vibration und
  // Konfetti unsichtbar darunter ab bzw. die View-Transition blitzt über dem Overlay auf) – danach einmal nachholen.
  function deferWhileSuspense(fn) {
    const left = suspenseUntil - performance.now();
    if (left <= 0) return false;
    clearTimeout(suspenseDeferT);
    suspenseDeferT = setTimeout(fn, left + 20);
    return true;
  }

  // ---- Foto-Wand: Bild verkleinern (max. 1600 px, JPEG) und in die Raum-Galerie hochladen ----
  // Mobilfunk-tauglich (~200–400 KB statt 3–8 MB); iOS liefert HEIC als JPEG an <input type=file>.
  async function shrinkToJpeg(file, max = 1600, quality = 0.82) {
    // imageOrientation gibt es erst ab Safari 16 / Chrome 112 → sonst ohne Option, zuletzt über <img>
    let bmp = null;
    if (window.createImageBitmap) {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null)
        || await createImageBitmap(file).catch(() => null);
    }
    const src = bmp || await new Promise((res, rej) => {
      const im = new Image();
      const url = URL.createObjectURL(file);
      im.onload = () => { URL.revokeObjectURL(url); res(im); };
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      im.src = url;
    });
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
    const s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    if (bmp) bmp.close();
    return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
  }
  // headers: zusätzliche Header (z. B. x-card für die Foto-Challenge); Rückgabe enthält die hochgeladenen Fotos
  window.pgUploadPhotos = async function (room, files, name, onProgress, headers = {}) {
    const list = Array.from(files || []);
    let ok = 0, error = '';
    const photos = [];
    for (const [i, f] of list.entries()) {
      if (onProgress) onProgress(i + 1, list.length);
      let body;
      try {
        body = await shrinkToJpeg(f);
      } catch {
        error = 'Bild konnte nicht gelesen werden';
        continue;
      }
      // Bis zu 3 Versuche: bei vollem Limit (429) bzw. kurzem Funkloch kurz warten und erneut senden
      let fileError = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await fetch('/api/photos/' + encodeURIComponent(room), {
            method: 'POST',
            headers: { 'Content-Type': 'image/jpeg', 'x-photo-name': encodeURIComponent(name || ''), ...headers },
            body,
          });
          if (r.ok) {
            ok++;
            fileError = '';
            const j = await r.json().catch(() => ({}));
            if (j.photo) photos.push(j.photo);
            break;
          }
          fileError = (await r.json().catch(() => ({}))).error || (r.status === 429 ? 'Zu viele Uploads gleichzeitig' : 'Upload fehlgeschlagen');
          if (r.status !== 429 && r.status < 500) break;
        } catch {
          fileError = 'Upload fehlgeschlagen – Verbindung prüfen';
        }
        if (attempt < 3) await new Promise(res => setTimeout(res, 3000 * attempt));
      }
      if (fileError) error = fileError;
    }
    return { ok, total: list.length, error, photos };
  };
  // Kurze Meldung unten am Bildschirm
  window.pgToast = function (text, ms = 2600) {
    let el = document.getElementById('pgToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pgToast';
      el.className = 'pgToast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(el._t);
    if (ms > 0) el._t = setTimeout(() => el.classList.remove('on'), ms);
  };
  // Datei-Auswahl → Upload mit Fortschritt als Toast (für Handy, Admin, Galerie)
  window.pgPhotoInput = async function (input, room, name, onDone, headers) {
    const files = input.files;
    if (!files || !files.length) return;
    const r = await pgUploadPhotos(room, files, name, (i, n) => pgToast(`📤 Lade Foto ${i}/${n} hoch …`, 0), headers);
    input.value = '';
    pgToast(r.ok === r.total ? `✅ ${r.ok === 1 ? 'Foto' : `${r.ok} Fotos`} hochgeladen` : `⚠️ ${r.ok}/${r.total} hochgeladen – ${r.error}`, 3500);
    if (onDone) onDone(r);
  };
  // Für Seiten, die #app ständig neu zeichnen: ein dauerhaftes, verstecktes Datei-Feld außerhalb von #app,
  // sonst geht die Auswahl verloren, wenn der Button während des Foto-Pickers neu gerendert wird.
  // camera=true öffnet direkt die Kamera (capture) – Android bietet sonst oft nur gespeicherte Bilder an.
  // opts: { headers, single, selfie } – Foto-Challenge: ein Foto, Frontkamera
  window.pgPickPhotos = function (room, name, onDone, camera = false, opts = {}) {
    let input = document.getElementById('pgPhotoPick');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.id = 'pgPhotoPick';
      input.style.display = 'none';
      document.body.appendChild(input);
    }
    if (camera) input.setAttribute('capture', opts.selfie ? 'user' : 'environment');
    else input.removeAttribute('capture');
    input.multiple = !camera && !opts.single;
    input.onchange = () => pgPhotoInput(input, room, typeof name === 'function' ? name() : name, onDone, opts.headers);
    input.click();
  };
  // Zwei Knöpfe: Foto jetzt aufnehmen / aus der Handy-Galerie wählen
  window.pgPhotoButtons = function (onclickCamera, onclickGallery) {
    return `<button type="button" class="photoBtn" onclick="${onclickCamera}">📷 Foto aufnehmen</button>`
      + `<button type="button" class="photoBtn" style="background:#4b3a9e" onclick="${onclickGallery}">🖼️ Aus Galerie</button>`;
  };

  // ---- Client-Fehler sammeln und an den Server melden (max. 5 pro Seitenaufruf) ----
  const ASSET_VER = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || ''; } catch { return ''; } })();
  const errQueue = [];
  let errSocket = null, errSent = 0;
  function pushError(e) {
    if (errSent + errQueue.length >= 5 || !e.msg || e.msg === 'Script error.') return;
    errQueue.push({ ...e, ver: ASSET_VER });
    flushErrors();
  }
  function flushErrors() {
    while (errSocket && errSocket.connected && errQueue.length) { errSocket.emit('client:error', errQueue.shift()); errSent++; }
  }
  window.addEventListener('error', e => pushError({ msg: e.message, src: (e.filename || '').replace(location.origin, ''), line: e.lineno }));
  window.addEventListener('unhandledrejection', e => pushError({ msg: 'unhandledrejection: ' + String(e.reason && e.reason.message || e.reason) }));

  // ---- Socket-Verbindung mit schnellem Reconnect für Handys ----
  // WebSocket zuerst (spart auf Mobilfunk Roundtrips), Polling nur als Fallback; kurze Backoffs.
  // Nach längerem Hintergrund (Bildschirm gesperrt, App-Wechsel) ist die alte Verbindung oft tot,
  // ohne dass es jemand merkt → sofort neu verbinden statt bis zu 35 s auf den Ping-Timeout zu warten.
  window.pgConnect = function (room, page) {
    const socket = io({
      query: { room, page },
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 3000,
    });
    errSocket = socket;
    socket.on('connect', flushErrors);
    socket.on('connect', () => { lastConnectAt = performance.now(); });
    let hiddenAt = 0;
    const revive = () => {
      if (!socket.connected) { socket.connect(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 15000) socket.io.engine.close(); // Recovery stellt die Session wieder her
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hiddenAt = Date.now();
      else { revive(); hiddenAt = 0; }
    });
    window.addEventListener('online', () => { if (!socket.connected) socket.connect(); });
    window.addEventListener('pageshow', e => { if (e.persisted) revive(); });
    return socket;
  };

  // ---- Weiche Übergänge zwischen Spielphasen (View Transitions, wo verfügbar) ----
  let lastTransitionKey = '';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  window.pgTransition = function (key, fn) {
    if (deferWhileSuspense(() => window.pgTransition(key, fn))) return;
    const changed = key !== lastTransitionKey;
    const first = !lastTransitionKey;
    lastTransitionKey = key;
    if (!changed || first || !document.startViewTransition || reduceMotion.matches || document.hidden) return fn();
    // Folgt schnell der nächste Phasenwechsel, bricht der Browser die Animation ab („Transition was skipped“) –
    // gewollt, kein Fehler; ohne catch landet das als unhandledrejection im Client-Fehler-Log.
    document.startViewTransition(fn).ready.catch(() => {});
  };

  // ---- Konfetti: zeitbasiert (gleich schnell auf 60/120 Hz), flatternde Papierschnipsel, DPR-scharf ----
  let confettiRaf = 0;
  const CONFETTI_COLS = ['#ffd33d', '#ff6b9d', '#7c4dff', '#26890c', '#1368ce', '#e21b3c'];
  window.pgConfetti = function (count = 110) {
    if (reduceMotion.matches || document.hidden) return;
    const c = document.getElementById('confetti');
    if (!c) return;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const W = innerWidth, H = innerHeight;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    const x = c.getContext('2d');
    const pts = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: -20 - Math.random() * H * 0.4,
      vx: (Math.random() - 0.5) * 360,
      vy: 180 + Math.random() * 300,
      s: 6 + Math.random() * 8,
      r: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 15,
      f: Math.random() * Math.PI * 2,
      vf: 6 + Math.random() * 8,
      col: CONFETTI_COLS[Math.floor(Math.random() * CONFETTI_COLS.length)],
    }));
    cancelAnimationFrame(confettiRaf);
    const start = performance.now();
    let last = start;
    (function step(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, c.width, c.height);
      const fade = Math.max(0, 1 - Math.max(0, now - start - 2200) / 900);
      x.globalAlpha = fade;
      let alive = false;
      for (const p of pts) {
        p.vy += 290 * dt; p.vx *= 1 - 0.6 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.f += p.vf * dt;
        if (p.y < H + 30) alive = true;
        const cos = Math.cos(p.r), sin = Math.sin(p.r), fl = Math.cos(p.f);
        x.setTransform(cos * dpr, sin * dpr, -sin * fl * dpr, cos * fl * dpr, p.x * dpr, p.y * dpr);
        x.fillStyle = p.col;
        x.fillRect(-p.s / 2, -p.s / 4, p.s, p.s * 0.55);
      }
      if (alive && fade > 0) confettiRaf = requestAnimationFrame(step);
      else { x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); }
    })(start);
  };

  // Service Worker: HTML network-first mit Offline-Fallback, Hash-Assets/Bilder aus dem Cache (siehe /sw.js).
  // Nur auf HTTPS/localhost; Fehler werden bewusst still ignoriert (kein Rauschen im Fehler-Reporting).
  try {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      const registerSw = () => {
        try {
          navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
        } catch {}
      };
      if (document.readyState === 'complete') registerSw();
      else window.addEventListener('load', registerSw);
    }
  } catch {}

  /** Render word mask string (e.g. "Einkauf______") into non-breaking word spans. */
  window.pgRenderWordMask = function (mask) {
    const words = String(mask || '').split(' ').filter(Boolean);
    if (!words.length) return '';
    return words.map(w => {
      const chars = Array.from(w).map(ch => {
        if (ch === '_') return '<span class="maskSlot">_</span>';
        if (!/[\p{L}\p{N}]/u.test(ch)) return `<span class="maskSep">${window.esc(ch)}</span>`;
        return `<span class="maskChar">${window.esc(ch)}</span>`;
      }).join('');
      return `<span class="maskWord">${chars}</span>`;
    }).join('');
  };
})();
