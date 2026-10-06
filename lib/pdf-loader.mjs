// Tiny ES-module shim so the rest of the app (app.js, a classic non-module
// script) can keep using the global `window.pdfjsLib` the same way it did
// with the old UMD build. pdfjs-dist stopped shipping a classic/UMD build
// from v4 onward (ESM-only), so this file is the bridge: it's the only
// module-type script in the app, loaded via <script type="module"> in
// index.html, and its sole job is re-exposing the imported module as a
// global. Nothing else about the CSP or script model changes — this file
// is still served from 'self', same as every other script here.
//
// v17: pdf.js lives in a folder whose name carries the version, and EVERY
// path to it (the main file imported below, the worker, the wasm/ image
// decoders) is built from the one constant here. The main file and the worker
// MUST be the same release: an old main file (6.2.108) with a new worker
// (6.4.299) never gets an answer ("Unknown action from worker: test") and the
// viewer hangs on "Loading…". With fixed file names, a browser/service-worker
// cache can hand out one old and one new file during an update; version-named
// paths can never be mixed that way. To update pdf.js: put the new release's
// LEGACY build/ files + wasm/ folder in a NEW lib/pdfjs-<version>/ folder, then
// change only PDFJS_DIR here and the ./lib/pdfjs-… lines in sw.js.
const PDFJS_DIR = 'pdfjs-6.4.299/';   // relative to THIS file (lib/)
const pdfjsLib = await import('./' + PDFJS_DIR + 'pdf.min.mjs');
window.pdfjsLib = pdfjsLib;
// Absolute URLs (resolved against this module, so they do not depend on the
// page's own URL); app.js reads them when a PDF is opened.
window.PDFJS_WORKER_SRC = new URL(PDFJS_DIR + 'pdf.worker.min.mjs', import.meta.url).href;
window.PDFJS_WASM_URL = new URL(PDFJS_DIR + 'wasm/', import.meta.url).href;
