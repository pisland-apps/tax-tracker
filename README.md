# Tax Record & Income Tracker

Local-only, passcode-encrypted (AES-GCM + PBKDF2) tracker for Malaysia
(LHDN) and Singapore (IRAS) tax records, per household member. All data
lives in the browser's IndexedDB — nothing is sent anywhere.

## Files

- `index.html` — markup, CSS, and the CSP `<meta>` tag.
- `app.js` — all app logic (loaded as an external script so `script-src`
  can stay free of `'unsafe-inline'`).
- `sw.js` — Service Worker; caches the app shell for offline use.

## Deploy checklist

Every time `app.js` or `index.html` changes, before shipping:

1. **Bump `CACHE_VERSION` in `sw.js` by 1.** This is what makes returning
   visitors' browsers fetch the new files instead of serving a stale
   cached copy — bumping it is the *only* thing that matters for cache
   busting.
2. **Bump `APP_VERSION` (and `APP_VERSION_DATE`) in `app.js`.** This is a
   separate, purely cosmetic label shown in the small version badge in
   the bottom-right corner (visible even on the lock screen). It does
   **not** drive cache invalidation — `CACHE_VERSION` does that — so the
   two numbers don't have to match each other, they just both need to be
   bumped together so the badge you see after deploying tells you
   whether the deploy actually landed.
3. If a version badge after deploying doesn't match what you expect,
   that's a signal to hard-refresh (Ctrl/Cmd+Shift+R) or clear the site's
   Service Worker/cache in devtools — not that the deploy failed.
4. If you touched anything under `Content-Security-Policy` in
   `index.html` (e.g. adding a new CDN script), replace the pdf.js
   `integrity="sha384-PLACEHOLDER..."` / any other placeholder hashes with
   the real ones before deploying:
   ```
   curl -s <script-url> | openssl dgst -sha384 -binary | openssl base64 -A
   ```
   and cross-check against the hash the CDN itself publishes.

## Known limitation — per-member export + import

Export → "Export Scope" lets you export all members or just one. Import
always **replaces the entire local database** (it asks for confirmation
first) — importing a single-member backup will wipe out any other
members currently stored on this device, not merge alongside them. Use
per-member export for taking a focused backup or handing data to that
person, not as a way to selectively restore one member into a database
that already has others.
