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
  './pwa-register.js',
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

  // OCR ONNX models: cached on first use after verifying SHA-256 against the
  // build-time digest so captive portals or corrupt transfers cannot poison the cache.
  if (MODEL_HASH_BY_URL.has(normalizedHref)) {
    const expectedSha = MODEL_HASH_BY_URL.get(normalizedHref);
    event.respondWith(
      caches.open(MODELS_CACHE).then(async (cache) => {
        const cached = await cache.match(normalizedHref);
        if (cached) return cached;

        const cleanReq = new Request(normalizedHref, {
          credentials: 'same-origin',
          redirect: 'error',
        });
        const response = await fetch(cleanReq);
        if (!isCacheableResponse(response, false)) {
          return response;
        }

        if (self.crypto && self.crypto.subtle && expectedSha) {
          const buf = await response.clone().arrayBuffer();
          const actualSha = await sha256Hex(buf);
          if (actualSha !== expectedSha) {
            return new Response('Model integrity check failed', { status: 502 });
          }
          const verified = new Response(buf, {
            status: 200,
            statusText: 'OK',
            headers: response.headers,
          });
          event.waitUntil(cache.put(normalizedHref, verified.clone()).catch(() => {}));
          return verified;
        }

        event.waitUntil(cache.put(normalizedHref, response.clone()).catch(() => {}));
        return response;
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
          event.waitUntil(cache.put(normalizedHref, response.clone()).catch(() => {}));
        }
        return response;
      })
    );
  }
});
