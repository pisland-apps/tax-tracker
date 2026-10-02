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
  pdf-loader.mjs     <- small module shim: exposes pdf.js as window.pdfjsLib
  pdf.min.mjs        <- pdf.js (vendored, see the deploy checklist)
  pdf.worker.min.mjs <- pdf.js worker (vendored)
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
   `CACHE_VERSION = 15` in `sw.js` ↔ `APP_VERSION = 'v15'` in `app.js`. This
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
