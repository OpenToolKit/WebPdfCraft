(() => {
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
    } catch (err) {
      console.warn('PdfCraft PWA: service worker registration failed:', err);
    }
  };

  // Defer registration until the WASM app has booted so SW precaching does not
  // compete with the initial download (and can reuse the HTTP disk cache).
  window.addEventListener('TrunkApplicationStarted', registerServiceWorker, { once: true });
  window.addEventListener(
    'load',
    () => {
      setTimeout(registerServiceWorker, 1500);
    },
    { once: true }
  );
})();
