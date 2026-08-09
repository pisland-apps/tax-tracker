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

## Deploy checklist — versioning

Every time `app.js` or `index.html` changes, before shipping:

1. **Bump `CACHE_VERSION` in `sw.js` by 1.** This is what drives cache
   busting — it's what makes returning visitors' browsers fetch the new
   files instead of serving a stale cached copy. The service worker's
   fetch handler checks the network first and only falls back to cache
   when offline, so most updates get through either way — but bumping it
   guarantees a clean reset instead of relying on that.
2. **Set `APP_VERSION` in `app.js` to the same number**, e.g.
   `CACHE_VERSION = 7` in `sw.js` ↔ `APP_VERSION = 'v7'` in `app.js`. This
   is the label shown in the small version badge in the bottom-right
   corner (visible even on the lock screen, before you unlock). The two
   constants live in different files and don't sync automatically — you
   have to update both by hand, to the same number, every time.
3. If a version badge after deploying doesn't match what you expect,
   that's a signal to hard-refresh (Ctrl/Cmd+Shift+R) or clear the site's
   Service Worker/cache in devtools — not that the deploy failed.
4. pdf.js (used for the in-app attachment viewer) is vendored locally at
   `./lib/pdf.min.js` and `./lib/pdf.worker.min.js` — not loaded from a
   CDN, so there's no `integrity=` hash to maintain and the CSP's
   `script-src`/`worker-src` stay `'self'`-only. To update pdf.js to a
   newer version:
   ```
   npm pack pdfjs-dist@<version>
   tar xzf pdfjs-dist-<version>.tgz
   cp package/build/pdf.min.js package/build/pdf.worker.min.js ./lib/
   ```
   Pull from the official npm package (not a random CDN/GitHub mirror),
   keep `pdf.min.js` and `pdf.worker.min.js` on the *same* version, add
   both new files to `APP_SHELL` in `sw.js` if their filenames changed,
   and bump `CACHE_VERSION`/`APP_VERSION` per steps 1–2 above so the new
   files actually reach returning visitors.

## Attachments

Each LHDN or IRAS entry can have image/PDF attachments (receipts, NOAs).
They're stored as base64 inside the record itself (so they travel with
JSON exports/imports too), and are viewed in-app — images via a blob
object URL, PDFs rendered page-by-page onto `<canvas>` via pdf.js — rather
than handed off to the browser's own PDF/download handling.

## Export scope

The export modal has an "Export Scope" dropdown: all members, or one
specific member. **Import always replaces the entire local database**
(after a confirmation prompt) — importing a single-member backup will
wipe out any other members currently stored on this device, not merge
alongside them. Use per-member export for a focused backup or handing
data to that person, not as a way to selectively restore one member into
a database that already has others.

## Passcode / encryption notes

- The passcode is never stored anywhere — only a PBKDF2-derived key exists,
  and only in memory for the current unlocked session.
- **There is no recovery mechanism.** Forgetting the passcode means the
  encrypted data cannot be recovered.
- Exported JSON backups (📥 Export JSON) are encrypted by default, using
  a *separate* backup passcode (not your app unlock passcode) with its own
  random salt — so a backup stays importable even after you later change
  your app passcode. You can toggle a backup to be plaintext instead, in
  which case a warning is shown before export.

## License

Add a license of your choice here before publishing (e.g. MIT).
