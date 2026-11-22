// Auto-generated from pwa/sw.template.js by scripts/build.py.
// Do not edit dist/sw.js directly; edit pwa/sw.template.js instead.

const APP_VERSION = __APP_VERSION__;
const CORE_CACHE_SUFFIX = __CORE_CACHE_SUFFIX__;
const MODELS_CACHE_SUFFIX = __MODELS_CACHE_SUFFIX__;
const CORE_ASSETS = __CORE_ASSETS__;
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
const CACHE_PREFIX = `pdfcraft-${hashScope(SCOPE_PREFIX)}-`;
const CORE_CACHE = `${CACHE_PREFIX}${CORE_CACHE_SUFFIX}`;
const MODELS_CACHE = `${CACHE_PREFIX}${MODELS_CACHE_SUFFIX}`;

const resolveInScope = (relPath) => new URL(relPath, SCOPE_PREFIX).href;
const CORE_URL_SET = new Set(CORE_ASSETS.map(resolveInScope));
const MODEL_HASH_BY_URL = new Map(
  Object.entries(MODEL_HASHES).map(([rel, sha]) => [resolveInScope(rel), sha])
);
const INDEX_URL = resolveInScope('./index.html');

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
    await cache.put(url, toStore).catch(() => { });
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
    const entries = Array.from(MODEL_HASH_BY_URL.entries());
    if (!entries.length) return;
    const cache = await caches.open(MODELS_CACHE);
    for (const [url, expectedSha] of entries) {
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

const isUnhashedAsset = (relPath) =>
  UNHASHED_CORE.has(relPath) || relPath.startsWith('./icons/');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE).then(async (cache) => {
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
    })
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([CORE_CACHE, MODELS_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && !keep.has(k))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (!event.source || typeof event.source.url !== 'string') return;
  if (!event.source.url.startsWith(SCOPE_PREFIX)) return;
  if (!event.data || typeof event.data !== 'object') return;

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data.type === 'WARM_MODELS') {
    event.waitUntil(warmModelsCache().catch(() => { }));
  } else if (event.data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const normalizedHref = `${url.origin}${url.pathname}`;
  if (!normalizedHref.startsWith(SCOPE_PREFIX)) return;

  // Serve cached index.html only for app entry navigation routes (./ and ./index.html),
  // preserving query parameters such as ?webgl, ?cpu, ?file=, or ?control.
  if (request.mode === 'navigate') {
    if (url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`) {
      event.respondWith(
        caches.open(CORE_CACHE).then(async (cache) => {
          const cached = await cache.match(INDEX_URL);
          if (cached) return cached;
          return fetch(request);
        })
      );
    }
    return;
  }

  // OCR ONNX models: cached in the background after first load (and on demand)
  // after verifying SHA-256 against the build-time digest.
  if (MODEL_HASH_BY_URL.has(normalizedHref)) {
    const expectedSha = MODEL_HASH_BY_URL.get(normalizedHref);
    event.respondWith(
      caches.open(MODELS_CACHE).then(async (cache) => {
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
      })
    );
    return;
  }

  // Core app assets (JS, WASM, workers, snippets, manifest, icons): cache-first.
  if (CORE_URL_SET.has(normalizedHref)) {
    event.respondWith(
      caches.open(CORE_CACHE).then(async (cache) => {
        const cached = await cache.match(normalizedHref);
        if (cached) return cached;

        const cleanReq = new Request(normalizedHref, {
          credentials: 'same-origin',
          redirect: 'error',
        });
        const response = await fetch(cleanReq);
        if (isCacheableResponse(response, normalizedHref === INDEX_URL)) {
          event.waitUntil(cache.put(normalizedHref, response.clone()).catch(() => { }));
        }
        return response;
      })
    );
  }
});
