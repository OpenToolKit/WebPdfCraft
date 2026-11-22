(() => {
  const removeSplashNow = () => {
    const splash = document.getElementById('pdfcraft-splash');
    if (splash) splash.remove();
    const style = document.getElementById('pdfcraft-splash-style');
    if (style) style.remove();
  };

  // Clickjacking guard for cross-origin iframes (GitHub Pages does not support frame-ancestors).
  const isCrossOriginFrame = () => {
    if (window.top === window.self) return false;
    try {
      return window.top.location.origin !== window.location.origin;
    } catch {
      return true;
    }
  };

  const showFrameGuard = () => {
    removeSplashNow();
    if (!document.body || document.getElementById('pdfcraft-frame-guard')) return;
    const overlay = document.createElement('div');
    overlay.id = 'pdfcraft-frame-guard';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:14px',
      'padding:24px',
      'background:#19191c',
      'color:#f1f1f3',
      'font:500 15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'text-align:center',
    ].join(';');

    const msg = document.createElement('p');
    msg.textContent = 'For your security, open PdfCraft in its own browser tab.';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Open PdfCraft';
    openBtn.style.cssText = [
      'border:0',
      'border-radius:8px',
      'padding:10px 18px',
      'cursor:pointer',
      'font:600 14px/1.2 inherit',
      'background:#b70228',
      'color:#ffffff',
    ].join(';');
    openBtn.addEventListener('click', () => {
      window.open(window.location.href, '_blank', 'noopener,noreferrer');
    });

    overlay.append(msg, openBtn);
    document.body.appendChild(overlay);
  };

  if (isCrossOriginFrame()) {
    if (document.body) {
      showFrameGuard();
    } else {
      window.addEventListener('DOMContentLoaded', showFrameGuard, { once: true });
    }
    return;
  }

  // Splash screen lifecycle: dismiss smoothly once eframe has sized and painted the canvas.
  let appBooted = Boolean(window.wasmBindings);
  let splashDismissed = false;
  const statusTimers = [];

  const setSplashStatus = (text) => {
    const el = document.getElementById('pdfcraft-splash-status');
    if (el) el.textContent = text;
  };

  const showSplashRetry = (message) => {
    if (splashDismissed || appBooted) return;
    while (statusTimers.length) clearTimeout(statusTimers.pop());
    const splash = document.getElementById('pdfcraft-splash');
    if (!splash) return;
    // Keep the recovery prompt visible instead of letting the CSS failsafe hide it.
    splash.style.animation = 'none';
    setSplashStatus(message);
    const bar = splash.querySelector('.pdfcraft-splash-bar');
    if (bar) bar.style.display = 'none';
    const card = splash.querySelector('.pdfcraft-splash-card');
    if (card && !card.querySelector('.pdfcraft-splash-retry')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pdfcraft-splash-retry';
      btn.textContent = 'Reload';
      btn.addEventListener('click', () => window.location.reload());
      card.appendChild(btn);
    }
  };

  const dismissSplash = () => {
    if (splashDismissed) return;
    splashDismissed = true;
    while (statusTimers.length) clearTimeout(statusTimers.pop());

    const splash = document.getElementById('pdfcraft-splash');
    if (!splash) return;

    splash.style.animation = '';
    splash.classList.add('pdfcraft-splash--done');
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      removeSplashNow();
    };
    splash.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 650);
  };

  const waitForFirstCanvasFrame = () => {
    appBooted = true;
    const canvas = document.getElementById('pdfcraft');
    const startedAt = performance.now();
    const check = () => {
      if (splashDismissed) return;
      const resized =
        canvas &&
        canvas.width > 0 &&
        canvas.height > 0 &&
        (canvas.width !== 300 || canvas.height !== 150);
      if (resized || performance.now() - startedAt > 1200) {
        requestAnimationFrame(() => requestAnimationFrame(dismissSplash));
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  };

  const isCachedVisit = Boolean('serviceWorker' in navigator && navigator.serviceWorker.controller);
  if (isCachedVisit) {
    statusTimers.push(setTimeout(() => setSplashStatus('Preparing workspace…'), 3000));
  } else {
    statusTimers.push(
      setTimeout(() => setSplashStatus('Downloading PdfCraft (first visit only)…'), 2500),
      setTimeout(() => setSplashStatus('Still downloading — later visits open offline…'), 9000)
    );
  }

  const onStartupError = () => {
    if (!appBooted) {
      showSplashRetry('PdfCraft could not start. Check your connection and reload.');
    }
  };
  window.addEventListener('error', onStartupError, { once: true });
  window.addEventListener('unhandledrejection', onStartupError, { once: true });
  window.addEventListener(
    'load',
    () => {
      statusTimers.push(
        setTimeout(() => {
          if (!appBooted) {
            showSplashRetry('PdfCraft is taking longer than expected to start.');
          }
        }, 15000)
      );
    },
    { once: true }
  );

  // If the module already booted before this deferred script ran, dismiss immediately.
  if (appBooted) {
    waitForFirstCanvasFrame();
  } else {
    window.addEventListener('TrunkApplicationStarted', waitForFirstCanvasFrame, { once: true });
  }

  if (!('serviceWorker' in navigator)) return;

  let userRequestedReload = false;
  let registered = false;
  let activeRegistration = null;

  const showUpdateToast = (waitingWorker) => {
    if (!document.body || document.getElementById('pdfcraft-pwa-toast')) return;

    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const toast = document.createElement('div');
    toast.id = 'pdfcraft-pwa-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:10px 14px',
      'border-radius:10px',
      'font:500 13px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
      dark
        ? 'background:#26262b;color:#f1f1f3;border:1px solid rgba(255,255,255,0.12)'
        : 'background:#ffffff;color:#19191c;border:1px solid rgba(0,0,0,0.12)',
    ].join(';');

    const text = document.createElement('span');
    text.textContent = 'A new PdfCraft version is ready.';

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.textContent = 'Reload';
    reloadBtn.style.cssText = [
      'border:0',
      'border-radius:6px',
      'padding:5px 10px',
      'cursor:pointer',
      'font:600 12px/1.2 inherit',
      'background:#b70228',
      'color:#ffffff',
    ].join(';');
    reloadBtn.addEventListener('click', () => {
      const target = (activeRegistration && activeRegistration.waiting) || waitingWorker;
      userRequestedReload = true;
      reloadBtn.disabled = true;
      reloadBtn.textContent = 'Updating...';
      if (!target || target.state === 'redundant') {
        window.location.reload();
        return;
      }
      target.postMessage({ type: 'SKIP_WAITING' });
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Later';
    closeBtn.style.cssText = [
      'border:0',
      'background:transparent',
      'cursor:pointer',
      'padding:5px 6px',
      'font:500 12px/1.2 inherit',
      dark ? 'color:#b5b5be' : 'color:#55555e',
    ].join(';');
    closeBtn.addEventListener('click', () => toast.remove());

    toast.append(text, reloadBtn, closeBtn);
    document.body.appendChild(toast);
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userRequestedReload) {
      window.location.reload();
    }
  });

  const shouldWarmModels = async () => {
    const conn = navigator.connection;
    if (conn) {
      if (conn.saveData) return false;
      if (/(^|-)2g$/i.test(conn.effectiveType || '')) return false;
    }
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      try {
        const { quota, usage } = await navigator.storage.estimate();
        if (typeof quota === 'number' && typeof usage === 'number' && quota - usage < 50 * 1024 * 1024) {
          return false;
        }
      } catch {
        // Proceed when storage estimate is unavailable.
      }
    }
    return true;
  };

  const requestModelWarmup = () => {
    const schedule = (fn) => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => fn(), { timeout: 4000 });
      } else {
        setTimeout(fn, 1500);
      }
    };

    schedule(async () => {
      if (!(await shouldWarmModels())) return;
      try {
        const reg = await navigator.serviceWorker.ready;
        if (reg.active) {
          reg.active.postMessage({ type: 'WARM_MODELS' });
        }
      } catch {
        // Ignore if service worker is unavailable.
      }
    });
  };

  const registerServiceWorker = async () => {
    if (registered) return;
    registered = true;

    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      activeRegistration = reg;

      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateToast(reg.waiting);
      }

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(reg.waiting || installing);
          }
        });
      });

      requestModelWarmup();
    } catch (err) {
      console.warn('PdfCraft PWA: service worker registration failed:', err);
    }
  };

  // Defer registration until the WASM app has booted so SW precaching does not
  // compete with the initial download (and can reuse the HTTP disk cache).
  if (appBooted) {
    registerServiceWorker();
  } else {
    window.addEventListener('TrunkApplicationStarted', registerServiceWorker, { once: true });
    window.addEventListener(
      'load',
      () => {
        setTimeout(registerServiceWorker, 1500);
      },
      { once: true }
    );
  }
})();
