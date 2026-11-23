(() => {
  const UI_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

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
      `font-family:${UI_FONT}`,
      'font-size:15px',
      'font-weight:500',
      'line-height:1.4',
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
      'font-family:inherit',
      'font-size:14px',
      'font-weight:600',
      'line-height:1.2',
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
      setTimeout(() => setSplashStatus('Still downloading. Later visits open offline…'), 9000)
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

  if (appBooted) {
    waitForFirstCanvasFrame();
  } else {
    window.addEventListener('TrunkApplicationStarted', waitForFirstCanvasFrame, { once: true });
  }

  // --- Low-profile Offline-only indicator + toggle (bottom-left, clear of PdfCraft's right rail) ---
  const offlineApi = window.__pdfcraftOffline || {
    storageKey: '',
    readStored: () => false,
    writeStored: () => {},
    lock: () => {},
    unlock: () => {},
    isLocked: () => false,
    hasBootCsp: () => false,
  };

  const swSupported = 'serviceWorker' in navigator;
  let userRequestedReload = false;
  let registered = false;
  let activeRegistration = null;
  const attachedRegistrations = new WeakSet();

  const uiState = {
    offlineOnly: swSupported && offlineApi.readStored(),
    coreReady: false,
    modelsReady: false,
    modelsCached: 0,
    modelsTotal: 0,
    deviceOnline: navigator.onLine !== false,
    busy: false,
  };

  const injectPillStyles = () => {
    if (document.getElementById('pdfcraft-pwa-ui-style')) return;
    const style = document.createElement('style');
    style.id = 'pdfcraft-pwa-ui-style';
    style.textContent = `
      #pdfcraft-net-wrap {
        position: fixed;
        left: 12px;
        bottom: 12px;
        width: max-content;
        z-index: 2147483640;
        font-family: ${UI_FONT};
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }
      #pdfcraft-net-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 26px;
        padding: 0 10px 0 8px;
        white-space: nowrap;
        border-radius: 999px;
        border: 1px solid rgba(25, 25, 28, 0.14);
        background: rgba(255, 255, 255, 0.82);
        color: #27272c;
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 500;
        line-height: 1;
        letter-spacing: 0.01em;
        cursor: grab;
        opacity: 0.74;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        transition: opacity 160ms ease, border-color 160ms ease, background 160ms ease;
      }
      #pdfcraft-net-wrap[data-dragging="true"] #pdfcraft-net-pill {
        cursor: grabbing;
        opacity: 1;
        transition: none;
      }
      #pdfcraft-net-pill:hover,
      #pdfcraft-net-pill:focus-visible {
        opacity: 1;
        outline: none;
      }
      #pdfcraft-net-pill:focus-visible {
        box-shadow: 0 0 0 2px rgba(183, 2, 40, 0.45);
      }
      #pdfcraft-net-pill[aria-disabled="true"] {
        cursor: grab;
      }
      #pdfcraft-net-pill[data-mode="offline-only"] {
        border-color: rgba(22, 163, 74, 0.42);
      }
      #pdfcraft-net-pill[data-mode="needs-reload"] {
        border-color: rgba(217, 119, 6, 0.45);
      }
      #pdfcraft-net-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex: 0 0 auto;
        background: #8e8e98;
        transition: background 180ms ease, box-shadow 180ms ease;
      }
      #pdfcraft-net-pill[data-mode="caching"] #pdfcraft-net-dot,
      #pdfcraft-net-pill[data-mode="needs-reload"] #pdfcraft-net-dot {
        background: #f59e0b;
      }
      #pdfcraft-net-pill[data-mode="online"] #pdfcraft-net-dot {
        background: #8e8e98;
      }
      #pdfcraft-net-pill[data-mode="device-offline"] #pdfcraft-net-dot {
        background: #0284c7;
      }
      #pdfcraft-net-pill[data-mode="offline-only"] #pdfcraft-net-dot {
        background: #16a34a;
        box-shadow: 0 0 0 2px rgba(22, 163, 74, 0.22);
      }
      #pdfcraft-net-tip {
        position: absolute;
        left: 0;
        bottom: calc(100% + 8px);
        width: max-content;
        max-width: min(256px, calc(100vw - 16px));
        box-sizing: border-box;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid rgba(25, 25, 28, 0.14);
        background: rgba(255, 255, 255, 0.96);
        color: #19191c;
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 400;
        line-height: 1.45;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
        pointer-events: none;
        opacity: 0;
        transform: translate(var(--tip-shift, 0px), 4px);
        transition: opacity 150ms ease, transform 150ms ease;
      }
      #pdfcraft-net-wrap[data-tip-v="bottom"] #pdfcraft-net-tip {
        top: calc(100% + 8px);
        bottom: auto;
        transform: translate(var(--tip-shift, 0px), -4px);
      }
      #pdfcraft-net-wrap[data-tip-h="right"] #pdfcraft-net-tip {
        left: auto;
        right: 0;
      }
      #pdfcraft-net-wrap:not([data-dragging="true"]):hover #pdfcraft-net-tip,
      #pdfcraft-net-wrap:not([data-dragging="true"]):has(#pdfcraft-net-pill:focus-visible) #pdfcraft-net-tip {
        opacity: 1;
        transform: translate(var(--tip-shift, 0px), 0);
      }
      .pdfcraft-net-tip-title {
        font-weight: 600;
        margin-bottom: 3px;
      }
      .pdfcraft-net-tip-row {
        opacity: 0.78;
      }
      @media (prefers-color-scheme: dark) {
        #pdfcraft-net-pill {
          border-color: rgba(255, 255, 255, 0.14);
          background: rgba(34, 34, 40, 0.82);
          color: #e4e4ea;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        }
        #pdfcraft-net-pill[data-mode="offline-only"] {
          border-color: rgba(34, 197, 94, 0.45);
        }
        #pdfcraft-net-pill[data-mode="offline-only"] #pdfcraft-net-dot {
          background: #22c55e;
          box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.25);
        }
        #pdfcraft-net-pill[data-mode="device-offline"] #pdfcraft-net-dot {
          background: #38bdf8;
        }
        #pdfcraft-net-tip {
          border-color: rgba(255, 255, 255, 0.14);
          background: rgba(30, 30, 36, 0.97);
          color: #f1f1f3;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.48);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        #pdfcraft-net-pill,
        #pdfcraft-net-dot,
        #pdfcraft-net-tip {
          transition: none;
        }
      }
    `;
    document.head.appendChild(style);
  };

  let pillWrap = null;
  let pillBtn = null;
  let pillLabel = null;
  let tipTitle = null;
  let tipBody = null;
  let suppressNextClick = false;

  const POS_STORAGE_KEY = offlineApi.storageKey
    ? offlineApi.storageKey.replace(/:offline-only$/, ':pill-pos')
    : 'pdfcraft:pill-pos';
  const EDGE_MARGIN = 8;

  const readSavedPos = () => {
    try {
      const raw = window.localStorage.getItem(POS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
        return { x: parsed.x, y: parsed.y };
      }
    } catch {
      // Ignore malformed or unavailable storage.
    }
    return null;
  };

  const writeSavedPos = (x, y) => {
    try {
      window.localStorage.setItem(POS_STORAGE_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  };

  const updateTooltipAnchor = () => {
    if (!pillWrap) return;
    const rect = pillWrap.getBoundingClientRect();
    pillWrap.dataset.tipV = rect.top < window.innerHeight / 2 ? 'bottom' : 'top';
    const alignRight = rect.left + rect.width / 2 > window.innerWidth / 2;
    pillWrap.dataset.tipH = alignRight ? 'right' : 'left';
    const tip = document.getElementById('pdfcraft-net-tip');
    if (tip) {
      const tipW = tip.offsetWidth;
      const baseLeft = alignRight ? rect.right - tipW : rect.left;
      let shift = 0;
      if (baseLeft < EDGE_MARGIN) {
        shift = EDGE_MARGIN - baseLeft;
      } else if (baseLeft + tipW > window.innerWidth - EDGE_MARGIN) {
        shift = window.innerWidth - EDGE_MARGIN - (baseLeft + tipW);
      }
      tip.style.setProperty('--tip-shift', `${Math.round(shift)}px`);
    }
  };

  const applyPillPos = (x, y) => {
    if (!pillWrap) return null;
    const rect = pillWrap.getBoundingClientRect();
    const maxX = Math.max(EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN);
    const maxY = Math.max(EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN);
    const clampedX = Math.min(Math.max(EDGE_MARGIN, x), maxX);
    const clampedY = Math.min(Math.max(EDGE_MARGIN, y), maxY);
    pillWrap.style.left = `${Math.round(clampedX)}px`;
    pillWrap.style.top = `${Math.round(clampedY)}px`;
    pillWrap.style.right = 'auto';
    pillWrap.style.bottom = 'auto';
    updateTooltipAnchor();
    return { x: clampedX, y: clampedY };
  };

  const restorePillPos = () => {
    const saved = readSavedPos();
    if (saved) {
      applyPillPos(saved.x, saved.y);
    } else if (pillWrap) {
      updateTooltipAnchor();
    }
  };

  const attachDragBehavior = () => {
    if (!pillWrap || !pillBtn) return;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    let dragging = false;

    const onMove = (ev) => {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 5) return;
        dragging = true;
        pillWrap.dataset.dragging = 'true';
      }
      applyPillPos(origLeft + dx, origTop + dy);
    };

    const finishDrag = (ev, save) => {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      const wasDragging = dragging;
      pointerId = null;
      dragging = false;
      delete pillWrap.dataset.dragging;
      try {
        if (pillBtn.hasPointerCapture(ev.pointerId)) {
          pillBtn.releasePointerCapture(ev.pointerId);
        }
      } catch {
        // Ignore pointer capture release errors.
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (wasDragging) {
        suppressNextClick = true;
        setTimeout(() => {
          suppressNextClick = false;
        }, 0);
        if (save) {
          const rect = pillWrap.getBoundingClientRect();
          writeSavedPos(rect.left, rect.top);
        }
      }
    };

    const onUp = (ev) => finishDrag(ev, true);
    const onCancel = (ev) => finishDrag(ev, false);

    pillBtn.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const rect = pillWrap.getBoundingClientRect();
      pointerId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      dragging = false;
      // Capture immediately so pointermove never leaks stray hover events to the PdfCraft canvas.
      try {
        pillBtn.setPointerCapture(ev.pointerId);
      } catch {
        // Fallback window listeners below still track the drag.
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    });
  };

  const isControlled = () => Boolean(swSupported && navigator.serviceWorker.controller);

  const renderPill = () => {
    if (!pillBtn) return;

    const controlled = isControlled();
    let mode = 'online';
    let label = 'Online';
    let title = 'Ready to work offline';
    let body = 'Saved on your device. Click to turn on offline-only mode.';
    let inactive = !swSupported || !uiState.coreReady || uiState.busy;

    if (!swSupported) {
      mode = uiState.deviceOnline ? 'online' : 'device-offline';
      label = uiState.deviceOnline ? 'Online' : 'Offline';
      title = 'Offline-only mode unavailable';
      body = 'Your browser disabled offline storage for this window.';
      inactive = true;
    } else if (uiState.offlineOnly && !controlled) {
      mode = 'needs-reload';
      label = 'Reload to lock';
      title = 'Offline-only mode needs a reload';
      body = 'This tab bypassed offline protection (such as a hard reload). Click to reload and lock.';
      inactive = uiState.busy;
    } else if (uiState.offlineOnly) {
      mode = 'offline-only';
      label = 'Offline only';
      title = 'Working offline';
      body = 'App network requests are blocked. Click to turn off.';
      if (uiState.modelsTotal > 0 && !uiState.modelsReady) {
        body += ` OCR files are still saving (${uiState.modelsCached}/${uiState.modelsTotal}) and will not work offline yet.`;
      }
      inactive = uiState.busy;
    } else if (!uiState.coreReady || !controlled) {
      mode = 'caching';
      label = 'Caching…';
      title = 'Saving for offline use…';
      body = 'Offline-only mode unlocks in a moment.';
      inactive = true;
    } else if (!uiState.deviceOnline) {
      mode = 'device-offline';
      label = 'Offline';
      title = 'Working offline';
      body = 'No internet detected. Click to stay offline after you reconnect.';
      inactive = uiState.busy;
    } else if (offlineApi.hasBootCsp()) {
      body = 'Saved on your device. Reload to restore full network access, or click to turn offline-only back on.';
    }

    pillBtn.dataset.mode = mode;
    pillBtn.setAttribute('aria-disabled', inactive ? 'true' : 'false');
    pillBtn.setAttribute('aria-checked', uiState.offlineOnly && controlled ? 'true' : 'false');
    pillLabel.textContent = label;

    tipTitle.textContent = title;
    tipBody.textContent = body;
    // Keep clamped inside viewport if label width changed while docked near an edge.
    if (pillWrap && pillWrap.style.top) {
      const rect = pillWrap.getBoundingClientRect();
      applyPillPos(rect.left, rect.top);
    }
  };

  const sendSwMessage = (worker, message, timeoutMs = 4000) =>
    new Promise((resolve) => {
      if (!worker) {
        resolve(null);
        return;
      }
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), timeoutMs);
      channel.port1.onmessage = (ev) => {
        clearTimeout(timer);
        resolve(ev.data);
      };
      try {
        worker.postMessage(message, [channel.port2]);
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });

  const getActiveWorker = () =>
    (activeRegistration && activeRegistration.active) ||
    (swSupported && navigator.serviceWorker.controller) ||
    null;

  const refreshStatusFromSw = async () => {
    const worker = getActiveWorker();
    if (!worker) {
      renderPill();
      return null;
    }
    const status = await sendSwMessage(worker, { type: 'GET_STATUS' });
    if (status && typeof status === 'object') {
      uiState.coreReady = Boolean(status.coreReady);
      uiState.modelsReady = Boolean(status.modelsReady);
      uiState.modelsCached = Number(status.modelsCached || 0);
      uiState.modelsTotal = Number(status.modelsTotal || 0);
      renderPill();
    }
    return status;
  };

  const applyRemoteOfflineState = (enabled) => {
    const next = Boolean(enabled);
    if (next) {
      offlineApi.lock();
      const toast = document.getElementById('pdfcraft-pwa-toast');
      if (toast) toast.remove();
    } else {
      offlineApi.unlock();
    }
    uiState.offlineOnly = next;
    renderPill();
  };

  const toggleOfflineOnly = async () => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (!swSupported || uiState.busy) return;
    if (pillBtn && pillBtn.getAttribute('aria-disabled') === 'true') return;

    // Hard-reloaded uncontrolled tab with Offline-only stored: reload cleanly to engage SW control.
    if (uiState.offlineOnly && !isControlled()) {
      window.location.reload();
      return;
    }

    const next = !uiState.offlineOnly;
    if (next && (!uiState.coreReady || !isControlled())) return;

    uiState.busy = true;
    renderPill();
    try {
      const worker = getActiveWorker();
      if (next) {
        offlineApi.writeStored(true);
        offlineApi.lock();
        if (worker) {
          await sendSwMessage(worker, { type: 'SET_OFFLINE_ONLY', enabled: true });
        }
        uiState.offlineOnly = true;
        const toast = document.getElementById('pdfcraft-pwa-toast');
        if (toast) toast.remove();
      } else {
        offlineApi.writeStored(false);
        offlineApi.unlock();
        if (worker) {
          await sendSwMessage(worker, { type: 'SET_OFFLINE_ONLY', enabled: false });
        }
        uiState.offlineOnly = false;
        registerServiceWorker(true);
      }
    } finally {
      uiState.busy = false;
      renderPill();
    }
  };

  const mountPill = () => {
    if (!document.body || document.getElementById('pdfcraft-net-wrap')) return;
    injectPillStyles();

    const wrap = document.createElement('div');
    wrap.id = 'pdfcraft-net-wrap';

    const tip = document.createElement('div');
    tip.id = 'pdfcraft-net-tip';
    tip.setAttribute('role', 'tooltip');

    tipTitle = document.createElement('div');
    tipTitle.className = 'pdfcraft-net-tip-title';
    tipBody = document.createElement('div');
    tipBody.className = 'pdfcraft-net-tip-row';
    tip.append(tipTitle, tipBody);

    pillBtn = document.createElement('button');
    pillBtn.id = 'pdfcraft-net-pill';
    pillBtn.type = 'button';
    pillBtn.setAttribute('role', 'switch');
    pillBtn.setAttribute('aria-label', 'Offline-only mode');
    pillBtn.setAttribute('aria-describedby', 'pdfcraft-net-tip');

    const dot = document.createElement('span');
    dot.id = 'pdfcraft-net-dot';
    dot.setAttribute('aria-hidden', 'true');

    pillLabel = document.createElement('span');
    pillLabel.id = 'pdfcraft-net-label';

    pillWrap = wrap;
    pillBtn.append(dot, pillLabel);
    pillBtn.addEventListener('click', toggleOfflineOnly);
    wrap.addEventListener('mouseenter', () => {
      refreshStatusFromSw();
    });

    wrap.append(tip, pillBtn);
    document.body.appendChild(wrap);
    attachDragBehavior();
    renderPill();
    restorePillPos();
  };

  if (document.body) {
    mountPill();
  } else {
    window.addEventListener('DOMContentLoaded', mountPill, { once: true });
  }

  window.addEventListener('resize', () => {
    if (pillWrap && pillWrap.style.top) {
      const rect = pillWrap.getBoundingClientRect();
      applyPillPos(rect.left, rect.top);
    } else {
      updateTooltipAnchor();
    }
  });
  window.addEventListener('online', () => {
    uiState.deviceOnline = true;
    renderPill();
  });
  window.addEventListener('offline', () => {
    uiState.deviceOnline = false;
    renderPill();
  });
  window.addEventListener('storage', (ev) => {
    if (offlineApi.storageKey && ev.key === offlineApi.storageKey) {
      applyRemoteOfflineState(ev.newValue === '1');
    } else if (ev.key === POS_STORAGE_KEY) {
      restorePillPos();
    }
  });

  if (!swSupported) return;

  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'OFFLINE_STATE') {
      const enabled = Boolean(ev.data.offlineOnly);
      offlineApi.writeStored(enabled);
      applyRemoteOfflineState(enabled);
    }
  });

  const showUpdateToast = (waitingWorker) => {
    if (uiState.offlineOnly) return;
    if (!document.body || document.getElementById('pdfcraft-pwa-toast')) return;

    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const toast = document.createElement('div');
    toast.id = 'pdfcraft-pwa-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = [
      'position:fixed',
      'left:12px',
      'bottom:46px',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:10px 14px',
      'border-radius:10px',
      `font-family:${UI_FONT}`,
      'font-size:13px',
      'font-weight:500',
      'line-height:1.3',
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
      'font-family:inherit',
      'font-size:12px',
      'font-weight:600',
      'line-height:1.2',
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
      'font-family:inherit',
      'font-size:12px',
      'font-weight:500',
      'line-height:1.2',
      dark ? 'color:#b5b5be' : 'color:#55555e',
    ].join(';');
    closeBtn.addEventListener('click', () => toast.remove());

    toast.append(text, reloadBtn, closeBtn);
    document.body.appendChild(toast);
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userRequestedReload) {
      window.location.reload();
      return;
    }
    refreshStatusFromSw();
  });

  const shouldWarmModels = async () => {
    if (uiState.offlineOnly) return false;
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
    if (uiState.offlineOnly) return;
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
        if (reg.active && !uiState.offlineOnly) {
          reg.active.postMessage({ type: 'WARM_MODELS' });
          setTimeout(refreshStatusFromSw, 3000);
        }
      } catch {
        // Ignore if service worker is unavailable.
      }
    });
  };

  const attachRegistrationListeners = (reg) => {
    if (!reg || attachedRegistrations.has(reg)) return;
    attachedRegistrations.add(reg);
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateToast(reg.waiting || installing);
        } else if (installing.state === 'activated') {
          refreshStatusFromSw();
        }
      });
    });
  };

  const registerServiceWorker = async (forceRegister = false) => {
    if (registered && !forceRegister) return;
    registered = true;

    try {
      // In Offline-only mode, attach to the existing local registration without
      // triggering a network update check via navigator.serviceWorker.register().
      if (uiState.offlineOnly && !forceRegister) {
        const existing = await navigator.serviceWorker.getRegistration('./');
        if (existing && existing.active) {
          activeRegistration = existing;
          const status = await refreshStatusFromSw();
          if (status === null) {
            // Slow cold-start status reply: stay locked and re-check shortly.
            setTimeout(refreshStatusFromSw, 3000);
            renderPill();
            return;
          }
          if (status.coreReady) {
            await sendSwMessage(existing.active, { type: 'SET_OFFLINE_ONLY', enabled: true });
            renderPill();
            return;
          }
          // Confirmed partial or full cache loss: unlock SW too before rebuilding cache.
          await sendSwMessage(existing.active, { type: 'SET_OFFLINE_ONLY', enabled: false });
        }
        uiState.offlineOnly = false;
        offlineApi.writeStored(false);
        offlineApi.unlock();
        renderPill();
      }

      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      activeRegistration = reg;
      attachRegistrationListeners(reg);

      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateToast(reg.waiting);
      }

      const readyReg = await navigator.serviceWorker.ready;
      activeRegistration = readyReg;
      attachRegistrationListeners(readyReg);
      let status = await refreshStatusFromSw();
      if (status && !status.coreReady && !uiState.offlineOnly && readyReg.active) {
        status = await sendSwMessage(readyReg.active, { type: 'REPAIR_CORE' }, 30000);
        if (status && typeof status === 'object') {
          uiState.coreReady = Boolean(status.coreReady);
          uiState.modelsReady = Boolean(status.modelsReady);
          uiState.modelsCached = Number(status.modelsCached || 0);
          uiState.modelsTotal = Number(status.modelsTotal || 0);
          renderPill();
        }
      }
      requestModelWarmup();
    } catch (err) {
      console.warn('PdfCraft PWA: service worker registration failed:', err);
    }
  };

  if (appBooted) {
    registerServiceWorker();
  } else {
    window.addEventListener('TrunkApplicationStarted', () => registerServiceWorker(), { once: true });
    window.addEventListener(
      'load',
      () => {
        setTimeout(() => registerServiceWorker(), 1500);
      },
      { once: true }
    );
  }
})();
