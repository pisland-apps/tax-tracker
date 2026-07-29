# Tax Record & Income Tracker

A local-first, passcode-encrypted tax record tracker for Malaysia (LHDN, RM)
and Singapore (IRAS, S$). All data lives in the browser's IndexedDB and is
encrypted at rest with a passcode-derived AES-GCM key (PBKDF2 + Web Crypto).
Nothing is sent to any server — this is a static, client-only app.

## Two versions in this repo

### `pwa/` — installable, works offline
The full app plus a service worker and manifest, so it can be installed
("Add to Home Screen" / desktop install) and used offline after the first
visit.

Deploy it as-is with GitHub Pages:
1. Settings → Pages → Deploy from branch → select the branch and set the
   folder to `/pwa` (or move the contents of `pwa/` to the repo root if you
   want it served from `/`).
2. Visit the published URL. The browser will register the service worker
   on first load and cache the app shell for offline use.

**Important — must be served over HTTP(S), not opened as a local file.**
Service workers and, in some browsers, the Web Crypto API used for
encryption are restricted to secure contexts (`https://`, or `http://localhost`).
Opening `pwa/index.html` directly via `file://` will likely show an
"encryption not available" error. Use GitHub Pages, or run a local server
(`python3 -m http.server`) for local testing.

### `standalone/` — single file, no PWA
`standalone/tax-tracker-standalone.html` is the same app with no service
worker and no manifest — just one HTML file. Double-click it and it opens
directly in a browser (works fine over `file://` in most browsers, though
see the same secure-context caveat above for encryption — Chrome generally
supports Web Crypto over `file://`; Firefox typically does not). Use this
if you don't want offline caching or don't want to deal with GitHub Pages
at all — just download the file and keep it locally, or host it anywhere.

## Bumping the service worker cache version

`pwa/sw.js` starts with:

```js
const CACHE_VERSION = 1;
```

**Increment this by 1 every time `index.html` (or anything else in
`pwa/`) changes**, and republish. The service worker uses this number to
name its cache (`tax-tracker-cache-v<N>`); bumping it is what makes
returning visitors' browsers discard the old cached version and pick up
the new one instead of silently continuing to serve stale content. If
you forget to bump it, the fetch handler still checks the network first
and falls back to cache only when offline, so most updates will still
get through — but bumping it guarantees a clean cache reset.

## Passcode / encryption notes

- The passcode is never stored anywhere — only a PBKDF2-derived key exists,
  and only in memory for the current unlocked session.
- **There is no recovery mechanism.** Forgetting the passcode means the
  encrypted data cannot be recovered.
- Exported JSON backups (`📥 Export JSON`) are encrypted by default, using
  a *separate* backup passcode (not your app unlock passcode) with its own
  random salt — so a backup stays importable even after you later change
  your app passcode. You can toggle a backup to be plaintext instead, in
  which case a warning is shown before export.

## License

Add a license of your choice here before publishing (e.g. MIT).
