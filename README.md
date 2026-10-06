# Tax Record & Income Tracker

A local-first, passcode-encrypted tax record tracker for Malaysia (LHDN, RM)
and Singapore (IRAS, S$). All data lives in the browser's IndexedDB and is
encrypted at rest with a passcode-derived AES-GCM key (PBKDF2 + Web Crypto).
Nothing is sent to any server — this is a static, client-only app.

## What it does

- **Overview page:** one card per member per enabled tax type (a member with both LHDN and IRAS gets two cards) with Total Income (blue), Total Tax Paid (red) and Net Income (green). A card opens that member's Ledger. Toolbar: 👥 Members, 🖨️ Print Report, + Add Record, and an owner filter.
- **Ledger page** (per member, per tax type): summary card(s), a collapsible entry form, the records table, print, and for LHDN the **Company Income Report** (Table or Card view; Card is the default).
- **LHDN (Malaysia):** working year, submit year, Tahun Taksiran, income sources (company + amount), declared income (the sum of the sources unless typed in), tax paid, and an optional **LHDN Adjustment** whose adjusted income and adjusted tax each override independently.
- **IRAS (Singapore):** working year, submit year, NOA, assessable income per NOA, tax payment, an optional note (commas make a bullet list), and a computed net income.
- **Members:** name, which tax types are enabled, optional birth year (shown as "Age" under Working Year), and an optional **Singapore pass** (WP / SP / EP / PR) with From / Till dates. The member card shows "Status & Date Renewal" (amber within 12 months, red when overdue) and a reminder banner appears under the header.
- **Attachments, backups, lock:** see the sections below.
- **Safer by design (v16):** Change Passcode and Import are all-or-nothing (a failure or a closed tab leaves your data exactly as it was); a backup file is checked completely before anything is replaced and the confirmation shows what it contains; a damaged item is skipped with a warning banner instead of freezing the app; if the passcode is changed in another window, this window locks itself; locking closes every open viewer and empties the screen.
- **Back button:** the phone / browser Back button (and Escape on a desktop) closes the open layer (a modal, the attachment viewer, or the Ledger) instead of leaving the app.
- **Lock screen:** a big on-screen numpad (the phone keyboard stays hidden); "⌨️ Use keyboard instead" switches back to normal typing for passcodes that contain letters.

## Structure

```
index.html            <- the page (markup + CSP <meta>); installable PWA, reads manifest.json
app.js                <- all application logic; APP_VERSION / APP_VERSION_DATE live here
manifest.json         <- PWA metadata (start_url "./")
sw.js                 <- service worker (offline caching); CACHE_VERSION lives here
_headers              <- real HTTP security headers (Cloudflare Pages only, see below)
icons/                <- icon-192.png, icon-512.png
lib/
  pdf-loader.mjs     <- small module shim: exposes pdf.js as window.pdfjsLib (and holds PDFJS_DIR)
  pdfjs-6.4.299/     <- pdf.js, vendored in a version-named folder (v17), see the deploy checklist
    pdf.min.mjs        (legacy build)
    pdf.worker.min.mjs (worker, same release)
    wasm/              (image decoders for scanner PDFs: .wasm + plain-JS *_nowasm_fallback.js)
```

`index.html`, `app.js`, `manifest.json`, `sw.js`, `_headers`, `icons/` and `lib/` sit at the repo root
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

Every time `app.js`, `index.html`, `manifest.json` or any cached file changes, before shipping:

1. **Bump `CACHE_VERSION` in `sw.js` by 1.** This is what drives cache
   busting — it's what makes returning visitors' browsers fetch the new
   files instead of serving a stale cached copy. The service worker's
   fetch handler checks the network first and only falls back to cache
   when offline, so most updates get through either way — but bumping it
   guarantees a clean reset instead of relying on that.
2. **Set `APP_VERSION` in `app.js` to the same number**, e.g.
   `CACHE_VERSION = 16` in `sw.js` ↔ `APP_VERSION = 'v16'` in `app.js`. This
   is the label shown in the small version badge in the bottom-right
   corner (visible even on the lock screen, before you unlock). The two
   constants live in different files and don't sync automatically — you
   have to update both by hand, to the same number, every time.
3. If a version badge after deploying doesn't match what you expect,
   that's a signal to hard-refresh (Ctrl/Cmd+Shift+R) or clear the site's
   Service Worker/cache in devtools — not that the deploy failed.
4. pdf.js (used for the in-app attachment viewer) is vendored locally at
   `./lib/pdfjs-6.4.299/` (`pdf.min.mjs`, `pdf.worker.min.mjs` and a `wasm/`
   folder) — not loaded from a CDN, so there's no `integrity=` hash to maintain
   and the CSP's `script-src`/`worker-src` stay `'self'`-only.

   Note: pdfjs-dist stopped shipping a classic/UMD build from v4.0.0
   onward (it's ESM-only now), so there's a third small file,
   `./lib/pdf-loader.mjs` — a module shim that imports `pdf.min.mjs` and
   assigns it to `window.pdfjsLib`, so `app.js` (a classic script) can
   keep reading a plain global the same way it always did.

   **Since v17 the pdf.js files live in a folder named after the version**
   (`lib/pdfjs-6.4.299/`) and `pdf-loader.mjs` builds every path (main file,
   worker, `wasm/` decoders) from one constant, `PDFJS_DIR`. The main file and
   the worker must be the same release (an old main file with a new worker
   hangs on "Loading…"), and with fixed file names a cache can hand out one old
   and one new file during an update; different releases now have different
   paths, so that cannot happen. **Never overwrite files in an existing
   versioned folder.**

   To update pdf.js to a newer version:
   ```
   npm pack pdfjs-dist@<version>
   tar xzf pdfjs-dist-<version>.tgz
   mkdir -p lib/pdfjs-<version>/wasm
   cp package/legacy/build/pdf.min.mjs package/legacy/build/pdf.worker.min.mjs lib/pdfjs-<version>/
   cp package/wasm/* lib/pdfjs-<version>/wasm/      # then delete quickjs-eval.js and quickjs-eval.wasm (not needed)
   ```
   Then change `PDFJS_DIR` in `lib/pdf-loader.mjs` and the `./lib/pdfjs-…` lines
   in `APP_SHELL` in `sw.js` (7 lines: 2 library files + 5 decoder files), and
   delete the old `lib/pdfjs-<old version>/` folder. Keep the **whole** `wasm/`
   folder, including the `*_nowasm_fallback.js` files: this app's CSP does not
   allow compiling WebAssembly, so those JavaScript copies are what actually
   decodes scanner PDFs (see v17 in the update log).
   Use the **`legacy/build`** files, not `build/`: the modern build needs a very
   new browser feature (`Map.prototype.getOrInsertComputed`, Chrome 145 and
   later) and shows "Could not preview this file" in older browsers, including
   many phones; the legacy build carries its own fallbacks and also works in
   current browsers. Pull from the official npm package (not a random CDN/GitHub mirror),
   keep `pdf.min.mjs` and `pdf.worker.min.mjs` on the *same* version (the
   folder name enforces it), add any new/renamed files to `APP_SHELL` in
   `sw.js`, and bump
   `CACHE_VERSION`/`APP_VERSION` per steps 1–2 above so the new files get
   picked up by returning visitors. **Also update the checksums below**
   — recompute with:
   ```
   openssl dgst -sha256 lib/pdfjs-6.4.299/pdf.min.mjs
   openssl dgst -sha256 lib/pdfjs-6.4.299/pdf.worker.min.mjs
   openssl dgst -sha256 lib/pdf-loader.mjs
   ```
   These are a documentation-only record for verifying the vendored
   files weren't corrupted/altered after fetching — not a live
   `integrity=` attribute (same-origin `'self'` scripts aren't subject
   to SRI, and pinning it there would just add a way for the app to
   break silently on a stale/mismatched hash with no upside, since same
   origin has nothing external to protect against). Current pdfjs-dist
   version: **6.4.299, legacy build** (v16; up from 6.2.108, which was already
   the fixed version for CVE-2026-16633). `getDocument` is called (in one place,
   `startPdfDocument()` in `app.js`) with `isEvalSupported: false`, `wasmUrl`,
   `canvasMaxAreaInBytes: 32 MiB` and a 30-second give-up timer, and the viewer
   destroys the loading task when a PDF is closed. Retest PDF viewing after
   every pdf.js update — with an ordinary PDF **and** a scanner PDF.

   | File | SHA-256 |
   |---|---|
   | `lib/pdfjs-6.4.299/pdf.min.mjs` | `bccc24ea711db8e44503629519904a5292d73b9daaa214bbe7cdcc282b0f4259` |
   | `lib/pdfjs-6.4.299/pdf.worker.min.mjs` | `145d2dd3ab0c86151011dba95acfa2d5336e2accd59388ea43dbee0efddaaec6` |
   | `lib/pdf-loader.mjs` | `aa639cbadc312140e26d92ac6d7521b011bfbd56abd299d9c922de4f20bd7529` |

   (The two pdf.js files are byte-for-byte the v16 files, only moved. The `wasm/` files come
   from the same pdfjs-dist 6.4.299 package and are not listed.)

## Service worker and redirects

The service worker is network-first with a cache fallback. Cloudflare Pages answers `/index.html` with a redirect to `/`, and a browser will not let a service worker answer a page navigation with a *redirected* response, so:
- `manifest.json` uses `"start_url": "./"` (not `./index.html`);
- `./index.html` is not in the precache list; the one canonical page entry is `./`;
- every page navigation is answered from that `./` entry whatever URL was asked for (`/`, `/index.html`, a bookmark with a query string), and a redirected response is never written to the cache.

Installed copies made before v15 still start at `./index.html`; that keeps working. This was tested in headless Chromium against a local server that imitates the redirect, online and with the server stopped, and for the upgrade from v14. It has **not** been confirmed on the real Cloudflare Pages host.

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

## Update log

- **v17** — **Scanner PDFs no longer show blank pages; pdf.js files moved into a version-named folder.** PDFs saved by a flat-bed scanner (for example EPSON Scan: 1-bit black-and-white pages, CCITT / JBIG2) and PDFs with JPEG 2000 images could show blank pages in the attachment viewer: since pdf.js 5 their decoders are WebAssembly files that must be passed to `getDocument()` as `wasmUrl`, and this app never did (the console says "JBig2 failed to initialize"). New `lib/pdfjs-6.4.299/wasm/` holds `jbig2.wasm`, `openjpeg.wasm`, `qcms_bg.wasm` and the plain-JavaScript `jbig2_nowasm_fallback.js` / `openjpeg_nowasm_fallback.js` (plus licences), and `getDocument()` now gets `wasmUrl`. **The CSP and `_headers` are unchanged:** `script-src 'self'` does not allow compiling WebAssembly (and a CSP sent as an HTTP header also binds pdf.js's worker), so pdf.js loads the JavaScript decoders from the same folder instead — which is why both kinds of file are shipped. Also: `canvasMaxAreaInBytes: 32 MiB`, because a 600 dpi scan page is one ~28-megapixel image and pdf.js's own guess of the largest canvas can fail under memory pressure (`transferToImageBitmap … ImageBitmap construction failed`), leaving that page blank only sometimes — larger images are now shrunk first; a 30-second timeout with a clear message instead of "Loading…" forever; one function, `startPdfDocument()`, opens PDFs. pdf.js moved to `lib/pdfjs-6.4.299/` with every path built from `PDFJS_DIR` in `lib/pdf-loader.mjs`, so the main file and the worker can never come from different releases (an old main file with a new worker hangs with "Unknown action from worker: test"; seen in the sibling app Ledger). The service worker's pre-cache now fetches with `cache: "reload"`. The pdf.js 6.4.299 legacy files themselves are unchanged. `CACHE_VERSION` 16 → 17, `APP_VERSION` `'v17'`. No change to stored data.
- **v16** — Data-safety release after a full review (`tax-tracker-security-review` in the project notes). **Change Passcode** and **Import** are now all-or-nothing (everything is encrypted in memory first, then written in one database transaction). Import validates the whole file first (types, ranges, ids, attachments, sizes), shows what it contains, and a bad file changes nothing. A passcode change in one window locks other open windows (and a stale window can never write). Unreadable items are skipped with a warning instead of freezing the app. Database errors (for example a full device) are reported and the form keeps what you typed. Locking now closes the attachment viewer, empties the screen and clears passcode fields; the app also locks when it comes back after being hidden longer than the idle limit. Imported and stored values can no longer inject markup. Attachments are checked on upload, import and open (only PDF or image types keep their type; other files download as plain files). Backup export uses a Blob download. `iterations` read from a file or the vault is range-checked. **pdf.js 6.4.299 (legacy build)** with `isEvalSupported: false`; PDFs now open in browsers older than Chrome 145 too. COOP / CORP headers added in `_headers`. Persistent storage is requested. **The passcode minimum is unchanged: 6 characters (the numpad is kept).**
- **v15** — Service worker and `start_url` hardened for Cloudflare Pages (see "Service worker and redirects"); README brought in line with the code (features, structure, stray line removed, this log).
- **v14** — Big numpad on the set-passcode and unlock screens, with a switch back to the normal keyboard.
- **v13** — pdf.js 4.10.38 -> 6.2.108 (routine, not CVE-driven).
- **v12** — pdf.js 3.11.174 -> 4.10.38 (CVE-2024-4367) with `lib/pdf-loader.mjs`; idle auto-lock; `autocomplete` on all password fields.
- **v11** — `_headers` (real CSP with `frame-ancestors`, other security headers); README checksum table for the vendored pdf.js files.
- **v10** — Back button / gesture closes the open layer (history stack); Escape does the same.
- **v9** — pdf.js self-hosted under `lib/`; CSP `script-src` / `worker-src` `'self'` only.
- **v8** — Fixed PDF attachments not opening (a placeholder `integrity` hash blocked pdf.js).
- **v7** — Singapore pass status with From / Till dates, "Status & Date Renewal" on the member card, 12-month reminder banner.
- **v6** — Icons, manifest and README merged; `CACHE_VERSION` and `APP_VERSION` kept equal; `standalone/` references removed.
- **v5** — Attachments (image / PDF) with an in-app viewer, export scope (all members or one), version badge, IRAS note field; birth year no longer lost on re-import.
- **v2 - v4** — Inline handlers removed, strict CSP; the first hash-based CSP was wrong and was corrected.
- **v1** — PWA packaging (manifest, service worker, icons).

## License

Add a license of your choice here before publishing (e.g. MIT).
