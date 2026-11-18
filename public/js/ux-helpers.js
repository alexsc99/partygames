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
})();
