(function () {
  let wakeLock = null;

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      // Ignored: battery saver or browser policy may deny wake lock
    }
  }

  window.pgInitWakeLock = function () {
    acquireWakeLock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !wakeLock) acquireWakeLock();
    });
    window.addEventListener('pointerdown', () => {
      if (!wakeLock) acquireWakeLock();
    }, { once: true, passive: true });
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
