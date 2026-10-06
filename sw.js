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
const CACHE_VERSION = 16;
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
  './lib/pdf.min.mjs',
  './lib/pdf.worker.min.mjs'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
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
