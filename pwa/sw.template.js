// Auto-generated from pwa/sw.template.js by scripts/build.py.
// Do not edit dist/sw.js directly; edit pwa/sw.template.js instead.

const APP_VERSION = __APP_VERSION__;
const CORE_CACHE_SUFFIX = __CORE_CACHE_SUFFIX__;
const MODELS_CACHE_SUFFIX = __MODELS_CACHE_SUFFIX__;
const CORE_ASSETS = __CORE_ASSETS__;
const UNHASHED_CORE_HASHES = __UNHASHED_CORE_HASHES__;
const MODEL_HASHES = __MODEL_HASHES__;

const UNHASHED_CORE = new Set([
  './index.html',
  './manifest.webmanifest',
]);

const normalizeScope = (scope) => (scope.endsWith('/') ? scope : `${scope}/`);

const hashScope = (input) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

const SCOPE_PREFIX = normalizeScope(self.registration.scope);
const SCOPE_PATH = new URL(SCOPE_PREFIX).pathname;
const SCOPE_ID = hashScope(SCOPE_PREFIX);
const CACHE_PREFIX = `pdfcraft-${SCOPE_ID}-`;
const CORE_CACHE = `${CACHE_PREFIX}${CORE_CACHE_SUFFIX}`;
const MODELS_CACHE = `${CACHE_PREFIX}${MODELS_CACHE_SUFFIX}`;
const STATE_CACHE = `${CACHE_PREFIX}state`;
const STATE_DB_NAME = `pdfcraft-state-${SCOPE_ID}`;
const STATE_STORE = 'kv';
const OFFLINE_KEY = 'offlineOnly';

const resolveInScope = (relPath) => new URL(relPath, SCOPE_PREFIX).href;
const CORE_URL_SET = new Set(CORE_ASSETS.map(resolveInScope));
const MODEL_HASH_BY_URL = new Map(
  Object.entries(MODEL_HASHES).map(([rel, sha]) => [resolveInScope(rel), sha])
);
const INDEX_URL = resolveInScope('./index.html');
const OFFLINE_MARKER_URL = resolveInScope('./__offline_only_state__');

// Persisted Offline-only flag (IndexedDB with Cache Storage fallback) so cold-started
// Service Workers enforce it from the first request.
let offlineOnly = false;
let offlineStateLoaded = false;
let offlineStatePromise = null;

const openStateDb = () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(STATE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const readOfflineOnlyFromDb = async () => {
  try {
    const db = await openStateDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STATE_STORE, 'readonly');
      const req = tx.objectStore(STATE_STORE).get(OFFLINE_KEY);
      req.onsuccess = () => resolve(req.result === undefined ? null : Boolean(req.result));
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
};

const readOfflineOnlyFromCache = async () => {
  try {
    const cache = await caches.open(STATE_CACHE);
    const resp = await cache.match(OFFLINE_MARKER_URL);
    if (!resp) return false;
    return (await resp.text()) === '1';
  } catch {
    return false;
  }
};

const writeOfflineOnlyState = async (enabled) => {
  const val = Boolean(enabled);
  const dbWrite = (async () => {
    try {
      const db = await openStateDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STATE_STORE, 'readwrite');
        tx.objectStore(STATE_STORE).put(val, OFFLINE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Fall back to Cache Storage marker below.
    }
  })();

  const cacheWrite = (async () => {
    try {
      const cache = await caches.open(STATE_CACHE);
      await cache.put(
        OFFLINE_MARKER_URL,
        new Response(val ? '1' : '0', { headers: { 'Content-Type': 'text/plain' } })
      );
    } catch {
      // Keep in-memory state if both stores fail.
    }
  })();

  await Promise.all([dbWrite, cacheWrite]);
};

const ensureOfflineState = () => {
  if (offlineStateLoaded) return Promise.resolve(offlineOnly);
  if (!offlineStatePromise) {
    offlineStatePromise = (async () => {
      const fromDb = await readOfflineOnlyFromDb();
      const resolved = fromDb !== null ? fromDb : await readOfflineOnlyFromCache();
      if (!offlineStateLoaded) {
        offlineOnly = resolved;
        offlineStateLoaded = true;
      }
      return offlineOnly;
    })();
  }
  return offlineStatePromise;
};

const broadcastOfflineState = (enabled) =>
  self.clients
    .matchAll({ type: 'window', includeUncontrolled: false })
    .then((clients) => {
      for (const client of clients) {
        if (typeof client.url === 'string' && client.url.startsWith(SCOPE_PREFIX)) {
          client.postMessage({ type: 'OFFLINE_STATE', offlineOnly: Boolean(enabled) });
        }
      }
    })
    .catch(() => {});

const isCacheableResponse = (response, expectHtml) => {
  if (!response) return false;
  if (response.status !== 200 || response.type !== 'basic' || response.redirected) {
    return false;
  }
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  if (!expectHtml && ct.includes('text/html')) {
    return false;
  }
  return true;
};

const sha256Hex = async (buffer) => {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

// Deduplicate concurrent model downloads (background warmup vs user-triggered OCR)
// and avoid response.clone() double-buffering by consuming the response once.
const inflightModels = new Map();

const loadVerifiedModel = (url, expectedSha, cache) => {
  const existing = inflightModels.get(url);
  if (existing) return existing;

  const task = (async () => {
    const cleanReq = new Request(url, {
      credentials: 'same-origin',
      redirect: 'error',
    });
    const response = await fetch(cleanReq);
    if (!isCacheableResponse(response, false)) {
      return { ok: false, status: response.status, headers: response.headers, buf: await response.arrayBuffer() };
    }

    const buf = await response.arrayBuffer();
    if (self.crypto && self.crypto.subtle && expectedSha) {
      const actualSha = await sha256Hex(buf);
      if (actualSha !== expectedSha) {
        return { ok: false, status: 502, headers: new Headers({ 'Content-Type': 'text/plain' }), buf: null };
      }
    }

    const headers = new Headers(response.headers);
    const toStore = new Response(buf, { status: 200, statusText: 'OK', headers });
    await cache.put(url, toStore).catch(() => {});
    return { ok: true, status: 200, headers, buf };
  })().finally(() => {
    inflightModels.delete(url);
  });

  inflightModels.set(url, task);
  return task;
};

let modelWarmupPromise = null;

const warmModelsCache = () => {
  if (modelWarmupPromise) return modelWarmupPromise;
  modelWarmupPromise = (async () => {
    if (await ensureOfflineState()) return;
    const entries = Array.from(MODEL_HASH_BY_URL.entries());
    if (!entries.length) return;
    const cache = await caches.open(MODELS_CACHE);
    for (const [url, expectedSha] of entries) {
      if (offlineOnly) return;
      try {
        if (await cache.match(url)) continue;
        await loadVerifiedModel(url, expectedSha, cache);
      } catch {
        // Keep warming remaining models if one transfer fails transiently.
      }
    }
  })().finally(() => {
    modelWarmupPromise = null;
  });
  return modelWarmupPromise;
};

const getCacheStatus = async () => {
  const isOfflineOnly = await ensureOfflineState();
  let coreCached = 0;
  let modelsCached = 0;
  try {
    const core = await caches.open(CORE_CACHE);
    coreCached = (await core.keys()).length;
  } catch {
    // Ignore cache read error.
  }
  try {
    const models = await caches.open(MODELS_CACHE);
    modelsCached = (await models.keys()).length;
  } catch {
    // Ignore cache read error.
  }
  return {
    version: APP_VERSION,
    offlineOnly: isOfflineOnly,
    coreReady: coreCached >= CORE_ASSETS.length,
    coreCached,
    coreTotal: CORE_ASSETS.length,
    modelsReady: modelsCached >= MODEL_HASH_BY_URL.size,
    modelsCached,
    modelsTotal: MODEL_HASH_BY_URL.size,
  };
};

const isUnhashedAsset = (relPath) =>
  UNHASHED_CORE.has(relPath) || relPath.startsWith('./icons/');

let coreRepairPromise = null;

const repairCoreCache = () => {
  if (coreRepairPromise) return coreRepairPromise;
  coreRepairPromise = (async () => {
    if (await ensureOfflineState()) return;
    const cache = await caches.open(CORE_CACHE);
    await Promise.all(
      CORE_ASSETS.map(async (relPath) => {
        const url = resolveInScope(relPath);
        if (await cache.match(url)) return;
        const resp = await fetch(
          new Request(url, {
            cache: isUnhashedAsset(relPath) ? 'no-cache' : 'default',
            credentials: 'same-origin',
            redirect: 'error',
          })
        );
        if (!isCacheableResponse(resp, relPath === './index.html')) return;
        const expectedSha = UNHASHED_CORE_HASHES[relPath];
        if (expectedSha && self.crypto && self.crypto.subtle) {
          const buf = await resp.arrayBuffer();
          if ((await sha256Hex(buf)) !== expectedSha) return;
          await cache.put(
            url,
            new Response(buf, { status: 200, statusText: 'OK', headers: new Headers(resp.headers) })
          );
          return;
        }
        await cache.put(url, resp);
      })
    );
  })().finally(() => {
    coreRepairPromise = null;
  });
  return coreRepairPromise;
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // Defer background SW updates only when an active worker already controls Offline-only mode.
      // If no active worker exists (for example after manual unregister), reset stored state and install.
      if (self.registration.active) {
        if (await ensureOfflineState()) {
          throw new Error('Offline-only mode active: update deferred');
        }
      } else {
        offlineOnly = false;
        offlineStateLoaded = true;
        await writeOfflineOnlyState(false);
      }
      const cache = await caches.open(CORE_CACHE);
      await Promise.all(
        CORE_ASSETS.map(async (relPath) => {
          const url = resolveInScope(relPath);
          const req = new Request(url, {
            cache: isUnhashedAsset(relPath) ? 'no-cache' : 'default',
            credentials: 'same-origin',
            redirect: 'error',
          });
          const resp = await fetch(req);
          if (!isCacheableResponse(resp, relPath === './index.html')) {
            throw new Error(`Refused to precache ${relPath} (HTTP ${resp.status})`);
          }
          await cache.put(url, resp);
        })
      );
    })()
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([CORE_CACHE, MODELS_CACHE, STATE_CACHE]);
  event.waitUntil(
    Promise.all([
      ensureOfflineState(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((k) => k.startsWith(CACHE_PREFIX) && !keep.has(k))
              .map((k) => caches.delete(k))
          )
        ),
    ]).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (!event.source || typeof event.source.url !== 'string') return;
  if (!event.source.url.startsWith(SCOPE_PREFIX)) return;
  if (!event.data || typeof event.data !== 'object') return;

  const reply = (payload) => {
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(payload);
    }
  };

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data.type === 'WARM_MODELS') {
    event.waitUntil(warmModelsCache().catch(() => {}));
  } else if (event.data.type === 'REPAIR_CORE') {
    event.waitUntil(
      repairCoreCache()
        .catch(() => {})
        .then(() => getCacheStatus())
        .then((status) => reply(status))
    );
  } else if (event.data.type === 'SET_OFFLINE_ONLY') {
    const next = Boolean(event.data.enabled);
    offlineOnly = next;
    offlineStateLoaded = true;
    event.waitUntil(
      writeOfflineOnlyState(next)
        .then(() => broadcastOfflineState(next))
        .then(() => reply({ ok: true, offlineOnly: next }))
    );
  } else if (event.data.type === 'GET_STATUS') {
    event.waitUntil(getCacheStatus().then((status) => reply(status)));
  } else if (event.data.type === 'GET_VERSION') {
    reply({ version: APP_VERSION });
  }
});

const failOpenOnMissingCore = async (event) => {
  offlineOnly = false;
  offlineStateLoaded = true;
  await writeOfflineOnlyState(false);
  event.waitUntil(broadcastOfflineState(false));
  return handleOnlineFetch(event);
};

const handleOfflineOnlyFetch = async (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only allow GET requests within our scope that already exist in local cache.
  if (request.method === 'GET' && url.origin === self.location.origin) {
    const normalizedHref = `${url.origin}${url.pathname}`;
    if (normalizedHref.startsWith(SCOPE_PREFIX)) {
      if (
        request.mode === 'navigate' &&
        (url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`)
      ) {
        const core = await caches.open(CORE_CACHE);
        const cached = await core.match(INDEX_URL);
        if (cached) return cached;
        // Full cache loss: fail open instead of stranding the user on a dead error page.
        return failOpenOnMissingCore(event);
      }
      if (MODEL_HASH_BY_URL.has(normalizedHref)) {
        const models = await caches.open(MODELS_CACHE);
        const cached = await models.match(normalizedHref);
        if (cached) return cached;
      } else if (CORE_URL_SET.has(normalizedHref)) {
        const core = await caches.open(CORE_CACHE);
        const cached = await core.match(normalizedHref);
        if (cached) return cached;
        // Partial core cache loss: fail open so the app can recover and re-cache cleanly.
        return failOpenOnMissingCore(event);
      }
    }
  }

  return Response.error();
};

const handleOnlineFetch = async (event) => {
  const { request } = event;
  if (request.method !== 'GET') return fetch(request);

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return fetch(request);
  const normalizedHref = `${url.origin}${url.pathname}`;
  if (!normalizedHref.startsWith(SCOPE_PREFIX)) return fetch(request);

  if (request.mode === 'navigate') {
    if (url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`) {
      const cache = await caches.open(CORE_CACHE);
      const cached = await cache.match(INDEX_URL);
      if (cached) return cached;
    }
    return fetch(request);
  }

  if (MODEL_HASH_BY_URL.has(normalizedHref)) {
    const expectedSha = MODEL_HASH_BY_URL.get(normalizedHref);
    const cache = await caches.open(MODELS_CACHE);
    const cached = await cache.match(normalizedHref);
    if (cached) return cached;

    const result = await loadVerifiedModel(normalizedHref, expectedSha, cache);
    if (!result.ok) {
      return new Response(result.buf || 'Model integrity check failed', {
        status: result.status,
        headers: result.headers,
      });
    }
    return new Response(result.buf, {
      status: 200,
      statusText: 'OK',
      headers: result.headers,
    });
  }

  if (CORE_URL_SET.has(normalizedHref)) {
    const cache = await caches.open(CORE_CACHE);
    const cached = await cache.match(normalizedHref);
    if (cached) return cached;

    const cleanReq = new Request(normalizedHref, {
      credentials: 'same-origin',
      redirect: 'error',
    });
    const response = await fetch(cleanReq);
    if (isCacheableResponse(response, normalizedHref === INDEX_URL)) {
      event.waitUntil(cache.put(normalizedHref, response.clone()).catch(() => {}));
    }
    return response;
  }

  return fetch(request);
};

self.addEventListener('fetch', (event) => {
  // Fast path once offline state is known to be OFF: let non-GET and cross-origin pass untouched.
  if (offlineStateLoaded && !offlineOnly) {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    const normalizedHref = `${url.origin}${url.pathname}`;
    if (!normalizedHref.startsWith(SCOPE_PREFIX)) return;

    const isHandled =
      (request.mode === 'navigate' &&
        (url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`)) ||
      MODEL_HASH_BY_URL.has(normalizedHref) ||
      CORE_URL_SET.has(normalizedHref);
    if (!isHandled) return;

    event.respondWith(handleOnlineFetch(event));
    return;
  }

  // When offlineOnly is ON or SW just cold-started, await persisted flag before any network call.
  event.respondWith(
    ensureOfflineState().then((isOffline) =>
      isOffline ? handleOfflineOnlyFetch(event) : handleOnlineFetch(event)
    )
  );
});
