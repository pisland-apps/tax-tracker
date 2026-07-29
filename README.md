# Tax Record & Income Tracker

A local-first, passcode-encrypted tax record tracker for Malaysia (LHDN, RM)
and Singapore (IRAS, S$). All data lives in the browser's IndexedDB and is
encrypted at rest with a passcode-derived AES-GCM key (PBKDF2 + Web Crypto).
Nothing is sent to any server — this is a static, client-only app.

## Structure

```
index.html          ← the app (installable PWA — reads manifest.json below)
manifest.json        ← PWA metadata
sw.js                 ← service worker (offline caching)
icons/                ← app icons
standalone/
  tax-tracker-standalone.html   ← same app, single file, no PWA/service worker
```

`index.html`, `manifest.json`, `sw.js`, and `icons/` sit at the repo root
**on purpose** — GitHub Pages serves `index.html` automatically when it's
present at the root of the published branch/folder, without any extra
configuration.

## Deploying with GitHub Pages

1. Repo → **Settings → Pages**.
2. Source: **Deploy from a branch**.
3. Branch: `main`, folder: **`/ (root)`** → **Save**.
4. Wait a minute, then visit the URL shown at the top of the Pages
   settings page (e.g. `https://<username>.github.io/<repo>/`). It will
   load `index.html` — the app — directly.

If you ever see the README rendered as the homepage instead of the app,
it means `index.html` isn't present at the root of whatever folder you
selected — check that it's still there and the folder setting is
`/ (root)`, not `/docs` or a subfolder.

**Must be served over HTTP(S), not opened as a local file.** Service
workers and, in some browsers, the Web Crypto API used for encryption are
restricted to secure contexts (`https://`, or `http://localhost`). Opening
`index.html` directly via `file://` will likely show an "encryption not
available" error. Use GitHub Pages, or run a local server
(`python3 -m http.server`) for local testing.

## The standalone version

`standalone/tax-tracker-standalone.html` is the same app with no service
worker and no manifest — just one HTML file. Download it and double-click
to open directly in a browser (works over `file://` in most browsers,
though see the secure-context caveat above for encryption — Chrome
generally supports Web Crypto over `file://`; Firefox typically does not).
Use this if you don't want offline caching, or don't want to deal with
GitHub Pages at all.

## Bumping the service worker cache version

`sw.js` starts with:

```js
const CACHE_VERSION = 1;
```

**Increment this by 1 every time `index.html` (or anything else at the
repo root) changes**, and republish. The service worker uses this number
to name its cache (`tax-tracker-cache-v<N>`); bumping it is what makes
returning visitors' browsers discard the old cached version and pick up
the new one instead of silently continuing to serve stale content. If you
forget to bump it, the fetch handler still checks the network first and
falls back to cache only when offline, so most updates will still get
through — but bumping it guarantees a clean cache reset.

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
