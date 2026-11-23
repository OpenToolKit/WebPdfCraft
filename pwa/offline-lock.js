(() => {
  const scopePath = (() => {
    const p = window.location.pathname;
    if (p.endsWith('/')) return p;
    const slash = p.lastIndexOf('/');
    return slash >= 0 ? p.slice(0, slash + 1) : '/';
  })();
  const STORAGE_KEY = `pdfcraft:${scopePath}:offline-only`;

  const readStored = () => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  };

  const writeStored = (enabled) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  };

  const originals = {
    WebSocket: window.WebSocket,
    WebTransport: window.WebTransport,
    RTCPeerConnection: window.RTCPeerConnection,
    webkitRTCPeerConnection: window.webkitRTCPeerConnection,
    EventSource: window.EventSource,
    sendBeacon: navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null,
  };

  let locked = false;

  const makeBlockedCtor = (name) =>
    function BlockedNetworkApi() {
      throw new DOMException(`${name} is disabled in Offline-only mode.`, 'SecurityError');
    };

  const injectOfflineCsp = () => {
    if (!document.head || document.getElementById('pdfcraft-offline-csp')) return;
    const meta = document.createElement('meta');
    meta.id = 'pdfcraft-offline-csp';
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content =
      "connect-src 'self' blob: data:; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; frame-src 'none';";
    document.head.appendChild(meta);
  };

  const lockApis = () => {
    if (locked) return;
    locked = true;
    try {
      if (originals.WebSocket) window.WebSocket = makeBlockedCtor('WebSocket');
      if (originals.WebTransport) window.WebTransport = makeBlockedCtor('WebTransport');
      if (originals.RTCPeerConnection) {
        window.RTCPeerConnection = makeBlockedCtor('RTCPeerConnection');
      }
      if (originals.webkitRTCPeerConnection) {
        window.webkitRTCPeerConnection = makeBlockedCtor('webkitRTCPeerConnection');
      }
      if (originals.EventSource) window.EventSource = makeBlockedCtor('EventSource');
      if (originals.sendBeacon) {
        navigator.sendBeacon = () => false;
      }
    } catch {
      // Ignore non-configurable browser globals.
    }
  };

  const unlockApis = () => {
    if (!locked) return;
    locked = false;
    try {
      if (originals.WebSocket) window.WebSocket = originals.WebSocket;
      if (originals.WebTransport) window.WebTransport = originals.WebTransport;
      if (originals.RTCPeerConnection) window.RTCPeerConnection = originals.RTCPeerConnection;
      if (originals.webkitRTCPeerConnection) {
        window.webkitRTCPeerConnection = originals.webkitRTCPeerConnection;
      }
      if (originals.EventSource) window.EventSource = originals.EventSource;
      if (originals.sendBeacon) navigator.sendBeacon = originals.sendBeacon;
    } catch {
      // Ignore non-configurable browser globals.
    }
  };

  // Best-effort browser-level CSP and non-HTTP network locks before upstream boots.
  const persisted = readStored();
  if (persisted && 'serviceWorker' in navigator) {
    injectOfflineCsp();
    lockApis();
  }

  window.__pdfcraftOffline = {
    storageKey: STORAGE_KEY,
    readStored,
    writeStored,
    lock: lockApis,
    unlock: unlockApis,
    isLocked: () => locked,
    hasBootCsp: () => Boolean(document.getElementById('pdfcraft-offline-csp')),
  };
})();
