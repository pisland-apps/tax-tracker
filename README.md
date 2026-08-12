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

## Security headers (`_headers` file)

`_headers` at the repo root sets real HTTP response headers — this only
works if the site is served by **Cloudflare Pages** (a GitHub repo
connected to Cloudflare Pages for build/deploy), not plain GitHub Pages.
GitHub Pages itself has no mechanism for custom headers at all, so if
this repo is ever pointed back at GitHub Pages directly (or moved to a
host that doesn't read a `_headers` file), these stop applying silently
— worth a quick check in the Network tab (any response header starting
`x-frame-options`/`content-security-policy`) after deploying to confirm
they're actually live, since there's no visible error if they're not.

Why this file exists alongside the `<meta http-equiv="Content-Security-
Policy">` tag in `index.html`: `<meta>` CSP can't carry `frame-ancestors`
— browsers only honor that directive from a real HTTP header — so the
`<meta>` tag alone can't stop this app from being embedded in another
site's `<iframe>` (clickjacking). `_headers` adds the same CSP again as
an actual header (this time including `frame-ancestors 'none'`), plus:

- `X-Frame-Options: DENY` — old-browser fallback for the same
  anti-embedding protection `frame-ancestors` provides.
- `X-Content-Type-Options: nosniff` — stops the browser from
  reinterpreting a file as a different content-type than served.
- `Referrer-Policy: no-referrer` — never leaks this page's URL to an
  outbound request (there aren't any here, but future-proofs it).
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`
  — disables browser APIs this app never uses, so even a successful XSS
  couldn't invoke them.

**Keep both CSPs in sync.** If `script-src`/`img-src`/etc. in the
`<meta>` tag in `index.html` ever changes, make the same edit to the
`Content-Security-Policy` line in `_headers` — they're independent
copies and won't drift-detect each other.

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
   `./lib/pdf.min.mjs` and `./lib/pdf.worker.min.mjs` — not loaded from a
   CDN, so there's no `integrity=` hash to maintain and the CSP's
   `script-src`/`worker-src` stay `'self'`-only.

   Note: pdfjs-dist stopped shipping a classic/UMD build from v4.0.0
   onward (it's ESM-only now), so there's a third small file,
   `./lib/pdf-loader.mjs` — a module shim that imports `pdf.min.mjs` and
   assigns it to `window.pdfjsLib`, so `app.js` (a classic script) can
   keep reading a plain global the same way it always did. You don't
   need to touch `pdf-loader.mjs` when updating pdf.js versions, only
   the two vendored library files.

   To update pdf.js to a newer version:
   ```
   npm pack pdfjs-dist@<version>
   tar xzf pdfjs-dist-<version>.tgz
   cp package/build/pdf.min.mjs package/build/pdf.worker.min.mjs ./lib/
   ```
   Pull from the official npm package (not a random CDN/GitHub mirror),
   keep `pdf.min.mjs` and `pdf.worker.min.mjs` on the *same* version, add
   any new/renamed files to `APP_SHELL` in `sw.js`, and bump
   `CACHE_VERSION`/`APP_VERSION` per steps 1–2 above so the new files get
   picked up by returning visitors. **Also update the checksums below**
   — recompute with:
   ```
   openssl dgst -sha256 lib/pdf.min.mjs
   openssl dgst -sha256 lib/pdf.worker.min.mjs
   openssl dgst -sha256 lib/pdf-loader.mjs
   ```
   These are a documentation-only record for verifying the vendored
   files weren't corrupted/altered after fetching — not a live
   `integrity=` attribute (same-origin `'self'` scripts aren't subject
   to SRI, and pinning it there would just add a way for the app to
   break silently on a stale/mismatched hash with no upside, since same
   origin has nothing external to protect against). Current pdfjs-dist
   version: **6.2.108** (updated from 4.10.38 — routine version bump,
   no CVE prompting it; `getDocument`/`GlobalWorkerOptions` usage in
   `app.js` is unchanged and compatible with this release).

   | File | SHA-256 |
   |---|---|
   | `lib/pdf.min.mjs` | `e0be3863c23c8af2305b16548febd58e7f8874a460253317d7771cddbc1c0f6d` |
   | `lib/pdf.worker.min.mjs` | `0613f41490dd6aaceed7a93fbbd38c85e6d6aa60474b6588c6e7709cfbe18cb3` |
   | `lib/pdf-loader.mjs` | `c578398411d31ea81a7649351379c68d79a4052de7579240d2e6c62ce220f860` |

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
- **Idle auto-lock**: the ⏱️ Auto-lock dropdown in the header (Never / 1 /
  5 / 15 / 30 min) clears the in-memory encryption key and returns to the
  lock screen after that many minutes with no mouse/keyboard/touch
  activity. Defaults to 15 minutes on first setup. The choice is saved
  per-device in the local vault metadata (unencrypted — it's just a UI
  preference), and is preserved across a passcode change.

## License

Add a license of your choice here before publishing (e.g. MIT).
