// Tiny ES-module shim so the rest of the app (app.js, a classic non-module
// script) can keep using the global `window.pdfjsLib` the same way it did
// with the old UMD build. pdfjs-dist stopped shipping a classic/UMD build
// from v4 onward (ESM-only), so this file is the bridge: it's the only
// module-type script in the app, loaded via <script type="module"> in
// index.html, and its sole job is re-exposing the imported module as a
// global. Nothing else about the CSP or script model changes — this file
// is still served from 'self', same as every other script here.
import * as pdfjsLib from './pdf.min.mjs';
window.pdfjsLib = pdfjsLib;
