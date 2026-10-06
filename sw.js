// Tax Record & Income Tracker — Service Worker
//
// CACHE_VERSION is what drives cache busting. Bump it by 1 every time
// index.html (or any cached asset) changes, so returning visitors'
// browsers pick up the new version instead of continuing to serve a
// stale cached copy.
//
// Kept numerically IN SYNC with APP_VERSION in app.js (the human-readable
// label shown in the bottom-right version badge) on purpose — they live
// in different files and don't sync automatically, so bump BOTH to the
// same number by hand on every deploy that touches app.js or index.html.
const CACHE_VERSION = 17;
const CACHE_NAME = `tax-tracker-cache-v${CACHE_VERSION}`;

// './index.html' is deliberately NOT listed: Cloudflare Pages redirects /index.html to /, and
// cache.addAll() would store that as a *redirected* response. The one canonical page entry is './'.
const APP_SHELL = [
  './',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './lib/pdf-loader.mjs',
  // v17: pdf.js lives in a version-named folder (PDFJS_DIR in lib/pdf-loader.mjs)
  // so its main file, worker and decoders can only come from the same release.
  // Keep these lines and PDFJS_DIR in step when pdf.js is updated.
  './lib/pdfjs-6.4.299/pdf.min.mjs',
  './lib/pdfjs-6.4.299/pdf.worker.min.mjs',
  // Image decoders for scanner PDFs. The CSP does not allow compiling
  // WebAssembly, so pdf.js uses the *_nowasm_fallback.js; the .wasm files are
  // kept with them (they are used if the CSP ever gains 'wasm-unsafe-eval').
  // All must work offline.
  './lib/pdfjs-6.4.299/wasm/jbig2.wasm',
  './lib/pdfjs-6.4.299/wasm/openjpeg.wasm',
  './lib/pdfjs-6.4.299/wasm/qcms_bg.wasm',
  './lib/pdfjs-6.4.299/wasm/jbig2_nowasm_fallback.js',
  './lib/pdfjs-6.4.299/wasm/openjpeg_nowasm_fallback.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    // v17: cache:"reload" so the pre-cache never copies a stale file out of the
    // browser's own HTTP cache, which could precache a half-old, half-new set.
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Network-first with cache fallback, so visitors always get the latest version when online and the
// last cached version when offline. All app data lives in IndexedDB in the page itself (not here),
// so this worker only needs to cache the app shell files.
//
// Two rules about redirects (Cloudflare Pages answers /index.html with a redirect to /):
//  1. A page navigation is always answered from the ONE canonical entry './', whatever URL was
//     asked for (/, /index.html, a bookmark with a query string...). The entry is refreshed from
//     the network whenever a navigation succeeds.
//  2. A redirected response is never written to the cache. Browsers refuse to let a service worker
//     answer a navigation with a redirected response, so one stored copy could break the app
//     (ERR_FAILED) when launched from an installed shortcut.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && !response.redirected) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./', clone));
          }
          return response;
        })
        .catch(() => caches.match('./'))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && !response.redirected) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
