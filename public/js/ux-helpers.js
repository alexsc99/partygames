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
})();
