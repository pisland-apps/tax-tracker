  // ============================================================
  // App Version (display-only label for the small version badge in the
  // bottom-right corner — visible even on the lock screen before the
  // passcode is entered, so a stale cached build is obvious at a glance).
  //
  // Kept numerically IN SYNC with CACHE_VERSION in sw.js on purpose —
  // they live in different files and don't sync automatically, so bump
  // BOTH to the same number by hand on every deploy that touches app.js
  // or index.html. See the matching reminder comment in sw.js.
  //
  // If the badge you see after deploying doesn't match this value, that's
  // the signal to hard-refresh (Ctrl/Cmd+Shift+R) or clear the site's
  // Service Worker/cache in devtools — it means the browser is still
  // running an old cached build, not that the deploy failed.
  // ============================================================
  const APP_VERSION = 'v16';
  const APP_VERSION_DATE = '2026-10-04';

  (function initVersionBadge() {
    const el = document.getElementById('versionBadge');
    if (el) el.textContent = `${APP_VERSION} · ${APP_VERSION_DATE}`;
  })();

  // pdf.js — vendored locally at ./lib/pdf.min.mjs + ./lib/pdf.worker.min.mjs
  // (loaded via the ./lib/pdf-loader.mjs module shim in index.html, which
  // assigns the import to window.pdfjsLib). Used by the in-app attachment
  // viewer to render PDFs onto <canvas> instead of relying on the browser's
  // own PDF handling (which can silently download instead of preview, or
  // render blank in an iframe).
  //
  // NOTE: unlike the old UMD build, the module shim loads as a deferred
  // <script type="module">, which runs *after* this classic script — so
  // window.pdfjsLib is NOT guaranteed to exist yet at this point in app.js.
  // Don't read it here at parse time. ensurePdfWorkerConfigured() below is
  // called lazily, right before pdf.js is actually used (when a user opens
  // a PDF attachment), by which point the module has long since loaded.
  function ensurePdfWorkerConfigured() {
    if (!window.pdfjsLib) return false;
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.mjs';
    }
    return true;
  }

  // ============================================================
  // IndexedDB Setup
  // ============================================================
  const DB_NAME = 'TaxRecordsMultiMemberDB';
  const DB_VERSION = 3;
  const STORE_RECORDS = 'records';
  const STORE_MEMBERS = 'members';
  const STORE_IRAS_RECORDS = 'iras_records';
  const STORE_VAULT = 'vault_meta';
  let db = null;
  let currentMemberId = null;   // set whenever a Ledger is opened
  let ledgerMemberId = null;
  let ledgerType = null;        // 'lhdn' | 'iras'
  let currentMemberBirthYear = null; // cached for the open Ledger's Age column

  // ============================================================
  // Idle Auto-Lock
  // ============================================================
  // Clears vaultKey (via lockApp) after N minutes of no mouse/keyboard/touch
  // activity, so an unlocked session left open on a shared or mobile device
  // doesn't sit decrypted indefinitely. The chosen value is persisted in
  // vault meta (unencrypted — it's a UI preference, not sensitive data) so
  // it survives reloads. 0 disables it.
  const DEFAULT_IDLE_LOCK_MINUTES = 15;
  let idleLockMinutes = DEFAULT_IDLE_LOCK_MINUTES;
  let idleTimer = null;
  let lastActivityAt = Date.now();

  function resetIdleTimer() {
    lastActivityAt = Date.now();
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!vaultKey || !idleLockMinutes) return; // locked, or auto-lock set to "Never"
    idleTimer = setTimeout(() => {
      lockApp();
    }, idleLockMinutes * 60 * 1000);
  }

  function stopIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  // Registered once, unconditionally — resetIdleTimer() itself is a no-op
  // while locked (vaultKey is null), so this is safe to listen for even
  // before setup/unlock, and cheap since it only ever clears+sets a timeout.
  ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(evt => {
    window.addEventListener(evt, resetIdleTimer, { passive: true });
  });

  // Browsers pause timers for a page that is in the background (phones do it
  // aggressively), so a plain timeout may not have fired while the app was
  // hidden. When the page becomes visible again, check the clock instead.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && vaultKey && idleLockMinutes &&
        Date.now() - lastActivityAt >= idleLockMinutes * 60 * 1000) {
      lockApp();
    }
  });

  function showFatalError(msg) {
    const el = document.getElementById('appErrorBanner');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const dbInstance = e.target.result;
        if (!dbInstance.objectStoreNames.contains(STORE_RECORDS)) {
          const recStore = dbInstance.createObjectStore(STORE_RECORDS, { keyPath: 'id', autoIncrement: true });
          recStore.createIndex('memberId', 'memberId', { unique: false });
        }
        if (!dbInstance.objectStoreNames.contains(STORE_MEMBERS)) {
          dbInstance.createObjectStore(STORE_MEMBERS, { keyPath: 'id', autoIncrement: true });
        }
        if (!dbInstance.objectStoreNames.contains(STORE_IRAS_RECORDS)) {
          const irasStore = dbInstance.createObjectStore(STORE_IRAS_RECORDS, { keyPath: 'id', autoIncrement: true });
          irasStore.createIndex('memberId', 'memberId', { unique: false });
        }
        if (!dbInstance.objectStoreNames.contains(STORE_VAULT)) {
          dbInstance.createObjectStore(STORE_VAULT, { keyPath: 'id' });
        }
      };

      request.onblocked = () => {
        reject(new Error('Database upgrade is blocked by another open tab of this app. Please close any other tabs/windows with this tracker open, then reload this page.'));
      };

      request.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };

      request.onerror = (e) => reject(e.target.error || new Error('Failed to open the local database.'));
    });
  }

  // ============================================================
  // Encryption: PBKDF2 (key derivation) + AES-GCM (data encryption)
  // via the Web Crypto API. The derived key lives only in memory
  // (`vaultKey`) for the current unlocked session — it is never
  // persisted anywhere. Every table's payload is encrypted before
  // being written to IndexedDB and decrypted after being read back.
  // ============================================================
  const PBKDF2_ITERATIONS = 600000;
  const VAULT_CHECK_STRING = 'tax-tracker-vault-ok';
  let vaultKey = null; // CryptoKey, set only after a successful unlock/setup; cleared on Lock

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function b64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function deriveKeyFromPasscode(passcode, saltB64, iterations = PBKDF2_ITERATIONS) {
    const salt = b64ToBuf(saltB64);
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptObject(obj, key = vaultKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return { iv: bufToB64(iv), ct: bufToB64(ctBuf) };
  }

  // Throws if the key is wrong (AES-GCM authentication tag check fails) —
  // callers use this to distinguish "wrong passcode" from real errors.
  async function decryptObject(encData, key = vaultKey) {
    const iv = new Uint8Array(b64ToBuf(encData.iv));
    const ctBuf = b64ToBuf(encData.ct);
    const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctBuf);
    return JSON.parse(new TextDecoder().decode(ptBuf));
  }

  // ------------------------------------------------------------
  // IndexedDB promise helpers (v16).
  // Every request / transaction now SETTLES: it resolves on success and
  // REJECTS on error or abort. Before v16 the helpers only listened for
  // success, so a failed write (full disk, aborted transaction ...) left
  // the caller waiting forever and the form looked frozen. Writes now
  // resolve on the transaction's `complete` event (data really committed).
  // ------------------------------------------------------------
  function wrapDbError(err, fallbackMsg) {
    const e = new Error((err && err.message) ? err.message : fallbackMsg);
    e.name = (err && err.name) ? err.name : 'DatabaseError';
    e.isDb = true;
    return e;
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(wrapDbError(req.error, 'Database request failed'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(wrapDbError(tx.error, 'Database transaction failed'));
      tx.onabort = () => reject(wrapDbError(tx.error, 'Database transaction was cancelled'));
    });
  }

  function describeDbError(err) {
    if (err && err.isStale) return err.message;
    if (err && err.name === 'QuotaExceededError') {
      return 'Not enough storage space on this device, so your change was NOT saved.\n\nFree some space (for example export a backup, then delete large attachments or old records) and try again.';
    }
    return 'Could not save to the local database, so your change was NOT saved.\n\n(' + ((err && err.message) ? err.message : 'unknown error') + ')';
  }

  // Safety net for anything that still rejects: tell the person instead of
  // failing silently. Only database errors and "locked" cases are special.
  function reportProblem(err) {
    if (!err || err.__reported) return;
    if (err.message === 'Locked') return;           // a timer fired after locking: nothing to say
    if (err.isStale) { err.__reported = true; return; } // the lock screen already explains it
    if (err.isDb) { err.__reported = true; alert(describeDbError(err)); }
  }
  window.addEventListener('unhandledrejection', (e) => { reportProblem(e.reason); });

  function randomHex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Each window keeps its own copy of the key. `epoch` (stored in the vault
  // record, replaced whenever the passcode changes) lets a window notice that
  // its key is out of date BEFORE it writes anything encrypted with it.
  let sessionEpoch = null;
  const syncChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('tax-tracker-session') : null;
  if (syncChannel) {
    syncChannel.onmessage = (e) => {
      if (e.data && e.data.type === 'passcode-changed' && vaultKey) {
        lockApp('The passcode was changed in another window of this app. Unlock again with the new passcode.');
      }
    };
  }

  async function ensureSessionCurrent() {
    if (!vaultKey) throw new Error('Locked');
    const meta = await getVaultMeta();
    if (!meta || (meta.epoch || '') !== (sessionEpoch || '')) {
      const err = new Error('The passcode was changed in another window of this app. Unlock again with the new passcode.');
      err.isStale = true;
      lockApp(err.message);
      throw err;
    }
  }

  async function getVaultMeta() {
    const tx = db.transaction(STORE_VAULT, 'readonly');
    const result = await reqToPromise(tx.objectStore(STORE_VAULT).get('vault'));
    return result || null;
  }

  async function saveVaultMeta(meta) {
    const tx = db.transaction(STORE_VAULT, 'readwrite');
    const done = txDone(tx);
    tx.objectStore(STORE_VAULT).put({ id: 'vault', ...meta });
    await done;
  }

  // Read-modify-write of the vault record inside ONE transaction, so a
  // preference change can never overwrite a salt / check value / epoch that
  // another window changed in between.
  async function patchVaultMeta(patch) {
    const tx = db.transaction(STORE_VAULT, 'readwrite');
    const done = txDone(tx);
    const store = tx.objectStore(STORE_VAULT);
    const cur = await reqToPromise(store.get('vault'));
    if (!cur) { tx.abort(); try { await done; } catch (e) { /* nothing to patch */ } return; }
    store.put({ ...cur, ...patch });
    await done;
  }

  async function saveIdleLockMinutes(minutes) {
    await patchVaultMeta({ idleLockMinutes: minutes });
  }

  // The stored iteration count is read from the database (and from backup
  // files): refuse absurd values instead of freezing the tab on them.
  const MIN_PBKDF2_ITERATIONS = 100000;
  const MAX_PBKDF2_ITERATIONS = 5000000;
  function safeIterations(n) {
    if (n === undefined || n === null) return PBKDF2_ITERATIONS;   // old records without the field
    return (Number.isInteger(n) && n >= MIN_PBKDF2_ITERATIONS && n <= MAX_PBKDF2_ITERATIONS) ? n : null;
  }

  // Returns the derived CryptoKey if the passcode is correct, or null if not.
  async function verifyPasscode(passcode, meta) {
    try {
      const iterations = safeIterations(meta.iterations);
      if (iterations === null) return null;
      const key = await deriveKeyFromPasscode(passcode, meta.salt, iterations);
      const result = await decryptObject(meta.verify, key);
      return result === VAULT_CHECK_STRING ? key : null;
    } catch (e) {
      return null; // wrong passcode → AES-GCM auth tag check fails → decrypt throws
    }
  }

  // Raw (unencrypted-aware) helpers used only for the one-time legacy-data
  // migration below, where rows may or may not already be in {encData} form.
  function getAllRaw(storeName) {
    return reqToPromise(db.transaction(storeName, 'readonly').objectStore(storeName).getAll()).then(r => r || []);
  }

  async function putRaw(storeName, obj) {
    const tx = db.transaction(storeName, 'readwrite');
    const done = txDone(tx);
    tx.objectStore(storeName).put(obj);
    await done;
  }

  // One-time migration: encrypts any pre-existing plaintext rows (created
  // before this passcode/encryption feature existed) in place, using the
  // freshly-set-up vault key. Only runs during initial passcode setup.
  async function migrateLegacyDataToEncrypted() {
    const rawMembers = await getAllRaw(STORE_MEMBERS);
    for (const row of rawMembers) {
      if (!row.encData) {
        const { id, ...payload } = row;
        const encData = await encryptObject(payload);
        await putRaw(STORE_MEMBERS, { id, encData });
      }
    }

    const rawRecords = await getAllRaw(STORE_RECORDS);
    for (const row of rawRecords) {
      if (!row.encData) {
        const { id, memberId, ...payload } = row;
        const encData = await encryptObject(payload);
        await putRaw(STORE_RECORDS, { id, memberId, encData });
      }
    }

    const rawIras = await getAllRaw(STORE_IRAS_RECORDS);
    for (const row of rawIras) {
      if (!row.encData) {
        const { id, memberId, ...payload } = row;
        const encData = await encryptObject(payload);
        await putRaw(STORE_IRAS_RECORDS, { id, memberId, encData });
      }
    }
  }

  // ------------------------------------------------------------
  // Reading rows safely (v16).
  // A row that cannot be decrypted (damaged, or written under a different
  // key) is SKIPPED and counted instead of freezing every screen on
  // "Loading…". The count is shown in a banner so it is never silent.
  // Rows are also normalised to the shape the screens expect, so a record
  // from an old or hand-edited backup can no longer crash a ledger.
  // ------------------------------------------------------------
  const unreadableKeys = new Set();

  function updateDataWarning() {
    const el = document.getElementById('dataWarningBanner');
    if (!el) return;
    if (unreadableKeys.size === 0) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = '⚠️ ' + unreadableKeys.size + ' saved item' + (unreadableKeys.size === 1 ? '' : 's') +
      ' could not be read with this passcode (damaged, or saved under a different passcode) and ' +
      (unreadableKeys.size === 1 ? 'is' : 'are') + ' not shown. Everything else is shown normally. ' +
      'Do not change the passcode or import over this data until you have an export of what you can see, and keep any older backup.';
    el.style.display = 'block';
  }

  async function decryptRowsTolerant(storeName, rows, build) {
    const settled = await Promise.all(rows.map(async (row) => {
      try {
        let payload;
        if (row.encData) {
          payload = await decryptObject(row.encData);
        } else {                                    // an old plaintext row from before encryption existed
          const { id, memberId, ...rest } = row;
          payload = rest;
        }
        return build(row, payload);
      } catch (e) {
        unreadableKeys.add(storeName + ':' + row.id);
        return null;
      }
    }));
    updateDataWarning();
    return settled.filter(Boolean);
  }

  const PERMIT_CODES = ['WP', 'SP', 'EP', 'PR'];
  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function intOrNull(v) {
    const n = numOrNull(v);
    return n === null ? null : Math.trunc(n);
  }
  function dateOrNull(v) {
    return (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;
  }
  function textOrNull(v) {
    if (v === null || v === undefined) return null;
    return typeof v === 'string' ? v : String(v);
  }
  // Attachments are only checked lightly when rows are read (they can be
  // megabytes); the strict check runs on upload, on import and when opened.
  function lightAttachments(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(x => x && typeof x === 'object' && typeof x.data === 'string').map(x => ({
      name: (typeof x.name === 'string' && x.name) ? x.name : 'attachment',
      type: typeof x.type === 'string' ? x.type : '',
      data: x.data
    }));
  }

  function normalizeMember(m) {
    const t = (m.taxTypes && typeof m.taxTypes === 'object') ? m.taxTypes : null;
    const birth = intOrNull(m.birthYear);
    return {
      id: Number(m.id),
      name: (typeof m.name === 'string' && m.name.trim()) ? m.name : 'Unnamed',
      taxTypes: t ? { lhdn: !!t.lhdn, iras: !!t.iras } : { lhdn: true, iras: true },
      birthYear: (birth !== null && birth >= 1800 && birth <= 2200) ? birth : null,
      permitStatus: PERMIT_CODES.includes(m.permitStatus) ? m.permitStatus : null,
      permitFrom: dateOrNull(m.permitFrom),
      permitTill: dateOrNull(m.permitTill)
    };
  }

  function normalizeLhdnRecord(row, p) {
    const sources = Array.isArray(p.sources)
      ? p.sources.filter(s => s && typeof s === 'object').map(s => ({ name: textOrNull(s.name) || '', amount: numOrNull(s.amount) || 0 }))
      : [];
    const derived = sources.reduce((sum, s) => sum + s.amount, 0);
    const totalDerivedIncome = numOrNull(p.totalDerivedIncome);
    const incomeDeclared = numOrNull(p.incomeDeclared);
    const taxAmount = numOrNull(p.taxAmount);
    return {
      id: row.id,
      memberId: row.memberId,
      yearWorking: intOrNull(p.yearWorking) || 0,
      yearSubmit: intOrNull(p.yearSubmit),
      tahunTaksiran: intOrNull(p.tahunTaksiran),
      sources,
      totalDerivedIncome: totalDerivedIncome === null ? derived : totalDerivedIncome,
      incomeDeclared: incomeDeclared === null ? derived : incomeDeclared,
      incomeDeclaredManual: !!p.incomeDeclaredManual,
      incomeVsSourceDiff: numOrNull(p.incomeVsSourceDiff) || 0,
      taxAmount,
      incomeAfterTax: numOrNull(p.incomeAfterTax) === null ? ((incomeDeclared === null ? derived : incomeDeclared) - (taxAmount || 0)) : numOrNull(p.incomeAfterTax),
      lhdnYear: intOrNull(p.lhdnYear),
      lhdnAdjustedIncome: numOrNull(p.lhdnAdjustedIncome),
      lhdnAdjustedTax: numOrNull(p.lhdnAdjustedTax),
      attachments: lightAttachments(p.attachments)
    };
  }

  function normalizeIrasRecord(row, p) {
    return {
      id: row.id,
      memberId: row.memberId,
      yearWorking: intOrNull(p.yearWorking) || 0,
      yearSubmit: intOrNull(p.yearSubmit),
      noa: textOrNull(p.noa),
      noaIncome: numOrNull(p.noaIncome),
      taxPayment: numOrNull(p.taxPayment),
      note: textOrNull(p.note),
      attachments: lightAttachments(p.attachments)
    };
  }

  // ============================================================
  // Member DB Methods (encrypted at rest — name & taxTypes are inside encData;
  // only the numeric `id` primary key stays in the clear)
  // ============================================================
  async function getMembers() {
    const raw = await reqToPromise(db.transaction(STORE_MEMBERS, 'readonly').objectStore(STORE_MEMBERS).getAll());
    return decryptRowsTolerant(STORE_MEMBERS, raw || [], (row, payload) => normalizeMember({ id: row.id, ...payload }));
  }

  async function saveMember(name, taxTypes, birthYear) {
    await ensureSessionCurrent();
    const encData = await encryptObject({ name, taxTypes: taxTypes || { lhdn: true, iras: true }, birthYear: birthYear || null });
    const tx = db.transaction(STORE_MEMBERS, 'readwrite');
    const done = txDone(tx);
    const id = await reqToPromise(tx.objectStore(STORE_MEMBERS).add({ encData }));
    await done;
    return id;
  }

  async function updateMemberInDB(member) {
    await ensureSessionCurrent();
    const { id, ...payload } = member;
    const encData = await encryptObject(payload);
    const tx = db.transaction(STORE_MEMBERS, 'readwrite');
    const done = txDone(tx);
    const key = await reqToPromise(tx.objectStore(STORE_MEMBERS).put({ id, encData }));
    await done;
    return key;
  }

  async function deleteMemberFromDB(id) {
    await ensureSessionCurrent();
    const tx = db.transaction(STORE_MEMBERS, 'readwrite');
    const done = txDone(tx);
    tx.objectStore(STORE_MEMBERS).delete(id);
    await done;
  }

  // Members created before the LHDN/IRAS toggle existed default to both enabled.
  function memberTaxTypes(member) {
    return (member && member.taxTypes) ? member.taxTypes : { lhdn: true, iras: true };
  }

  // ------------------------------------------------------------
  // Singapore work-pass / permit status (WP / SP / EP / PR) — a
  // per-member attribute (not per tax-year record), since a permit
  // spans multiple filing years. Grouped with the IRAS side of the app
  // since it only applies to Singapore members.
  // ------------------------------------------------------------
  const PERMIT_LABELS = { WP: 'Work Permit (WP)', SP: 'S Pass (SP)', EP: 'Employment Pass (EP)', PR: 'Permanent Resident (PR)' };
  const PERMIT_RENEWAL_WINDOW_DAYS = 365; // "due start/before 12 months"

  function daysUntilDate(dateStr) {
    if (!dateStr) return null;
    const target = new Date(dateStr + 'T00:00:00');
    if (isNaN(target.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }

  function formatPermitDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return escapeHtml(dateStr);   // shown inside HTML: never raw
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ============================================================
  // LHDN Record DB Methods (encrypted at rest — id & memberId stay in the
  // clear so the memberId index keeps working; everything else is encrypted)
  // ============================================================
  async function getRecordsByMember(memberId) {
    const raw = await reqToPromise(db.transaction(STORE_RECORDS, 'readonly').objectStore(STORE_RECORDS).index('memberId').getAll(memberId));
    return decryptRowsTolerant(STORE_RECORDS, raw || [], normalizeLhdnRecord);
  }

  async function getAllRecords() {
    const raw = await reqToPromise(db.transaction(STORE_RECORDS, 'readonly').objectStore(STORE_RECORDS).getAll());
    return decryptRowsTolerant(STORE_RECORDS, raw || [], normalizeLhdnRecord);
  }

  async function saveRecordToDB(record) {
    await ensureSessionCurrent();
    const { id, memberId, ...payload } = record;
    const encData = await encryptObject(payload);
    const toStore = { memberId, encData };
    if (id !== undefined && id !== null) toStore.id = id;
    const tx = db.transaction(STORE_RECORDS, 'readwrite');
    const done = txDone(tx);
    const key = await reqToPromise(tx.objectStore(STORE_RECORDS).put(toStore));
    await done;
    return key;
  }

  async function deleteRecordFromDB(id) {
    await ensureSessionCurrent();
    const tx = db.transaction(STORE_RECORDS, 'readwrite');
    const done = txDone(tx);
    tx.objectStore(STORE_RECORDS).delete(id);
    await done;
  }

  // ============================================================
  // IRAS (Singapore) Record DB Methods (same encrypted-at-rest pattern)
  // ============================================================
  async function getIrasRecordsByMember(memberId) {
    const raw = await reqToPromise(db.transaction(STORE_IRAS_RECORDS, 'readonly').objectStore(STORE_IRAS_RECORDS).index('memberId').getAll(memberId));
    return decryptRowsTolerant(STORE_IRAS_RECORDS, raw || [], normalizeIrasRecord);
  }

  async function getAllIrasRecords() {
    const raw = await reqToPromise(db.transaction(STORE_IRAS_RECORDS, 'readonly').objectStore(STORE_IRAS_RECORDS).getAll());
    return decryptRowsTolerant(STORE_IRAS_RECORDS, raw || [], normalizeIrasRecord);
  }

  async function saveIrasRecordToDB(record) {
    await ensureSessionCurrent();
    const { id, memberId, ...payload } = record;
    const encData = await encryptObject(payload);
    const toStore = { memberId, encData };
    if (id !== undefined && id !== null) toStore.id = id;
    const tx = db.transaction(STORE_IRAS_RECORDS, 'readwrite');
    const done = txDone(tx);
    const key = await reqToPromise(tx.objectStore(STORE_IRAS_RECORDS).put(toStore));
    await done;
    return key;
  }

  async function deleteIrasRecordFromDB(id) {
    await ensureSessionCurrent();
    const tx = db.transaction(STORE_IRAS_RECORDS, 'readwrite');
    const done = txDone(tx);
    tx.objectStore(STORE_IRAS_RECORDS).delete(id);
    await done;
  }

  // Deleting a member and everything of theirs happens in ONE transaction,
  // by key (no decryption needed), so it is all-or-nothing.
  async function deleteMemberCascade(memberId) {
    await ensureSessionCurrent();
    const tx = db.transaction([STORE_RECORDS, STORE_IRAS_RECORDS, STORE_MEMBERS], 'readwrite');
    const done = txDone(tx);
    const recStore = tx.objectStore(STORE_RECORDS);
    const irasStore = tx.objectStore(STORE_IRAS_RECORDS);
    const recKeys = await reqToPromise(recStore.index('memberId').getAllKeys(memberId));
    const irasKeys = await reqToPromise(irasStore.index('memberId').getAllKeys(memberId));
    recKeys.forEach(k => recStore.delete(k));
    irasKeys.forEach(k => irasStore.delete(k));
    tx.objectStore(STORE_MEMBERS).delete(memberId);
    await done;
  }

  // All-or-nothing bulk write used by Change Passcode and Import.
  // The rows (and the new vault record, if any) are ALREADY encrypted in
  // memory; this only writes them, in one transaction. If anything fails
  // the transaction is aborted and the database is left exactly as it was.
  // It also re-checks the vault epoch inside the transaction, so a window
  // holding an out-of-date key can never overwrite newer data.
  async function commitBulk({ clearFirst, members, records, irasRecords, newMeta }) {
    const tx = db.transaction([STORE_MEMBERS, STORE_RECORDS, STORE_IRAS_RECORDS, STORE_VAULT], 'readwrite');
    const done = txDone(tx);
    let stale = false;
    try {
      const cur = await reqToPromise(tx.objectStore(STORE_VAULT).get('vault'));
      if (!cur || (cur.epoch || '') !== (sessionEpoch || '')) {
        stale = true;
        tx.abort();
      } else {
        const mStore = tx.objectStore(STORE_MEMBERS);
        const rStore = tx.objectStore(STORE_RECORDS);
        const iStore = tx.objectStore(STORE_IRAS_RECORDS);
        if (clearFirst) { mStore.clear(); rStore.clear(); iStore.clear(); }
        members.forEach(row => mStore.put(row));
        records.forEach(row => rStore.put(row));
        irasRecords.forEach(row => iStore.put(row));
        if (newMeta) tx.objectStore(STORE_VAULT).put({ id: 'vault', ...newMeta });
      }
    } catch (e) {
      try { tx.abort(); } catch (_) { /* already finished */ }
    }
    try {
      await done;
    } catch (e) {
      if (stale) {
        const se = new Error('The passcode was changed in another window of this app. Unlock again with the new passcode.');
        se.isStale = true;
        lockApp(se.message);
        throw se;
      }
      throw e;
    }
  }

  // ============================================================
  // Export / Import JSON (optionally encrypted with its own backup passcode,
  // independent of the app's own vault passcode — so a backup stays
  // importable even after the app passcode is later changed)
  // ============================================================
  let pendingImportPayload = null; // holds a parsed *encrypted* backup awaiting its passcode

  // ------------------------------------------------------------
  // Attachment checking (v16). Used when a file is attached, when a backup
  // is imported and when an attachment is opened. An attachment must be a
  // base64 data URL; its type is kept only if it is a PDF or an image, any
  // other type is stored as a plain download (application/octet-stream) so
  // that "Save a Copy" can never hand out something a browser would run;
  // the file name loses path separators and control characters.
  // ------------------------------------------------------------
  const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
  const MAX_ATTACHMENT_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 16;
  const SAFE_IMAGE_MIME = /^image\/[a-z0-9][a-z0-9.+-]{0,60}$/;
  const BASE64_BODY = /^[A-Za-z0-9+\/]*={0,2}$/;

  function safeFileName(name) {
    const n = (typeof name === 'string' ? name : '').replace(/[\u0000-\u001f\u007f\\\/:*?"<>|]+/g, '_').trim();
    return (n || 'attachment').slice(0, 200);
  }

  function normalizeAttachment(att, maxChars) {
    if (!att || typeof att !== 'object' || typeof att.data !== 'string') return null;
    const comma = att.data.indexOf(',');
    if (comma < 0) return null;
    const header = att.data.slice(0, comma);
    if (!/^data:[^;,]*(;[a-z0-9=._+-]+)*;base64$/i.test(header)) return null;
    const body = att.data.slice(comma + 1);
    if (maxChars && body.length > maxChars) return null;
    if (!BASE64_BODY.test(body)) return null;
    let mime = header.slice(5).split(';')[0].toLowerCase();
    if (!(mime === 'application/pdf' || SAFE_IMAGE_MIME.test(mime))) mime = 'application/octet-stream';
    return { name: safeFileName(att.name), type: mime, data: 'data:' + mime + ';base64,' + body };
  }

  // ------------------------------------------------------------
  // Backup validation (v16). A backup file is untrusted input: it is
  // checked completely BEFORE anything in the database is touched, and a
  // problem produces a plain message that says what is wrong. Values are
  // converted to the exact types the screens expect.
  // ------------------------------------------------------------
  const IMPORT_LIMITS = { members: 500, records: 50000, attachmentsPerRecord: 100 };
  const MAX_ID = 2147483647;

  function importFail(msg) { throw new Error(msg); }
  function importInt(v, min, max, label, required) {
    if (v === null || v === undefined || v === '') {
      if (required) importFail(label + ' is missing.');
      return null;
    }
    const n = (typeof v === 'number') ? v : ((typeof v === 'string' && /^-?\d+$/.test(v.trim())) ? parseInt(v, 10) : NaN);
    if (!Number.isInteger(n) || n < min || n > max) importFail(label + ' must be a whole number between ' + min + ' and ' + max + '.');
    return n;
  }
  function importNum(v, label) {
    if (v === null || v === undefined || v === '') return null;
    const n = (typeof v === 'number') ? v : ((typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
    if (!Number.isFinite(n) || Math.abs(n) > 1e12) importFail(label + ' must be a number.');
    return n;
  }
  function importText(v, max, label) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') importFail(label + ' must be text.');
    const t = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    if (t.length > max) importFail(label + ' is too long.');
    return t;
  }
  function importDate(v, label) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v + 'T00:00:00').getTime())) {
      importFail(label + ' must be a date like 2026-12-31.');
    }
    return v;
  }

  function validateBackup(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) importFail('The file does not look like a Tax Tracker backup.');
    if (!Array.isArray(d.members) || !Array.isArray(d.records)) importFail('The file does not look like a Tax Tracker backup (the member and record lists are missing).');
    const rawIras = (d.irasRecords === undefined || d.irasRecords === null) ? [] : d.irasRecords;
    if (!Array.isArray(rawIras)) importFail('The IRAS record list in the file is not a list.');
    if (d.members.length === 0) importFail('The file contains no members, so importing it would only erase your data.');
    if (d.members.length > IMPORT_LIMITS.members) importFail('The file has too many members (limit ' + IMPORT_LIMITS.members + ').');
    if (d.records.length > IMPORT_LIMITS.records || rawIras.length > IMPORT_LIMITS.records) importFail('The file has too many records (limit ' + IMPORT_LIMITS.records + ').');

    let attachmentCount = 0, skippedAttachments = 0, orphanCount = 0;

    const processAttachments = (list, where) => {
      if (list === undefined || list === null) return [];
      if (!Array.isArray(list)) importFail(where + ': attachments must be a list.');
      if (list.length > IMPORT_LIMITS.attachmentsPerRecord) importFail(where + ': too many attachments.');
      const out = [];
      for (const a of list) {
        const norm = normalizeAttachment(a, MAX_ATTACHMENT_CHARS);
        if (norm) { out.push(norm); attachmentCount++; } else { skippedAttachments++; }
      }
      return out;
    };

    const memberIds = new Set();
    const members = d.members.map((m, i) => {
      const where = 'Member #' + (i + 1);
      if (!m || typeof m !== 'object') importFail(where + ' is not valid.');
      const id = importInt(m.id, 1, MAX_ID, where + ': id', true);
      if (memberIds.has(id)) importFail(where + ': the id ' + id + ' appears twice.');
      memberIds.add(id);
      const name = (importText(m.name, 100, where + ': name') || '').trim();
      if (!name) importFail(where + ': the name is empty.');
      let taxTypes;
      if (m.taxTypes === undefined || m.taxTypes === null) {
        taxTypes = { lhdn: true, iras: true };
      } else {
        if (typeof m.taxTypes !== 'object') importFail(where + ': tax types are not valid.');
        taxTypes = { lhdn: m.taxTypes.lhdn === true, iras: m.taxTypes.iras === true };
        if (!taxTypes.lhdn && !taxTypes.iras) importFail(where + ': no tax type is enabled.');
      }
      let permitStatus = null;
      if (m.permitStatus !== undefined && m.permitStatus !== null && m.permitStatus !== '') {
        if (!PERMIT_CODES.includes(m.permitStatus)) importFail(where + ': the pass type must be WP, SP, EP or PR.');
        permitStatus = m.permitStatus;
      }
      return {
        id, name, taxTypes,
        birthYear: importInt(m.birthYear, 1800, 2200, where + ': birth year', false),
        permitStatus,
        permitFrom: importDate(m.permitFrom, where + ': pass start date'),
        permitTill: importDate(m.permitTill, where + ': pass end date')
      };
    });

    const recordIds = new Set();
    const records = [];
    d.records.forEach((r, i) => {
      const where = 'LHDN record #' + (i + 1);
      if (!r || typeof r !== 'object') importFail(where + ' is not valid.');
      const memberId = importInt(r.memberId, 1, MAX_ID, where + ': member', true);
      if (!memberIds.has(memberId)) { orphanCount++; return; }
      const id = importInt(r.id, 1, MAX_ID, where + ': id', false);
      if (id !== null) {
        if (recordIds.has(id)) importFail(where + ': the id ' + id + ' appears twice.');
        recordIds.add(id);
      }
      if (r.sources !== undefined && r.sources !== null && !Array.isArray(r.sources)) importFail(where + ': income sources must be a list.');
      const sources = (r.sources || []).map((src, j) => {
        if (!src || typeof src !== 'object') importFail(where + ': income source #' + (j + 1) + ' is not valid.');
        return { name: importText(src.name, 200, where + ': source name') || '', amount: importNum(src.amount, where + ': source amount') || 0 };
      });
      const derived = sources.reduce((sum, x) => sum + x.amount, 0);
      const totalDerivedIncome = importNum(r.totalDerivedIncome, where + ': derived income');
      const incomeDeclared = importNum(r.incomeDeclared, where + ': declared income');
      const taxAmount = importNum(r.taxAmount, where + ': tax amount');
      const declared = incomeDeclared === null ? derived : incomeDeclared;
      const incomeAfterTax = importNum(r.incomeAfterTax, where + ': income after tax');
      const incomeVsSourceDiff = importNum(r.incomeVsSourceDiff, where + ': income difference');
      const rec = {
        memberId,
        yearWorking: importInt(r.yearWorking, 1900, 2200, where + ': working year', true),
        yearSubmit: importInt(r.yearSubmit, 1900, 2200, where + ': submit year', false),
        tahunTaksiran: importInt(r.tahunTaksiran, 1900, 2200, where + ': Tahun Taksiran', false),
        sources,
        totalDerivedIncome: totalDerivedIncome === null ? derived : totalDerivedIncome,
        incomeDeclared: declared,
        incomeDeclaredManual: r.incomeDeclaredManual === true,
        incomeVsSourceDiff: incomeVsSourceDiff === null ? (declared - derived) : incomeVsSourceDiff,
        taxAmount,
        incomeAfterTax: incomeAfterTax === null ? (declared - (taxAmount || 0)) : incomeAfterTax,
        lhdnYear: importInt(r.lhdnYear, 1900, 2200, where + ': LHDN adjustment year', false),
        lhdnAdjustedIncome: importNum(r.lhdnAdjustedIncome, where + ': adjusted income'),
        lhdnAdjustedTax: importNum(r.lhdnAdjustedTax, where + ': adjusted tax'),
        attachments: processAttachments(r.attachments, where)
      };
      if (id !== null) rec.id = id;
      records.push(rec);
    });

    const irasIds = new Set();
    const irasRecords = [];
    rawIras.forEach((r, i) => {
      const where = 'IRAS record #' + (i + 1);
      if (!r || typeof r !== 'object') importFail(where + ' is not valid.');
      const memberId = importInt(r.memberId, 1, MAX_ID, where + ': member', true);
      if (!memberIds.has(memberId)) { orphanCount++; return; }
      const id = importInt(r.id, 1, MAX_ID, where + ': id', false);
      if (id !== null) {
        if (irasIds.has(id)) importFail(where + ': the id ' + id + ' appears twice.');
        irasIds.add(id);
      }
      const rec = {
        memberId,
        yearWorking: importInt(r.yearWorking, 1900, 2200, where + ': working year', true),
        yearSubmit: importInt(r.yearSubmit, 1900, 2200, where + ': submit year', false),
        noa: importText(r.noa, 100, where + ': NOA'),
        noaIncome: importNum(r.noaIncome, where + ': assessable income'),
        taxPayment: importNum(r.taxPayment, where + ': tax payment'),
        note: importText(r.note, 2000, where + ': note'),
        attachments: processAttachments(r.attachments, where)
      };
      if (id !== null) rec.id = id;
      irasRecords.push(rec);
    });

    const notes = [];
    if (orphanCount) notes.push('• ' + orphanCount + ' record(s) belong to a member that is not in the file and will be skipped.');
    if (skippedAttachments) notes.push('• ' + skippedAttachments + ' attachment(s) are damaged or unreadable and will be skipped.');
    return { members, records, irasRecords, attachmentCount, notes };
  }

  // Encrypts everything in memory first, then replaces the database in ONE
  // transaction: if anything fails, the existing data is left untouched.
  async function commitImport(clean) {
    await ensureSessionCurrent();
    const members = [];
    for (const m of clean.members) {
      const { id, ...payload } = m;
      members.push({ id, encData: await encryptObject(payload) });
    }
    const records = [];
    for (const r of clean.records) {
      const { id, memberId, ...payload } = r;
      const row = { memberId, encData: await encryptObject(payload) };
      if (id !== undefined) row.id = id;
      records.push(row);
    }
    const irasRecords = [];
    for (const r of clean.irasRecords) {
      const { id, memberId, ...payload } = r;
      const row = { memberId, encData: await encryptObject(payload) };
      if (id !== undefined) row.id = id;
      irasRecords.push(row);
    }
    await commitBulk({ clearFirst: true, members, records, irasRecords });
  }

  async function startImport(data) {
    const clean = validateBackup(data);               // throws a readable Error if the file is not usable
    const current = {
      members: (await getAllRaw(STORE_MEMBERS)).length,
      records: (await getAllRaw(STORE_RECORDS)).length,
      iras: (await getAllRaw(STORE_IRAS_RECORDS)).length
    };
    let msg = 'Replace ALL data in this app with the contents of this file?\n\n' +
      'In the file: ' + clean.members.length + ' member(s), ' + clean.records.length + ' LHDN record(s), ' +
      clean.irasRecords.length + ' IRAS record(s), ' + clean.attachmentCount + ' attachment(s).\n' +
      'In the app now: ' + current.members + ' member(s), ' + current.records + ' LHDN record(s), ' + current.iras + ' IRAS record(s).\n\n';
    if (clean.notes.length) msg += clean.notes.join('\n') + '\n\n';
    msg += 'Nothing is replaced unless the whole file imports successfully.';
    if (!confirm(msg)) return;

    await commitImport(clean);
    unreadableKeys.clear();
    updateDataWarning();
    alert('Import completed successfully!');
    // A full data reload resets straight to the home/Overview screen —
    // drop any tracked overlays rather than closing them one by one.
    navStack.length = 0;
    await backToOverview();
    await initApp();
  }

  function openExportModal() {
    document.getElementById('exportEncryptToggle').checked = true;
    document.getElementById('exportPasscode').value = '';
    document.getElementById('exportPasscodeConfirm').value = '';
    document.getElementById('exportError').style.display = 'none';
    populateExportMemberScope();
    updateExportModalView();
    document.getElementById('exportModal').classList.add('open');
    pushNavLayer('exportModal');
  }

  async function populateExportMemberScope() {
    const select = document.getElementById('exportMemberScope');
    const members = await getMembers();
    const prevValue = select.value || 'all';
    select.innerHTML = '<option value="all">All Members</option>' +
      members.map(m => `<option value="${safeId(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    // Preserve the previous selection if that member still exists, else fall back to "all".
    select.value = Array.from(select.options).some(o => o.value === prevValue) ? prevValue : 'all';
  }

  function closeExportModal() {
    document.getElementById('exportModal').classList.remove('open');
    document.getElementById('exportPasscode').value = '';
    document.getElementById('exportPasscodeConfirm').value = '';
  }

  function updateExportModalView() {
    const encrypt = document.getElementById('exportEncryptToggle').checked;
    document.getElementById('exportEncryptFields').style.display = encrypt ? 'block' : 'none';
    document.getElementById('exportPlainWarning').style.display = encrypt ? 'none' : 'block';
  }

  function showExportError(msg) {
    const el = document.getElementById('exportError');
    el.textContent = msg;
    el.style.display = 'block';
  }

  async function performExport() {
    const encrypt = document.getElementById('exportEncryptToggle').checked;
    document.getElementById('exportError').style.display = 'none';

    const exportBtn = document.getElementById('performExportBtn');
    const exportBtnLabel = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Preparing…';
    try {
      const scopeVal = document.getElementById('exportMemberScope').value;
      const scopeMemberId = scopeVal !== 'all' ? parseInt(scopeVal, 10) : null;

      let members = await getMembers();
      let records = await getAllRecords();
      let irasRecords = await getAllIrasRecords();

      let scopedMemberName = null;
      if (scopeMemberId !== null) {
        const scopedMember = members.find(m => m.id === scopeMemberId);
        scopedMemberName = scopedMember ? scopedMember.name : null;
        members = members.filter(m => m.id === scopeMemberId);
        records = records.filter(r => r.memberId === scopeMemberId);
        irasRecords = irasRecords.filter(r => r.memberId === scopeMemberId);
      }

      if (records.length === 0 && members.length === 0 && irasRecords.length === 0) {
        showExportError('No tax records found to export.');
        return;
      }

      let payload;

      if (encrypt) {
        const p1 = document.getElementById('exportPasscode').value;
        const p2 = document.getElementById('exportPasscodeConfirm').value;
        if (p1.length < 6) { showExportError('Backup passcode must be at least 6 characters.'); return; }
        if (p1 !== p2) { showExportError('Backup passcodes do not match.'); return; }

        const salt = bufToB64(crypto.getRandomValues(new Uint8Array(16)));
        const backupKey = await deriveKeyFromPasscode(p1, salt, PBKDF2_ITERATIONS);
        const enc = await encryptObject({ members, records, irasRecords }, backupKey);
        payload = { encrypted: true, iterations: PBKDF2_ITERATIONS, salt, iv: enc.iv, ct: enc.ct };
      } else {
        payload = { encrypted: false, members, records, irasRecords };
      }

      // A Blob download (not a giant data: URL): works for large backups with
      // attachments and does not build a second multi-megabyte string.
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement('a');

      const today = new Date().toISOString().split('T')[0];
      const scopeSlug = scopedMemberName ? '_' + scopedMemberName.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') : '';
      downloadAnchor.setAttribute('href', url);
      downloadAnchor.setAttribute('download', `tax_records_backup_${today}${scopeSlug}${encrypt ? '_encrypted' : ''}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      document.getElementById('exportPasscode').value = '';
      document.getElementById('exportPasscodeConfirm').value = '';
      requestCloseLayer('exportModal');
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = exportBtnLabel;
    }
  }

  async function importJSON(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => { alert('The file could not be read. Your data was not changed.'); };
    reader.onload = async (e) => {
      let importedData;
      try {
        importedData = JSON.parse(e.target.result);
      } catch (err) {
        alert('This file is not a valid backup: it cannot be read as JSON. Your data was not changed.');
        return;
      }
      try {
        if (importedData && importedData.encrypted === true) {
          if (typeof importedData.salt !== 'string' || typeof importedData.iv !== 'string' || typeof importedData.ct !== 'string' ||
              safeIterations(importedData.iterations) === null) {
            alert('This encrypted backup is damaged or uses unsupported settings. Your data was not changed.');
            return;
          }
          pendingImportPayload = importedData;
          document.getElementById('importBackupPasscode').value = '';
          document.getElementById('importPasscodeError').style.display = 'none';
          document.getElementById('importPasscodeModal').classList.add('open');
          pushNavLayer('importPasscodeModal');
          return;
        }
        await startImport(importedData);
      } catch (err) {
        alert('Import failed. Your existing data was not changed.\n\n' + (err && err.message ? err.message : 'Unknown error.'));
      }
    };

    reader.readAsText(file);
    event.target.value = '';
  }

  function closeImportPasscodeModal() {
    document.getElementById('importPasscodeModal').classList.remove('open');
    document.getElementById('importBackupPasscode').value = '';
    pendingImportPayload = null;
  }

  async function decryptAndImport() {
    const passcode = document.getElementById('importBackupPasscode').value;
    const errEl = document.getElementById('importPasscodeError');
    errEl.style.display = 'none';
    if (!pendingImportPayload) return;

    let decrypted;
    try {
      const key = await deriveKeyFromPasscode(passcode, pendingImportPayload.salt, safeIterations(pendingImportPayload.iterations));
      decrypted = await decryptObject({ iv: pendingImportPayload.iv, ct: pendingImportPayload.ct }, key);
    } catch (err) {
      errEl.textContent = 'Incorrect backup passcode, or corrupted file.';
      errEl.style.display = 'block';
      return;
    }

    document.getElementById('importBackupPasscode').value = '';
    requestCloseLayer('importPasscodeModal');
    try {
      await startImport(decrypted);
    } catch (err) {
      alert('Import failed. Your existing data was not changed.\n\n' + (err && err.message ? err.message : 'Unknown error.'));
    }
  }

  // ============================================================
  // Attachment Viewer (receipts / notices attached to a tax record,
  // stored as base64 data URLs inside the record's encrypted payload)
  // ------------------------------------------------------------
  // Deliberately does NOT navigate to the data: URL or embed it in an
  // iframe: navigating straight to a data: URL makes most browsers treat
  // it as a download rather than something to view, and iframes showing a
  // data: PDF render blank in some browsers (or get blocked outright by
  // the browser's own PDF-handling setting). Instead, PDFs are decoded
  // and rendered page-by-page onto <canvas> via pdf.js, and images are
  // shown via a Blob object URL. A "Save a Copy" link is kept separate so
  // the file can still be downloaded under its real name when that's what
  // someone actually wants.
  // ============================================================
  let avObjectUrls = []; // object URLs for the currently-open attachment — revoked on close/replace

  function dataURLtoUint8Array(dataUrl) {
    const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function dataURLtoBlob(dataUrl) {
    const header = dataUrl.substring(0, dataUrl.indexOf(','));
    const mimeMatch = header.match(/data:(.*?);base64/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    return new Blob([dataURLtoUint8Array(dataUrl)], { type: mime });
  }

  // pdf.js loading task of the open viewer (destroyed on close) and a counter
  // that lets a slow render notice the viewer was closed or replaced.
  let avPdfTask = null;
  let avSession = 0;

  function cleanupViewerResources() {
    avObjectUrls.forEach(url => URL.revokeObjectURL(url));
    avObjectUrls = [];
    if (avPdfTask) {
      const task = avPdfTask;
      avPdfTask = null;
      try { task.destroy(); } catch (e) { /* already gone */ }
    }
  }

  // att: { name, type, data } — data is the base64 data: URL as stored in the record
  async function openAttachmentViewer(rawAtt) {
    const session = ++avSession;
    cleanupViewerResources();

    const att = normalizeAttachment(rawAtt, MAX_ATTACHMENT_CHARS);   // never trust what is stored
    document.getElementById('avTitle').textContent = (rawAtt && typeof rawAtt.name === 'string' && rawAtt.name) ? rawAtt.name : 'Attachment';
    const saveBtn = document.getElementById('avSaveCopyBtn');
    const content = document.getElementById('avContent');

    if (!att) {
      saveBtn.removeAttribute('href');
      saveBtn.removeAttribute('download');
      content.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--danger);">This attachment is damaged or not in a supported format, so it cannot be previewed or saved.</div>';
      document.getElementById('attachmentViewerModal').classList.add('open');
      pushNavLayer('attachmentViewerModal');
      return;
    }

    saveBtn.setAttribute('download', att.name);
    saveBtn.href = att.data;

    content.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted);">Loading…</div>';
    document.getElementById('attachmentViewerModal').classList.add('open');
    pushNavLayer('attachmentViewerModal');

    const isImage = att.type.startsWith('image/');
    const isPdf = att.type === 'application/pdf' || /\.pdf$/i.test(att.name);

    try {
      if (isImage) {
        const blob = dataURLtoBlob(att.data);
        const url = URL.createObjectURL(blob);
        avObjectUrls.push(url);
        content.innerHTML = '';
        const img = document.createElement('img');
        img.src = url;
        img.style.maxWidth = '100%';
        img.style.borderRadius = 'var(--radius)';
        content.appendChild(img);
      } else if (isPdf) {
        if (!ensurePdfWorkerConfigured()) {
          content.innerHTML = '';
          content.textContent = 'PDF viewer failed to load. Try reloading the page.';
          return;
        }
        const bytes = dataURLtoUint8Array(att.data);
        const task = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false });
        avPdfTask = task;
        const pdf = await task.promise;
        if (session !== avSession) return;
        content.innerHTML = '';
        const containerWidth = content.clientWidth || 700;
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          if (session !== avSession) return;
          const unscaledViewport = page.getViewport({ scale: 1 });
          const scale = Math.max(0.1, (containerWidth - 20) / unscaledViewport.width);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.display = 'block';
          canvas.style.margin = '0 auto 12px';
          canvas.style.boxShadow = '0 1px 4px rgba(0,0,0,0.15)';
          content.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
        // Everything is drawn: release the document and the worker's copy of the bytes.
        if (avPdfTask === task) { avPdfTask = null; try { task.destroy(); } catch (e) { /* ignore */ } }
      } else {
        content.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted);">Preview not available for this file type — use "Save a Copy" to download it.</div>';
      }
    } catch (err) {
      if (session !== avSession) return;
      content.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--danger);">Could not preview this file: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function closeAttachmentViewer() {
    avSession++;                                  // lets a render that is still running stop
    document.getElementById('attachmentViewerModal').classList.remove('open');
    cleanupViewerResources();
    document.getElementById('avContent').innerHTML = '';
    document.getElementById('avSaveCopyBtn').removeAttribute('href');
  }

  // ------------------------------------------------------------
  // Attachment staging: shared by both the LHDN entry form and the IRAS
  // entry form. `kind` is 'lhdn' or 'iras' and selects which staging
  // buckets/DOM ids to use, so the same set of functions serves both
  // forms without duplicating the logic.
  // ------------------------------------------------------------
  const attachmentState = {
    lhdn: { pending: [], existing: [], removed: new Set() },
    iras: { pending: [], existing: [], removed: new Set() }
  };

  function attachmentPreviewElId(kind) { return kind === 'lhdn' ? 'lhdnAttachmentPreview' : 'irasAttachmentPreview'; }
  function attachmentInputElId(kind) { return kind === 'lhdn' ? 'lhdnAttachmentInput' : 'irasAttachmentInput'; }

  function handleAttachmentSelect(kind, event) {
    const files = Array.from(event.target.files || []);
    const state = attachmentState[kind];
    files.forEach(file => {
      if (file.size > MAX_ATTACHMENT_BYTES) { alert('Skipped "' + file.name + '" — over 8MB.'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const norm = normalizeAttachment({ name: file.name, type: file.type, data: reader.result }, MAX_ATTACHMENT_CHARS);
        if (!norm) { alert('Skipped "' + file.name + '" — it could not be read as a file.'); return; }
        state.pending.push(norm);
        renderAttachmentPreview(kind);
      };
      reader.onerror = () => { alert('Skipped "' + file.name + '" — it could not be read.'); };
      reader.readAsDataURL(file);
    });
    event.target.value = '';
  }

  function renderAttachmentPreview(kind) {
    const state = attachmentState[kind];
    const container = document.getElementById(attachmentPreviewElId(kind));
    if (!container) return;

    let html = '';
    state.existing.forEach((att, i) => {
      if (state.removed.has(i)) return;
      html += `<div class="attachment-chip">📎 <small>${escapeHtml(att.name || 'attachment')}</small> <button type="button" class="attachment-remove-btn" data-action="remove-existing-attachment" data-kind="${kind}" data-idx="${i}">Remove</button></div>`;
    });
    state.pending.forEach((att, i) => {
      html += `<div class="attachment-chip">📎 <small>${escapeHtml(att.name || 'attachment')}</small> <span style="color: var(--success); font-size: 0.75rem;">(new)</span> <button type="button" class="attachment-remove-btn" data-action="remove-pending-attachment" data-kind="${kind}" data-idx="${i}">Remove</button></div>`;
    });
    container.innerHTML = html || '<small style="color: var(--text-muted);">No attachments.</small>';
  }

  function removeExistingAttachment(kind, index) {
    attachmentState[kind].removed.add(index);
    renderAttachmentPreview(kind);
  }

  function removePendingAttachment(kind, index) {
    attachmentState[kind].pending.splice(index, 1);
    renderAttachmentPreview(kind);
  }

  function resetAttachmentState(kind) {
    attachmentState[kind] = { pending: [], existing: [], removed: new Set() };
    renderAttachmentPreview(kind);
  }

  function loadAttachmentStateForEdit(kind, attachments) {
    attachmentState[kind] = { pending: [], existing: Array.isArray(attachments) ? attachments : [], removed: new Set() };
    renderAttachmentPreview(kind);
  }

  // Merges the surviving existing attachments with the newly staged ones —
  // called at submit time to build the `attachments` array saved on the record.
  function collectAttachmentsForSave(kind) {
    const state = attachmentState[kind];
    const remainingExisting = state.existing.filter((att, i) => !state.removed.has(i));
    return [...remainingExisting, ...state.pending];
  }

  // Looks up an attachment by record + index (used from the records table,
  // where records are re-fetched fresh rather than kept around in memory)
  // and opens it in the shared viewer.
  async function openRecordAttachment(kind, recordId, index) {
    const records = kind === 'lhdn' ? await getRecordsByMember(currentMemberId) : await getIrasRecordsByMember(currentMemberId);
    const record = records.find(r => r.id === recordId);
    const att = record && Array.isArray(record.attachments) ? record.attachments[index] : null;
    if (!att) { alert('Attachment not found — it may have been removed.'); return; }
    openAttachmentViewer(att);
  }

  // ============================================================
  // Back-button navigation stack
  // ------------------------------------------------------------
  // On mobile/tablet, the hardware/gesture "back" action closes the
  // whole app unless the page has its own in-app history entries to
  // consume first. We push one history entry every time an overlay
  // opens (the Ledger view, any modal, or the attachment viewer), and
  // a `popstate` listener below closes whichever one is on top.
  //
  // Every in-app "Close / Cancel / Back to Overview" control — and
  // every place the code closes one of these layers on its own (e.g.
  // auto-closing the Export modal after a successful export) — routes
  // through requestCloseLayer() instead of calling the close function
  // directly. That keeps there being exactly one thing (the popstate
  // handler) that ever performs the actual close, so a tap on a Close
  // button and a hardware back press always behave identically and
  // never desync the history stack.
  // ============================================================
  const navStack = [];

  function pushNavLayer(name) {
    navStack.push(name);
    history.pushState({ appNavLayer: name }, '');
  }

  // Swaps the top layer for a new one without adding an extra history
  // entry — used when one overlay leads directly into another as a
  // single user action (e.g. the Quick Add modal handing off straight
  // to the Ledger view), so the back button only needs one press to
  // undo the whole action.
  function replaceNavLayer(oldName, newName) {
    const idx = navStack.lastIndexOf(oldName);
    if (idx !== -1) navStack[idx] = newName; else navStack.push(newName);
    history.replaceState({ appNavLayer: newName }, '');
  }

  // Call this to close a given layer — from a Close/Cancel button, or
  // from code that wants to auto-close it (e.g. after a successful
  // export). Goes through history.back() so the popstate handler below
  // performs the actual close exactly once.
  function requestCloseLayer(name) {
    if (navStack.length && navStack[navStack.length - 1] === name) {
      history.back();
    } else if (navStack.includes(name)) {
      // Not on top (shouldn't normally happen since overlays block
      // interaction with anything beneath them) — close it directly
      // rather than risk unwinding layers the user didn't ask to close.
      navStack.splice(navStack.lastIndexOf(name), 1);
      runCloseImpl(name);
    } else {
      // Wasn't tracked (e.g. already closed) — just make sure it's shut.
      runCloseImpl(name);
    }
  }

  function runCloseImpl(name) {
    switch (name) {
      case 'ledger': backToOverview(); break;
      case 'membersModal': closeMembersModal(); break;
      case 'quickAddModal': closeQuickAddModal(); break;
      case 'exportModal': closeExportModal(); break;
      case 'importPasscodeModal': closeImportPasscodeModal(); break;
      case 'changePasscodeModal': closeChangePasscodeModal(); break;
      case 'attachmentViewerModal': closeAttachmentViewer(); break;
    }
  }

  window.addEventListener('popstate', () => {
    const name = navStack.pop();
    if (name) runCloseImpl(name);
  });

  // Desktop-friendly equivalent: Escape closes whatever's on top, via
  // the same single path as the back button / Close buttons.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navStack.length) {
      requestCloseLayer(navStack[navStack.length - 1]);
    }
  });

  // ============================================================
  // DOM Elements
  // ============================================================
  const taxForm = document.getElementById('taxForm');
  const incomeSourcesContainer = document.getElementById('incomeSourcesContainer');
  const addSourceBtn = document.getElementById('addSourceBtn');
  const recordsTableBody = document.getElementById('recordsTableBody');
  const companyReportBody = document.getElementById('companyReportBody');
  const companyDatalist = document.getElementById('companyList');
  const editingBanner = document.getElementById('editingBanner');
  const editingYearText = document.getElementById('editingYearText');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const formTitle = document.getElementById('formTitle');
  const submitBtn = document.getElementById('submitBtn');
  const incomeDeclaredInput = document.getElementById('incomeDeclared');
  const incomeDeclaredDiff = document.getElementById('incomeDeclaredDiff');

  const irasForm = document.getElementById('irasForm');
  const irasTableBody = document.getElementById('irasTableBody');
  const editingIrasBanner = document.getElementById('editingIrasBanner');
  const editingIrasYearText = document.getElementById('editingIrasYearText');
  const cancelIrasEditBtn = document.getElementById('cancelIrasEditBtn');
  const irasFormTitle = document.getElementById('irasFormTitle');
  const irasSubmitBtn = document.getElementById('irasSubmitBtn');

  const overviewView = document.getElementById('overviewView');
  const ledgerView = document.getElementById('ledgerView');
  const overviewCardsGrid = document.getElementById('overviewCardsGrid');
  const ownerFilter = document.getElementById('ownerFilter');

  addSourceBtn.addEventListener('click', () => { addSourceRow(); updateIncomeDeclaredPreview(); });

  function sumSourceAmounts() {
    let total = 0;
    document.querySelectorAll('.source-amount').forEach(input => {
      total += parseFloat(input.value) || 0;
    });
    return total;
  }

  // Live preview: shows over/under-declared amount as soon as a manual
  // Income Declaration is keyed in that differs from the sum of income sources.
  function updateIncomeDeclaredPreview() {
    const raw = incomeDeclaredInput.value;
    const sourceTotal = sumSourceAmounts();

    if (raw === '') {
      incomeDeclaredDiff.style.display = 'none';
      incomeDeclaredDiff.textContent = '';
      return;
    }

    const declared = parseFloat(raw) || 0;
    const diff = declared - sourceTotal;

    if (Math.abs(diff) < 0.005) {
      incomeDeclaredDiff.style.display = 'none';
      incomeDeclaredDiff.textContent = '';
      return;
    }

    const label = diff > 0 ? 'Over-declared' : 'Under-declared';
    incomeDeclaredDiff.textContent = `${label} vs. income sources by ${formatCurrency(Math.abs(diff), 'MYR')}`;
    incomeDeclaredDiff.style.display = 'block';
  }

  incomeDeclaredInput.addEventListener('input', updateIncomeDeclaredPreview);
  incomeSourcesContainer.addEventListener('input', (e) => {
    if (e.target.classList.contains('source-amount')) updateIncomeDeclaredPreview();
  });

  function addSourceRow(name = '', amount = '') {
    const row = document.createElement('div');
    row.className = 'income-source-row';
    row.innerHTML = `
      <input type="text" list="companyList" placeholder="Company Name" class="source-name" value="${escapeHtml(name)}">
      <input type="number" step="0.01" placeholder="Amount (RM)" class="source-amount" value="${escapeHtml(amount)}">
      <button type="button" class="btn btn-secondary" data-action="remove-source-row">X</button>
    `;
    incomeSourcesContainer.appendChild(row);
  }

  function removeSourceRow(btn) {
    btn.parentElement.remove();
    updateIncomeDeclaredPreview();
  }

  // Basic HTML escaping to avoid broken markup / injection when names contain
  // special characters (<, >, quotes, etc.) since values are inserted via innerHTML.
  // Renders an optional free-text note as small text. If it looks like a
  // comma-separated list (contains a comma), each item becomes its own
  // bullet instead of one run-on line. Returns '' when there's no note,
  // so callers can just concatenate it in without an extra "if" of their own.
  function renderNoteHtml(note) {
    if (!note) return '';
    const trimmed = note.trim();
    if (!trimmed) return '';
    if (trimmed.includes(',')) {
      const items = trimmed.split(',').map(s => s.trim()).filter(Boolean);
      if (items.length > 1) {
        return '<ul class="note-list">' + items.map(i => `<li>${escapeHtml(i)}</li>`).join('') + '</ul>';
      }
    }
    return `<small class="note-text">${escapeHtml(trimmed)}</small>`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatCurrency(val, currency = 'MYR') {
    if (val === null || val === undefined || val === '') return '-';
    const n = Number(val);
    if (!Number.isFinite(n)) return '-';
    const prefix = currency === 'SGD' ? 'S$' : 'RM';
    return prefix + ' ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // For years / ids that end up inside HTML: always a plain number (or "-").
  function fmtYear(v) {
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? String(Math.trunc(n)) : '-';
  }
  function safeId(v) {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.trunc(n)) : '0';
  }

  // ============================================================
  // Lock / Unlock / Passcode Setup Flow
  // ============================================================
  function showLockError(msg) {
    const el = document.getElementById('lockError');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function clearLockError() {
    const el = document.getElementById('lockError');
    el.textContent = '';
    el.style.display = 'none';
  }

  function showLockScreen(mode) {
    document.getElementById('lockScreen').style.display = 'flex';
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('lockSetupView').style.display = mode === 'setup' ? 'block' : 'none';
    document.getElementById('lockUnlockView').style.display = mode === 'unlock' ? 'block' : 'none';
    clearLockError();
    document.getElementById('setupPasscode').value = '';
    document.getElementById('setupPasscodeConfirm').value = '';
    document.getElementById('unlockPasscode').value = '';
    resetNumpadState('setup');
    resetNumpadState('unlock');
    if (mode === 'unlock') {
      setTimeout(() => document.getElementById('unlockPasscode').focus(), 50);
    } else {
      setTimeout(() => document.getElementById('setupPasscode').focus(), 50);
    }
  }

  // ============================================================
  // Numeric keypad for passcode entry (mobile/tablet friendly).
  //
  // Each group ("setup" / "unlock") has its own big on-screen numpad next
  // to its passcode field(s). Tapping a numpad button writes straight into
  // the field's .value via JS — it never calls .focus() on the field — so
  // tapping the keypad can never summon the phone's native keyboard.
  // inputmode="none" on the fields themselves is a second line of defense
  // in case someone taps the text field directly.
  //
  // A "use keyboard instead" link lets anyone whose passcode contains
  // letters (existing passcodes weren't required to be numeric-only)
  // switch a group back to normal typing: it clears inputmode="none",
  // hides that group's numpad, and focuses the field so the real
  // keyboard appears on demand.
  // ============================================================
  const numpadGroups = {
    setup: { fields: ['setupPasscode', 'setupPasscodeConfirm'] },
    unlock: { fields: ['unlockPasscode'] }
  };
  const numpadState = {};

  function initNumpad(group) {
    const cfg = numpadGroups[group];
    const fieldEls = cfg.fields.map(id => document.getElementById(id));
    numpadState[group] = { activeField: fieldEls[0], keyboardMode: false };

    fieldEls.forEach(el => {
      el.addEventListener('focus', () => { numpadState[group].activeField = el; });
    });

    const numpadEl = document.querySelector(`.numpad[data-numpad-for="${group}"]`);
    numpadEl.querySelectorAll('.numpad-btn').forEach(btn => {
      // mousedown (not just click) so we can stop the browser from ever
      // trying to move focus to the button in a way that could bounce
      // focus/blur across the field and risk waking the keyboard.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        const target = numpadState[group].activeField;
        if (!target) return;
        if (btn.dataset.digit !== undefined) {
          target.value += btn.dataset.digit;
        } else if (btn.dataset.numpadAction === 'backspace') {
          target.value = target.value.slice(0, -1);
        } else if (btn.dataset.numpadAction === 'clear') {
          target.value = '';
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });

    const toggleBtn = document.querySelector(`[data-numpad-toggle="${group}"]`);
    toggleBtn.addEventListener('click', () => {
      const state = numpadState[group];
      state.keyboardMode = !state.keyboardMode;
      if (state.keyboardMode) {
        fieldEls.forEach(el => el.removeAttribute('inputmode'));
        numpadEl.style.display = 'none';
        toggleBtn.textContent = '🔢 Use numpad instead';
        (state.activeField || fieldEls[0]).focus();
      } else {
        fieldEls.forEach(el => el.setAttribute('inputmode', 'none'));
        numpadEl.style.display = '';
        toggleBtn.textContent = '⌨️ Use keyboard instead';
      }
    });
  }

  function resetNumpadState(group) {
    const cfg = numpadGroups[group];
    const state = numpadState[group];
    if (!cfg || !state) return;
    state.keyboardMode = false;
    state.activeField = document.getElementById(cfg.fields[0]);
    cfg.fields.forEach(id => document.getElementById(id).setAttribute('inputmode', 'none'));
    document.querySelector(`.numpad[data-numpad-for="${group}"]`).style.display = '';
    document.querySelector(`[data-numpad-toggle="${group}"]`).textContent = '⌨️ Use keyboard instead';
  }

  initNumpad('setup');
  initNumpad('unlock');

  function showApp() {
    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('appContainer').style.display = 'flex';
  }

  function clearPasscodeFields() {
    ['setupPasscode', 'setupPasscodeConfirm', 'unlockPasscode', 'currentPasscodeInput', 'newPasscodeInput',
     'newPasscodeConfirmInput', 'importBackupPasscode', 'exportPasscode', 'exportPasscodeConfirm'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  }

  async function handleSetupPasscode() {
    const p1 = document.getElementById('setupPasscode').value;
    const p2 = document.getElementById('setupPasscodeConfirm').value;
    clearLockError();

    if (p1.length < 6) { showLockError('Passcode must be at least 6 characters.'); return; }
    if (p1 !== p2) { showLockError('Passcodes do not match.'); return; }

    try {
      const salt = bufToB64(crypto.getRandomValues(new Uint8Array(16)));
      vaultKey = await deriveKeyFromPasscode(p1, salt, PBKDF2_ITERATIONS);
      const verify = await encryptObject(VAULT_CHECK_STRING);
      const epoch = randomHex(16);
      await saveVaultMeta({ salt, verify, iterations: PBKDF2_ITERATIONS, idleLockMinutes: DEFAULT_IDLE_LOCK_MINUTES, epoch });
      sessionEpoch = epoch;
      unreadableKeys.clear();

      // Encrypt any pre-existing plaintext data from before this feature existed.
      await migrateLegacyDataToEncrypted();

      clearPasscodeFields();
      showApp();
      await initApp();
    } catch (err) {
      console.error(err);
      vaultKey = null;
      sessionEpoch = null;
      showLockError('Failed to set up encryption. Please try again.');
    }
  }

  async function handleUnlock() {
    const passcode = document.getElementById('unlockPasscode').value;
    clearLockError();

    try {
      const meta = await getVaultMeta();
      if (!meta) { showLockError('No passcode has been set up yet.'); return; }

      const key = await verifyPasscode(passcode, meta);
      if (!key) { showLockError('Incorrect passcode. Please try again.'); return; }

      vaultKey = key;
      sessionEpoch = meta.epoch || '';
      unreadableKeys.clear();
      clearPasscodeFields();        // the passcode must not stay in the page while the app is open
      showApp();
      await initApp();
    } catch (err) {
      console.error(err);
      showLockError('Something went wrong while unlocking. Please try again.');
    }
  }

  // Empties everything that was decrypted for display, closes every open
  // layer and drops what is held in memory. The lock screen alone only covers
  // the page; this makes sure nothing readable is left underneath it.
  function clearSensitiveDom() {
    ['overviewCardsGrid', 'recordsTableBody', 'irasTableBody', 'companyReportBody', 'companyReportCards',
     'membersModalList', 'incomeSourcesContainer', 'companyList', 'lhdnAttachmentPreview', 'irasAttachmentPreview',
     'avContent'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    ['permitReminderBanner', 'dataWarningBanner'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.innerHTML = ''; el.style.display = 'none'; }
    });
    ['ledgerMemberName', 'summaryNetIncome', 'summaryTaxPaid', 'irasSummaryNetIncome', 'irasSummaryTotalIncome',
     'irasSummaryTaxPaid', 'irasSummaryYears', 'avTitle'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    });
    ownerFilter.innerHTML = '<option value="all">All Owners</option>';
    ['quickAddMember', 'exportMemberScope'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
  }

  function lockApp(message) {
    stopIdleTimer();
    vaultKey = null;
    sessionEpoch = null;
    currentMemberId = null;
    ledgerMemberId = null;
    ledgerType = null;
    currentMemberBirthYear = null;
    pendingImportPayload = null;
    unreadableKeys.clear();

    // Close every open layer (modals, attachment viewer) and forget the back-button stack.
    avSession++;
    cleanupViewerResources();
    navStack.length = 0;
    ['membersModal', 'quickAddModal', 'exportModal', 'importPasscodeModal', 'changePasscodeModal', 'attachmentViewerModal']
      .forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('open'); });
    const saveBtn = document.getElementById('avSaveCopyBtn');
    if (saveBtn) saveBtn.removeAttribute('href');

    // Unsaved form content and staged attachments.
    resetForm();
    resetIrasForm();
    collapseEntryForms();
    attachmentState.lhdn = { pending: [], existing: [], removed: new Set() };
    attachmentState.iras = { pending: [], existing: [], removed: new Set() };

    clearSensitiveDom();
    clearPasscodeFields();
    document.getElementById('ledgerView').style.display = 'none';
    document.getElementById('overviewView').style.display = 'block';
    showLockScreen('unlock');
    if (typeof message === 'string' && message) showLockError(message);
  }

  function openChangePasscodeModal() {
    document.getElementById('currentPasscodeInput').value = '';
    document.getElementById('newPasscodeInput').value = '';
    document.getElementById('newPasscodeConfirmInput').value = '';
    document.getElementById('changePasscodeError').style.display = 'none';
    document.getElementById('changePasscodeModal').classList.add('open');
    pushNavLayer('changePasscodeModal');
  }

  function closeChangePasscodeModal() {
    document.getElementById('changePasscodeModal').classList.remove('open');
    document.getElementById('currentPasscodeInput').value = '';
    document.getElementById('newPasscodeInput').value = '';
    document.getElementById('newPasscodeConfirmInput').value = '';
  }

  // Change Passcode is ALL-OR-NOTHING (v16). Everything is decrypted with the
  // old key and re-encrypted with the new key IN MEMORY first; only then are
  // all rows and the new vault record (new salt, check value, epoch) written
  // in ONE transaction. If anything goes wrong — including the tab being
  // closed half-way — the database still holds the old data under the old
  // passcode. The new key replaces the old one in memory only after commit.
  async function handleChangePasscode() {
    const current = document.getElementById('currentPasscodeInput').value;
    const next = document.getElementById('newPasscodeInput').value;
    const confirmNext = document.getElementById('newPasscodeConfirmInput').value;
    const errEl = document.getElementById('changePasscodeError');
    errEl.style.display = 'none';

    const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

    if (next.length < 6) { showErr('New passcode must be at least 6 characters.'); return; }
    if (next !== confirmNext) { showErr('New passcodes do not match.'); return; }

    const changeBtn = document.getElementById('changePasscodeBtn');
    changeBtn.disabled = true;
    changeBtn.textContent = 'Updating…';

    try {
      await ensureSessionCurrent();
      const meta = await getVaultMeta();
      const testKey = await verifyPasscode(current, meta);
      if (!testKey) { showErr('Current passcode is incorrect.'); return; }

      // Strictly decrypt every row under the old key. A row that cannot be
      // read would be lost by re-encrypting, so refuse to go on in that case.
      const readAll = async (storeName) => {
        const rows = await getAllRaw(storeName);
        const payloads = [];
        for (const row of rows) {
          let payload;
          try {
            if (row.encData) {
              payload = await decryptObject(row.encData);
            } else {
              const { id, memberId, ...rest } = row;
              payload = rest;
            }
          } catch (e) {
            const err = new Error('UNREADABLE');
            err.unreadable = true;
            throw err;
          }
          payloads.push({ row, payload });
        }
        return payloads;
      };
      let oldMembers, oldRecords, oldIras;
      try {
        oldMembers = await readAll(STORE_MEMBERS);
        oldRecords = await readAll(STORE_RECORDS);
        oldIras = await readAll(STORE_IRAS_RECORDS);
      } catch (e) {
        if (e.unreadable) {
          showErr('Some saved items cannot be read with the current passcode, so the passcode was NOT changed (changing it would make them unrecoverable). Export what you can see and keep your older backups first.');
          return;
        }
        throw e;
      }

      // Derive the new key and encrypt everything under it, in memory.
      const newSalt = bufToB64(crypto.getRandomValues(new Uint8Array(16)));
      const newKey = await deriveKeyFromPasscode(next, newSalt, PBKDF2_ITERATIONS);
      const newMembers = [];
      for (const { row, payload } of oldMembers) newMembers.push({ id: row.id, encData: await encryptObject(payload, newKey) });
      const newRecords = [];
      for (const { row, payload } of oldRecords) newRecords.push({ id: row.id, memberId: row.memberId, encData: await encryptObject(payload, newKey) });
      const newIras = [];
      for (const { row, payload } of oldIras) newIras.push({ id: row.id, memberId: row.memberId, encData: await encryptObject(payload, newKey) });
      const verify = await encryptObject(VAULT_CHECK_STRING, newKey);
      const newEpoch = randomHex(16);
      const newMeta = { salt: newSalt, verify, iterations: PBKDF2_ITERATIONS, idleLockMinutes: meta.idleLockMinutes, epoch: newEpoch };

      // Single transaction: rows + new vault record, or nothing.
      await commitBulk({ clearFirst: false, members: newMembers, records: newRecords, irasRecords: newIras, newMeta });

      vaultKey = newKey;
      sessionEpoch = newEpoch;
      if (syncChannel) syncChannel.postMessage({ type: 'passcode-changed' });

      document.getElementById('currentPasscodeInput').value = '';
      document.getElementById('newPasscodeInput').value = '';
      document.getElementById('newPasscodeConfirmInput').value = '';
      requestCloseLayer('changePasscodeModal');
      alert('Passcode updated successfully.');
    } catch (err) {
      if (err && err.isStale) return;            // the lock screen already explains it
      console.error(err);
      showErr('The passcode was NOT changed and your data is unchanged. ' + (err && err.name === 'QuotaExceededError' ? 'There is not enough free storage on this device.' : 'Please try again.'));
    } finally {
      changeBtn.disabled = false;
      changeBtn.textContent = 'Update Passcode';
    }
  }

  // ============================================================
  // App Init / Overview
  // ============================================================
  async function initApp() {
    let members = await getMembers();
    // Only a store that is really empty gets the two starter members; unreadable
    // rows must never be mistaken for "no members".
    if (members.length === 0 && (await getAllRaw(STORE_MEMBERS)).length === 0) {
      await saveMember("Husband", { lhdn: true, iras: true });
      await saveMember("Wife", { lhdn: true, iras: true });
    }
    await populateOwnerFilter();
    await renderOverviewCards();

    const meta = await getVaultMeta();
    idleLockMinutes = (meta && Number.isFinite(meta.idleLockMinutes))
      ? meta.idleLockMinutes
      : DEFAULT_IDLE_LOCK_MINUTES;
    const idleLockSelect = document.getElementById('idleLockSelect');
    if (idleLockSelect) idleLockSelect.value = String(idleLockMinutes);
    resetIdleTimer();

    // Ask the browser not to evict this data when the device runs low on space.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => { /* a refusal is not an error */ });
    }
  }

  async function handleIdleLockChange() {
    const select = document.getElementById('idleLockSelect');
    idleLockMinutes = parseInt(select.value, 10) || 0;
    await saveIdleLockMinutes(idleLockMinutes);
    resetIdleTimer();
  }

  async function populateOwnerFilter() {
    const members = await getMembers();
    const prevVal = ownerFilter.value || 'all';
    ownerFilter.innerHTML = `<option value="all">All Owners</option>` +
      members.map(m => `<option value="${safeId(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    ownerFilter.value = members.some(m => String(m.id) === prevVal) ? prevVal : 'all';
  }

  function computeLhdnTotals(records) {
    let netIncome = 0, taxPaid = 0, declaredIncome = 0;
    records.forEach(r => {
      const hasIncomeAdj = (r.lhdnAdjustedIncome !== null && r.lhdnAdjustedIncome !== undefined);
      const hasTaxAdj = (r.lhdnAdjustedTax !== null && r.lhdnAdjustedTax !== undefined);
      const effIncome = hasIncomeAdj ? r.lhdnAdjustedIncome : (r.incomeDeclared || 0);
      const effTax = hasTaxAdj ? r.lhdnAdjustedTax : (r.taxAmount || 0);

      netIncome += (effIncome - effTax);
      taxPaid += effTax;
      declaredIncome += effIncome;
    });
    return { netIncome, taxPaid, declaredIncome };
  }

  function computeIrasTotals(irasRecords) {
    let taxPaid = 0, totalIncome = 0;
    irasRecords.forEach(r => {
      taxPaid += (r.taxPayment || 0);
      totalIncome += (r.noaIncome || 0);
    });
    return { taxPaid, totalIncome, netIncome: totalIncome - taxPaid, count: irasRecords.length };
  }

  async function renderOverviewCards() {
    const members = await getMembers();
    const filterVal = ownerFilter.value || 'all';
    const filteredMembers = filterVal === 'all' ? members : members.filter(m => String(m.id) === filterVal);

    let cardsHtml = '';

    for (const m of filteredMembers) {
      const types = memberTaxTypes(m);

      if (types.lhdn) {
        const records = await getRecordsByMember(m.id);
        const totals = computeLhdnTotals(records);
        cardsHtml += `
          <div class="member-card lhdn-card" data-action="open-ledger" data-id="${safeId(m.id)}" data-type="lhdn">
            <div class="member-card-badge">LHDN · Malaysia</div>
            <div class="member-card-name">${escapeHtml(m.name)}</div>
            <div class="member-card-stats">
              <div>Total Income: <strong style="color: #1d4ed8;">${formatCurrency(totals.declaredIncome, 'MYR')}</strong></div>
              <div>Total Tax Paid: <strong style="color: var(--danger);">${formatCurrency(totals.taxPaid, 'MYR')}</strong></div>
              <div>Net Income: <strong style="color: var(--success);">${formatCurrency(totals.netIncome, 'MYR')}</strong></div>
            </div>
          </div>
        `;
      }

      if (types.iras) {
        const irasRecords = await getIrasRecordsByMember(m.id);
        const totals = computeIrasTotals(irasRecords);
        cardsHtml += `
          <div class="member-card iras-card" data-action="open-ledger" data-id="${safeId(m.id)}" data-type="iras">
            <div class="member-card-badge">IRAS · Singapore</div>
            <div class="member-card-name">${escapeHtml(m.name)}</div>
            ${renderPermitStatusLine(m)}
            <div class="member-card-stats">
              <div>Total Income: <strong style="color: #1d4ed8;">${formatCurrency(totals.totalIncome, 'SGD')}</strong></div>
              <div>Total Tax Paid: <strong style="color: var(--danger);">${formatCurrency(totals.taxPaid, 'SGD')}</strong></div>
              <div>Net Income: <strong style="color: var(--success);">${formatCurrency(totals.netIncome, 'SGD')}</strong></div>
            </div>
          </div>
        `;
      }
    }

    overviewCardsGrid.innerHTML = cardsHtml ||
      `<div class="empty-state">No members yet. Click "👥 Members" above to add one.</div>`;

    renderPermitReminderBanner(members);
  }

  // "Status & Date Renewal" line on an IRAS member card. Empty string
  // (no line rendered) when the member has no permit status set.
  function renderPermitStatusLine(member) {
    if (!member.permitStatus) return '';
    const days = daysUntilDate(member.permitTill);
    let colorStyle = 'color: var(--text-muted);';
    let dueText = '';
    if (days !== null) {
      if (days < 0) { colorStyle = 'color: var(--danger); font-weight: 700;'; dueText = ` — overdue by ${Math.abs(days)}d`; }
      else if (days <= PERMIT_RENEWAL_WINDOW_DAYS) { colorStyle = 'color: #b45309; font-weight: 700;'; dueText = ` — due in ${days}d`; }
    }
    const till = member.permitTill ? `renews ${formatPermitDate(member.permitTill)}` : 'no renewal date set';
    return `<div class="member-card-permit" style="${colorStyle}">🛂 ${escapeHtml(member.permitStatus)} · ${till}${dueText}</div>`;
  }

  // Top-of-page banner: any IRAS member whose permit is due for renewal
  // within PERMIT_RENEWAL_WINDOW_DAYS (or already overdue).
  function renderPermitReminderBanner(members) {
    const banner = document.getElementById('permitReminderBanner');
    if (!banner) return;

    const due = members
      .filter(m => m.permitStatus && m.permitTill)
      .map(m => ({ member: m, days: daysUntilDate(m.permitTill) }))
      .filter(x => x.days !== null && x.days <= PERMIT_RENEWAL_WINDOW_DAYS)
      .sort((a, b) => a.days - b.days);

    if (due.length === 0) {
      banner.style.display = 'none';
      banner.innerHTML = '';
      return;
    }

    const items = due.map(({ member, days }) => {
      const status = days < 0 ? `overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}` : `due in ${days} day${days === 1 ? '' : 's'}`;
      return `<li><strong>${escapeHtml(member.name)}</strong> — ${escapeHtml(PERMIT_LABELS[member.permitStatus] || member.permitStatus)} renews ${formatPermitDate(member.permitTill)} (${status})</li>`;
    }).join('');

    banner.innerHTML = `⚠️ <strong>Singapore permit renewal reminder</strong><ul>${items}</ul>`;
    banner.style.display = 'block';
  }

  // ============================================================
  // Ledger Navigation
  // ============================================================
  async function openLedger(memberId, type, opts = {}) {
    ledgerMemberId = memberId;
    ledgerType = type;
    currentMemberId = memberId;

    const cameFromOverview = ledgerView.style.display !== 'block';

    overviewView.style.display = 'none';
    ledgerView.style.display = 'block';

    if (opts.replaceNavFrom) {
      // Came here directly from another overlay (e.g. Quick Add) as one
      // user action — swap that layer for 'ledger' instead of stacking.
      replaceNavLayer(opts.replaceNavFrom, 'ledger');
    } else if (cameFromOverview) {
      pushNavLayer('ledger');
    }

    const members = await getMembers();
    const member = members.find(m => m.id === memberId);
    document.getElementById('ledgerMemberName').textContent = member ? member.name : '';
    currentMemberBirthYear = (member && member.birthYear) ? member.birthYear : null;

    const badge = document.getElementById('ledgerTypeBadge');
    if (type === 'lhdn') {
      badge.textContent = 'LHDN (Malaysia) · RM';
      badge.className = 'badge badge-lhdn';
    } else {
      badge.textContent = 'IRAS (Singapore) · S$';
      badge.className = 'badge badge-iras';
    }

    document.getElementById('ledgerLhdnContent').style.display = (type === 'lhdn') ? 'block' : 'none';
    document.getElementById('ledgerIrasContent').style.display = (type === 'iras') ? 'block' : 'none';

    resetForm();
    resetIrasForm();
    collapseEntryForms();

    await refreshApp();

    if (opts.autoExpandForm) {
      if (type === 'lhdn') toggleLhdnForm(true);
      else toggleIrasForm(true);
    }

    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  async function backToOverview() {
    ledgerView.style.display = 'none';
    overviewView.style.display = 'block';
    await populateOwnerFilter();
    await renderOverviewCards();
  }

  function toggleLhdnForm(forceOpen) {
    const wrapper = document.getElementById('lhdnFormWrapper');
    const isOpen = wrapper.style.display === 'block';
    const shouldOpen = forceOpen !== undefined ? forceOpen : !isOpen;
    wrapper.style.display = shouldOpen ? 'block' : 'none';
    document.getElementById('toggleLhdnFormBtn').textContent = shouldOpen ? '▲ Hide Entry Form' : '+ Add New Entry';
  }

  function toggleIrasForm(forceOpen) {
    const wrapper = document.getElementById('irasFormWrapper');
    const isOpen = wrapper.style.display === 'block';
    const shouldOpen = forceOpen !== undefined ? forceOpen : !isOpen;
    wrapper.style.display = shouldOpen ? 'block' : 'none';
    document.getElementById('toggleIrasFormBtn').textContent = shouldOpen ? '▲ Hide Entry Form' : '+ Add New Entry';
  }

  function collapseEntryForms() {
    document.getElementById('lhdnFormWrapper').style.display = 'none';
    document.getElementById('toggleLhdnFormBtn').textContent = '+ Add New Entry';
    document.getElementById('irasFormWrapper').style.display = 'none';
    document.getElementById('toggleIrasFormBtn').textContent = '+ Add New Entry';
  }

  function printCurrentView() {
    window.print();
  }

  // ============================================================
  // Members Modal
  // ============================================================
  async function openMembersModal() {
    await renderMembersModalList();
    document.getElementById('membersModal').classList.add('open');
    pushNavLayer('membersModal');
  }

  async function closeMembersModal() {
    document.getElementById('membersModal').classList.remove('open');
    await populateOwnerFilter();
    await renderOverviewCards();
  }

  async function renderMembersModalList() {
    const members = await getMembers();
    const listEl = document.getElementById('membersModalList');

    if (members.length === 0) {
      listEl.innerHTML = `<p style="color: var(--text-muted);">No members yet — add one below.</p>`;
      return;
    }

    listEl.innerHTML = members.map(m => {
      const t = memberTaxTypes(m);
      const permitOptions = ['', 'WP', 'SP', 'EP', 'PR'].map(code =>
        `<option value="${code}" ${((m.permitStatus || '') === code) ? 'selected' : ''}>${code || '— No Permit —'}</option>`
      ).join('');
      return `
        <div class="member-row">
          <input type="text" value="${escapeHtml(m.name)}" id="memberName_${safeId(m.id)}">
          <input type="number" value="${m.birthYear ? fmtYear(m.birthYear) : ''}" id="memberBirthYear_${safeId(m.id)}" placeholder="Birth year" style="width: 110px;">
          <label><input type="checkbox" id="memberLhdn_${safeId(m.id)}" ${t.lhdn ? 'checked' : ''}> LHDN</label>
          <label><input type="checkbox" id="memberIras_${safeId(m.id)}" ${t.iras ? 'checked' : ''}> IRAS</label>
          <button class="btn btn-secondary" data-action="save-member-edits" data-id="${safeId(m.id)}">Save</button>
          <button class="icon-btn delete" title="Delete Member" data-action="delete-member-entirely" data-id="${safeId(m.id)}">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
          <div class="member-row-permit">
            <label>🇸🇬 Permit
              <select id="memberPermitStatus_${safeId(m.id)}">${permitOptions}</select>
            </label>
            <label>From <input type="date" id="memberPermitFrom_${safeId(m.id)}" value="${escapeHtml(m.permitFrom || '')}"></label>
            <label>Till <input type="date" id="memberPermitTill_${safeId(m.id)}" value="${escapeHtml(m.permitTill || '')}"></label>
          </div>
        </div>
      `;
    }).join('');
  }

  async function saveMemberEdits(id) {
    const name = document.getElementById(`memberName_${id}`).value.trim();
    const birthYearVal = document.getElementById(`memberBirthYear_${id}`).value;
    const birthYear = birthYearVal !== '' ? parseInt(birthYearVal, 10) : null;
    const lhdn = document.getElementById(`memberLhdn_${id}`).checked;
    const iras = document.getElementById(`memberIras_${id}`).checked;
    const permitStatusVal = document.getElementById(`memberPermitStatus_${id}`).value;
    const permitStatus = permitStatusVal !== '' ? permitStatusVal : null;
    const permitFromVal = document.getElementById(`memberPermitFrom_${id}`).value;
    const permitTillVal = document.getElementById(`memberPermitTill_${id}`).value;
    const permitFrom = permitFromVal !== '' ? permitFromVal : null;
    const permitTill = permitTillVal !== '' ? permitTillVal : null;

    if (!name) { alert('Name cannot be empty.'); return; }
    if (!lhdn && !iras) { alert('Select at least one tax type: LHDN or IRAS.'); return; }

    await updateMemberInDB({ id, name, taxTypes: { lhdn, iras }, birthYear, permitStatus, permitFrom, permitTill });
    await renderMembersModalList();

    // If this member's Ledger is currently open, refresh the cached birth
    // year so any Age column updates immediately without needing to re-open.
    if (ledgerMemberId === id) {
      currentMemberBirthYear = birthYear;
      await refreshApp();
    }
  }

  async function deleteMemberEntirely(id) {
    const members = await getMembers();
    const member = members.find(m => m.id === id);
    const label = member ? member.name : 'this member';

    if (!confirm(`Delete "${label}" and ALL their LHDN & IRAS records? This cannot be undone.`)) return;

    await deleteMemberCascade(id);

    if (currentMemberId === id) currentMemberId = null;
    if (ledgerMemberId === id) {
      // Force-closing the Ledger here (its member no longer exists),
      // possibly while the Members modal is still open on top of it.
      // Just drop 'ledger' from our bookkeeping — its own history entry
      // is harmless to leave behind and will be skipped over silently.
      const idx = navStack.lastIndexOf('ledger');
      if (idx !== -1) navStack.splice(idx, 1);
      await backToOverview();
    }

    await renderMembersModalList();
    await populateOwnerFilter();
    await renderOverviewCards();
  }

  async function addMemberFromModal() {
    const name = document.getElementById('newMemberName').value.trim();
    const birthYearVal = document.getElementById('newMemberBirthYear').value;
    const birthYear = birthYearVal !== '' ? parseInt(birthYearVal, 10) : null;
    const lhdn = document.getElementById('newMemberLhdn').checked;
    const iras = document.getElementById('newMemberIras').checked;

    if (!name) { alert('Please enter a name.'); return; }
    if (!lhdn && !iras) { alert('Select at least one tax type: LHDN or IRAS.'); return; }

    await saveMember(name, { lhdn, iras }, birthYear);

    document.getElementById('newMemberName').value = '';
    document.getElementById('newMemberBirthYear').value = '';
    document.getElementById('newMemberLhdn').checked = true;
    document.getElementById('newMemberIras').checked = true;

    await renderMembersModalList();
    await populateOwnerFilter();
    await renderOverviewCards();
  }

  // ============================================================
  // Quick Add Modal
  // ============================================================
  async function openQuickAddModal() {
    const members = await getMembers();
    if (members.length === 0) {
      alert('Please add a member first via "👥 Members".');
      return;
    }
    const memberSelect = document.getElementById('quickAddMember');
    memberSelect.innerHTML = members.map(m => `<option value="${safeId(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    await updateQuickAddTypeOptions();
    document.getElementById('quickAddModal').classList.add('open');
    pushNavLayer('quickAddModal');
  }

  async function updateQuickAddTypeOptions() {
    const members = await getMembers();
    const memberId = parseInt(document.getElementById('quickAddMember').value, 10);
    const member = members.find(m => m.id === memberId);
    const t = memberTaxTypes(member);

    const opts = [];
    if (t.lhdn) opts.push('<option value="lhdn">LHDN (Malaysia)</option>');
    if (t.iras) opts.push('<option value="iras">IRAS (Singapore)</option>');

    document.getElementById('quickAddType').innerHTML = opts.join('') || '<option value="">No tax types enabled</option>';
  }

  function closeQuickAddModal() {
    document.getElementById('quickAddModal').classList.remove('open');
  }

  async function quickAddGo() {
    const memberId = parseInt(document.getElementById('quickAddMember').value, 10);
    const type = document.getElementById('quickAddType').value;

    if (!type) { alert('This member has no tax types enabled. Edit them via "👥 Members" first.'); return; }

    closeQuickAddModal();
    await openLedger(memberId, type, { autoExpandForm: true, replaceNavFrom: 'quickAddModal' });
  }

  // ============================================================
  // LHDN Form Submit Handler
  // ============================================================
  taxForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const recordId = document.getElementById('recordId').value;
    const yearWorking = parseInt(document.getElementById('yearWorking').value, 10);

    const yearSubmitVal = document.getElementById('yearSubmit').value;
    const tahunTaksiranVal = document.getElementById('tahunTaksiran').value;
    const taxAmountVal = document.getElementById('taxAmount').value;
    const incomeDeclaredVal = document.getElementById('incomeDeclared').value;

    const yearSubmit = yearSubmitVal !== '' ? parseInt(yearSubmitVal, 10) : null;
    const tahunTaksiran = tahunTaksiranVal !== '' ? parseInt(tahunTaksiranVal, 10) : null;
    const taxAmount = taxAmountVal !== '' ? parseFloat(taxAmountVal) : null;

    const lhdnYearVal = document.getElementById('lhdnYear').value;
    const lhdnAdjustedIncomeVal = document.getElementById('lhdnAdjustedIncome').value;
    const lhdnAdjustedTaxVal = document.getElementById('lhdnAdjustedTax').value;

    const lhdnYear = lhdnYearVal !== '' ? parseInt(lhdnYearVal, 10) : null;
    const lhdnAdjustedIncome = lhdnAdjustedIncomeVal !== '' ? parseFloat(lhdnAdjustedIncomeVal) : null;
    const lhdnAdjustedTax = lhdnAdjustedTaxVal !== '' ? parseFloat(lhdnAdjustedTaxVal) : null;

    const sources = [];
    let totalDerivedIncome = 0;

    const names = document.querySelectorAll('.source-name');
    const amounts = document.querySelectorAll('.source-amount');

    names.forEach((input, index) => {
      const name = input.value.trim();
      const amount = parseFloat(amounts[index].value) || 0;
      if (name) {
        sources.push({ name, amount });
        totalDerivedIncome += amount;
      }
    });

    // Income sources are no longer strictly required — a record can consist of
    // just an LHDN adjustment (e.g. logging a reassessment with no separate
    // income source for that year). Require at least one of the two.
    const hasLhdnData = (lhdnYear !== null) || (lhdnAdjustedIncome !== null) || (lhdnAdjustedTax !== null);
    if (sources.length === 0 && !hasLhdnData) {
      alert('Please add at least one income source, or fill in an LHDN Adjustment.');
      return;
    }

    // Income Declaration: auto-uses the sum of Income Sources unless the user
    // manually keys in a different declared amount (over/under-declare case).
    let incomeDeclared;
    let incomeDeclaredManual = false;
    let incomeVsSourceDiff = 0;

    if (incomeDeclaredVal === '') {
      incomeDeclared = totalDerivedIncome;
    } else {
      incomeDeclared = parseFloat(incomeDeclaredVal) || 0;
      incomeVsSourceDiff = incomeDeclared - totalDerivedIncome;
      incomeDeclaredManual = Math.abs(incomeVsSourceDiff) >= 0.005;
    }

    const incomeAfterTax = incomeDeclared - (taxAmount || 0);

    const record = {
      memberId: currentMemberId,
      yearWorking,
      yearSubmit,
      tahunTaksiran,
      sources,
      totalDerivedIncome,
      incomeDeclared,
      incomeDeclaredManual,
      incomeVsSourceDiff,
      taxAmount,
      incomeAfterTax,
      lhdnYear,
      lhdnAdjustedIncome,
      lhdnAdjustedTax,
      attachments: collectAttachmentsForSave('lhdn')
    };

    if (recordId) {
      record.id = parseInt(recordId, 10);
    }

    try {
      await saveRecordToDB(record);
    } catch (err) {
      if (err && err.isStale) return;           // the lock screen already explains it
      if (err) err.__reported = true;
      alert(describeDbError(err));
      return;                                   // keep what was typed so nothing is lost
    }
    resetForm();
    await refreshApp();
  });

  // ============================================================
  // IRAS Form Submit Handler
  // ============================================================
  irasForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const irasRecordId = document.getElementById('irasRecordId').value;
    const irasYearWorking = parseInt(document.getElementById('irasYearWorking').value, 10);

    const irasYearSubmitVal = document.getElementById('irasYearSubmit').value;
    const irasNoaVal = document.getElementById('irasNoa').value.trim();
    const irasNoaIncomeVal = document.getElementById('irasNoaIncome').value;
    const irasTaxPaymentVal = document.getElementById('irasTaxPayment').value;
    const irasNoteVal = document.getElementById('irasNote').value.trim();

    const irasYearSubmit = irasYearSubmitVal !== '' ? parseInt(irasYearSubmitVal, 10) : null;
    const irasNoa = irasNoaVal !== '' ? irasNoaVal : null;
    const irasNoaIncome = irasNoaIncomeVal !== '' ? parseFloat(irasNoaIncomeVal) : null;
    const irasTaxPayment = irasTaxPaymentVal !== '' ? parseFloat(irasTaxPaymentVal) : null;
    const irasNote = irasNoteVal !== '' ? irasNoteVal : null;

    const irasRecord = {
      memberId: currentMemberId,
      yearWorking: irasYearWorking,
      yearSubmit: irasYearSubmit,
      noa: irasNoa,
      noaIncome: irasNoaIncome,
      taxPayment: irasTaxPayment,
      note: irasNote,
      attachments: collectAttachmentsForSave('iras')
    };

    if (irasRecordId) {
      irasRecord.id = parseInt(irasRecordId, 10);
    }

    try {
      await saveIrasRecordToDB(irasRecord);
    } catch (err) {
      if (err && err.isStale) return;
      if (err) err.__reported = true;
      alert(describeDbError(err));
      return;
    }
    resetIrasForm();
    await refreshApp();
  });

  async function editIrasRecord(id) {
    const irasRecords = await getIrasRecordsByMember(currentMemberId);
    const record = irasRecords.find(r => r.id === id);
    if (!record) return;

    document.getElementById('irasRecordId').value = record.id;
    document.getElementById('irasYearWorking').value = record.yearWorking;
    document.getElementById('irasYearSubmit').value = record.yearSubmit !== null && record.yearSubmit !== undefined ? record.yearSubmit : '';
    document.getElementById('irasNoa').value = record.noa || '';
    document.getElementById('irasNoaIncome').value = record.noaIncome !== null && record.noaIncome !== undefined ? record.noaIncome : '';
    document.getElementById('irasTaxPayment').value = record.taxPayment !== null && record.taxPayment !== undefined ? record.taxPayment : '';
    document.getElementById('irasNote').value = record.note || '';

    loadAttachmentStateForEdit('iras', record.attachments);

    irasFormTitle.textContent = 'Edit IRAS (Singapore) Tax Entry';
    irasSubmitBtn.textContent = 'Update IRAS Record';
    editingIrasYearText.textContent = record.yearWorking;
    editingIrasBanner.style.display = 'block';
    cancelIrasEditBtn.style.display = 'inline-block';

    toggleIrasForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function deleteIrasRecord(id) {
    if (confirm('Are you sure you want to delete this IRAS record?')) {
      await deleteIrasRecordFromDB(id);
      await refreshApp();
    }
  }

  function resetIrasForm() {
    irasForm.reset();
    document.getElementById('irasRecordId').value = '';
    irasFormTitle.textContent = 'Add IRAS (Singapore) Tax Entry';
    irasSubmitBtn.textContent = 'Save IRAS Record';
    editingIrasBanner.style.display = 'none';
    cancelIrasEditBtn.style.display = 'none';
    resetAttachmentState('iras');
  }

  async function editRecord(id) {
    const records = await getRecordsByMember(currentMemberId);
    const record = records.find(r => r.id === id);
    if (!record) return;

    document.getElementById('recordId').value = record.id;
    document.getElementById('yearWorking').value = record.yearWorking;
    document.getElementById('yearSubmit').value = record.yearSubmit !== null && record.yearSubmit !== undefined ? record.yearSubmit : '';
    document.getElementById('tahunTaksiran').value = record.tahunTaksiran !== null && record.tahunTaksiran !== undefined ? record.tahunTaksiran : '';
    // Only re-populate Income Declaration if it was a manual key-in; otherwise
    // leave blank so it continues to auto-derive from the income sources.
    document.getElementById('incomeDeclared').value = record.incomeDeclaredManual ? record.incomeDeclared : '';
    document.getElementById('taxAmount').value = record.taxAmount !== null && record.taxAmount !== undefined ? record.taxAmount : '';

    document.getElementById('lhdnYear').value = record.lhdnYear || '';
    document.getElementById('lhdnAdjustedIncome').value = record.lhdnAdjustedIncome !== null && record.lhdnAdjustedIncome !== undefined ? record.lhdnAdjustedIncome : '';
    document.getElementById('lhdnAdjustedTax').value = record.lhdnAdjustedTax !== null && record.lhdnAdjustedTax !== undefined ? record.lhdnAdjustedTax : '';

    incomeSourcesContainer.innerHTML = '';
    record.sources.forEach(s => addSourceRow(s.name, s.amount));
    updateIncomeDeclaredPreview();

    loadAttachmentStateForEdit('lhdn', record.attachments);

    formTitle.textContent = 'Edit Tax Record';
    submitBtn.textContent = 'Update Record';
    editingYearText.textContent = record.yearWorking;
    editingBanner.style.display = 'block';
    cancelEditBtn.style.display = 'inline-block';

    toggleLhdnForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function deleteRecord(id) {
    if (confirm('Are you sure you want to delete this record?')) {
      await deleteRecordFromDB(id);
      await refreshApp();
    }
  }

  function resetForm() {
    taxForm.reset();
    document.getElementById('recordId').value = '';
    formTitle.textContent = 'Add Tax & Income Entry';
    submitBtn.textContent = 'Save Record';
    editingBanner.style.display = 'none';
    cancelEditBtn.style.display = 'none';

    incomeSourcesContainer.innerHTML = '';
    addSourceRow();
    updateIncomeDeclaredPreview();
    resetAttachmentState('lhdn');
  }

  // ============================================================
  // Ledger Rendering
  // ============================================================
  async function refreshApp() {
    let records = await getRecordsByMember(currentMemberId);
    records.sort((a, b) => b.yearWorking - a.yearWorking);

    let irasRecords = await getIrasRecordsByMember(currentMemberId);
    irasRecords.sort((a, b) => b.yearWorking - a.yearWorking);

    renderSummaryCards(records);
    renderDatalist(records);
    renderRecordsTable(records);
    renderCompanyReport(records);
    renderIrasSummary(irasRecords);
    renderIrasTable(irasRecords);
  }

  function renderSummaryCards(records) {
    const totals = computeLhdnTotals(records);
    document.getElementById('summaryNetIncome').textContent = formatCurrency(totals.netIncome, 'MYR');
    document.getElementById('summaryTaxPaid').textContent = formatCurrency(totals.taxPaid, 'MYR');
  }

  function renderIrasSummary(irasRecords) {
    const totals = computeIrasTotals(irasRecords);
    document.getElementById('irasSummaryNetIncome').textContent = formatCurrency(totals.netIncome, 'SGD');
    document.getElementById('irasSummaryTotalIncome').textContent = formatCurrency(totals.totalIncome, 'SGD');
    document.getElementById('irasSummaryTaxPaid').textContent = formatCurrency(totals.taxPaid, 'SGD');
    document.getElementById('irasSummaryYears').textContent = totals.count;
  }

  function renderDatalist(records) {
    const companies = new Set();
    records.forEach(r => r.sources.forEach(s => companies.add(s.name.trim())));

    companyDatalist.innerHTML = Array.from(companies)
      .sort()
      .map(company => `<option value="${escapeHtml(company)}">`)
      .join('');
  }

  function renderRecordsTable(records) {
    if (records.length === 0) {
      recordsTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No records saved yet.</td></tr>`;
      return;
    }

    recordsTableBody.innerHTML = records.map(r => {
      const hasIncomeAdj = (r.lhdnAdjustedIncome !== null && r.lhdnAdjustedIncome !== undefined);
      const hasTaxAdj = (r.lhdnAdjustedTax !== null && r.lhdnAdjustedTax !== undefined);
      const hasLhdn = hasIncomeAdj || hasTaxAdj;
      const lhdnYearStr = r.lhdnYear ? ` (Year ${fmtYear(r.lhdnYear)})` : '';
      const lhdnBadge = `<span class="badge badge-lhdn">LHDN Adj${lhdnYearStr}</span>`;

      const sourcesList = r.sources.length > 0
        ? r.sources.map(s => `<div><strong>${escapeHtml(s.name)}:</strong> ${formatCurrency(s.amount, 'MYR')}</div>`).join('')
        : '';
      const attachmentsHtml = (Array.isArray(r.attachments) && r.attachments.length > 0)
        ? r.attachments.map((att, i) => `<div class="attachment-chip-inline no-print"><button type="button" class="attachment-link-btn" data-action="open-record-attachment" data-kind="lhdn" data-id="${safeId(r.id)}" data-idx="${i}">📎 <small>${escapeHtml(att.name || 'attachment')}</small></button></div>`).join('')
        : '';
      const sourcesCell = [sourcesList, hasLhdn ? lhdnBadge : '', attachmentsHtml].filter(Boolean).join('<br>')
        || '<span style="color: var(--text-muted);">-</span>';

      const hasYearSubmit = (r.yearSubmit !== null && r.yearSubmit !== undefined && !isNaN(r.yearSubmit));
      const hasTahunTaksiran = (r.tahunTaksiran !== null && r.tahunTaksiran !== undefined && !isNaN(r.tahunTaksiran));
      const submitLine = hasYearSubmit ? `Submit: ${fmtYear(r.yearSubmit)}` : '';
      const yaBadge = hasTahunTaksiran ? `<span class="badge">YA ${fmtYear(r.tahunTaksiran)}</span>` : '';
      const submitYaCell = [submitLine, yaBadge].filter(Boolean).join('<br>')
        || '<span style="color: var(--text-muted);">-</span>';

      // LHDN Adjusted Income and Adjusted Tax each override independently —
      // entering only one (e.g. just a corrected tax amount) still applies,
      // falling back to the original declared income / tax for the other.
      const effectiveDeclaredIncome = hasIncomeAdj ? r.lhdnAdjustedIncome : r.incomeDeclared;
      const effectiveTaxPaid = hasTaxAdj ? r.lhdnAdjustedTax : r.taxAmount;
      const effectiveNet = (effectiveDeclaredIncome || 0) - (effectiveTaxPaid || 0);

      const taxAmountStr = (effectiveTaxPaid !== null && effectiveTaxPaid !== undefined) ? formatCurrency(effectiveTaxPaid, 'MYR') : '-';

      // Over/under-declared note only applies to the original manual declaration
      // vs. income sources — suppressed once an LHDN Income Adjustment overrides it.
      const hasDiff = !hasIncomeAdj && r.incomeDeclaredManual && Math.abs(r.incomeVsSourceDiff || 0) >= 0.005;
      const diffLabel = (r.incomeVsSourceDiff || 0) > 0 ? 'Over-declared' : 'Under-declared';
      const declaredDiffHtml = hasDiff
        ? `<br><small style="color: var(--warning); font-weight: 600;">${diffLabel} by ${formatCurrency(Math.abs(r.incomeVsSourceDiff), 'MYR')}</small>`
        : '';

      const ageStr = (currentMemberBirthYear && r.yearWorking > 0) ? `<br><small style="color: var(--text-muted);">Age: ${Math.trunc(r.yearWorking - currentMemberBirthYear)}</small>` : '';

      return `
        <tr>
          <td><strong>${fmtYear(r.yearWorking)}</strong>${ageStr}</td>
          <td>${submitYaCell}</td>
          <td>${sourcesCell}</td>
          <td><strong>${formatCurrency(r.totalDerivedIncome, 'MYR')}</strong></td>
          <td><strong>${formatCurrency(effectiveDeclaredIncome, 'MYR')}</strong>${declaredDiffHtml}</td>
          <td style="color: var(--danger);">${taxAmountStr}</td>
          <td style="color: var(--success); font-weight: bold;">${formatCurrency(effectiveNet, 'MYR')}</td>
          <td class="no-print">
            <button class="icon-btn edit" title="Edit Record" data-action="edit-record" data-id="${safeId(r.id)}">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button class="icon-btn delete" title="Delete Record" data-action="delete-record" data-id="${safeId(r.id)}">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderCompanyReport(records) {
    const companyMap = {};

    records.forEach(r => {
      r.sources.forEach(s => {
        const company = s.name.trim();
        const year = r.yearWorking;

        if (!companyMap[company]) {
          companyMap[company] = { years: {}, total: 0 };
        }

        companyMap[company].years[year] = (companyMap[company].years[year] || 0) + s.amount;
        companyMap[company].total += s.amount;
      });
    });

    // Sort by year range (earliest working year first), not alphabetically.
    const companyNames = Object.keys(companyMap).sort((a, b) => {
      const minYearA = Math.min(...Object.keys(companyMap[a].years).map(Number));
      const minYearB = Math.min(...Object.keys(companyMap[b].years).map(Number));
      return minYearA - minYearB;
    });

    const companyReportCards = document.getElementById('companyReportCards');

    if (companyNames.length === 0) {
      companyReportBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No records found.</td></tr>`;
      companyReportCards.innerHTML = `<div class="empty-state">No records found.</div>`;
      return;
    }

    companyReportBody.innerHTML = companyNames.map(company => {
      const data = companyMap[company];
      const years = Object.keys(data.years).map(Number).sort((a, b) => a - b);

      const yearRange = years.length === 1
        ? `${years[0]}`
        : `${years[0]} - ${years[years.length - 1]}`;

      const annualBreakdown = years.map(y => `<div><strong>${fmtYear(y)}:</strong> ${formatCurrency(data.years[y], 'MYR')}</div>`).join('');

      return `
        <tr>
          <td><strong>${escapeHtml(company)}</strong></td>
          <td><span class="badge">${yearRange}</span></td>
          <td>${annualBreakdown}</td>
          <td><strong>${formatCurrency(data.total, 'MYR')}</strong></td>
        </tr>
      `;
    }).join('');

    // Card view: order by breakdown length (fewest years first) rather than
    // earliest year, so a company with a long multi-decade history doesn't
    // land in the middle of the grid and throw off the row alignment —
    // it naturally sinks to the end instead. The table above keeps the
    // chronological (earliest-year-first) order.
    const cardOrder = [...companyNames].sort((a, b) => {
      const lenA = Object.keys(companyMap[a].years).length;
      const lenB = Object.keys(companyMap[b].years).length;
      return lenA - lenB;
    });

    companyReportCards.innerHTML = cardOrder.map(company => {
      const data = companyMap[company];
      const years = Object.keys(data.years).map(Number).sort((a, b) => a - b);

      const yearRange = years.length === 1
        ? `${years[0]}`
        : `${years[0]} - ${years[years.length - 1]}`;

      const annualBreakdown = years.map(y => `<div><strong>${fmtYear(y)}:</strong> ${formatCurrency(data.years[y], 'MYR')}</div>`).join('');

      // Long-spanning companies get a wider card and a multi-column
      // breakdown instead of one long vertical list of years.
      let wideClass = '', columnClass = '';
      if (years.length > 20) { wideClass = 'wide-3'; columnClass = 'multi-col-3'; }
      else if (years.length > 10) { wideClass = 'wide-2'; columnClass = 'multi-col-2'; }

      return `
        <div class="company-card ${wideClass}">
          <div class="company-card-name">${escapeHtml(company)}</div>
          <span class="badge">${yearRange}</span>
          <div class="company-card-breakdown ${columnClass}">${annualBreakdown}</div>
          <div class="company-card-total">Total: ${formatCurrency(data.total, 'MYR')}</div>
        </div>
      `;
    }).join('');
  }

  function setCompanyReportView(mode) {
    const isTable = mode === 'table';
    document.getElementById('companyReportTable').style.display = isTable ? 'table' : 'none';
    document.getElementById('companyReportCards').style.display = isTable ? 'none' : 'grid';
    document.getElementById('companyReportTableBtn').classList.toggle('active', isTable);
    document.getElementById('companyReportCardBtn').classList.toggle('active', !isTable);
  }

  function renderIrasTable(irasRecords) {
    if (irasRecords.length === 0) {
      irasTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No IRAS records saved yet.</td></tr>`;
      return;
    }

    irasTableBody.innerHTML = irasRecords.map(r => {
      const yearSubmitStr = fmtYear(r.yearSubmit);
      const attachmentsHtml = (Array.isArray(r.attachments) && r.attachments.length > 0)
        ? r.attachments.map((att, i) => `<div class="attachment-chip-inline no-print"><button type="button" class="attachment-link-btn" data-action="open-record-attachment" data-kind="iras" data-id="${safeId(r.id)}" data-idx="${i}">📎 <small>${escapeHtml(att.name || 'attachment')}</small></button></div>`).join('')
        : '';
      const noaStr = (r.noa ? `<span class="badge badge-iras">${escapeHtml(r.noa)}</span>` : '<span style="color: var(--text-muted);">-</span>') + (renderNoteHtml(r.note) ? '<br>' + renderNoteHtml(r.note) : '') + (attachmentsHtml ? '<br>' + attachmentsHtml : '');
      const noaIncomeStr = (r.noaIncome !== null && r.noaIncome !== undefined) ? formatCurrency(r.noaIncome, 'SGD') : '-';
      const taxPaymentStr = (r.taxPayment !== null && r.taxPayment !== undefined) ? formatCurrency(r.taxPayment, 'SGD') : '-';
      const netIncome = (r.noaIncome || 0) - (r.taxPayment || 0);
      const netIncomeStr = (r.noaIncome !== null && r.noaIncome !== undefined) || (r.taxPayment !== null && r.taxPayment !== undefined)
        ? formatCurrency(netIncome, 'SGD') : '-';

      const ageStr = (currentMemberBirthYear && r.yearWorking > 0) ? `<br><small style="color: var(--text-muted);">Age: ${Math.trunc(r.yearWorking - currentMemberBirthYear)}</small>` : '';

      return `
        <tr>
          <td><strong>${fmtYear(r.yearWorking)}</strong>${ageStr}</td>
          <td>${yearSubmitStr}</td>
          <td>${noaStr}</td>
          <td>${noaIncomeStr}</td>
          <td style="color: var(--iras-red); font-weight: bold;">${taxPaymentStr}</td>
          <td style="color: var(--success); font-weight: bold;">${netIncomeStr}</td>
          <td class="no-print">
            <button class="icon-btn edit" title="Edit IRAS Record" data-action="edit-iras-record" data-id="${safeId(r.id)}">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button class="icon-btn delete" title="Delete IRAS Record" data-action="delete-iras-record" data-id="${safeId(r.id)}">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // ============================================================
  // Event Wiring (no inline handlers)
  // ------------------------------------------------------------
  // CSP's script-src has no 'unsafe-inline', so every click / change /
  // keydown that used to be an onclick="..."/onchange="..."/onkeydown="..."
  // attribute in the HTML is wired up here instead.
  // ============================================================

  // Static, always-present buttons: id -> click handler.
  const staticClickHandlers = {
    setupPasscodeBtn: () => handleSetupPasscode(),
    unlockBtn: () => handleUnlock(),
    exportJsonBtn: () => openExportModal(),
    importJsonBtn: () => document.getElementById('importFileInput').click(),
    changePasscodeMenuBtn: () => openChangePasscodeModal(),
    lockAppBtn: () => lockApp(),
    openMembersBtn: () => openMembersModal(),
    printReportBtn: () => printCurrentView(),
    openQuickAddBtn: () => openQuickAddModal(),
    backToOverviewBtn: () => requestCloseLayer('ledger'),
    printLedgerBtn: () => printCurrentView(),
    toggleLhdnFormBtn: () => toggleLhdnForm(),
    cancelEditBtn: () => resetForm(),
    companyReportTableBtn: () => setCompanyReportView('table'),
    companyReportCardBtn: () => setCompanyReportView('card'),
    toggleIrasFormBtn: () => toggleIrasForm(),
    cancelIrasEditBtn: () => resetIrasForm(),
    addMemberBtn: () => addMemberFromModal(),
    closeMembersModalBtn: () => requestCloseLayer('membersModal'),
    closeQuickAddModalBtn: () => requestCloseLayer('quickAddModal'),
    quickAddGoBtn: () => quickAddGo(),
    closeChangePasscodeModalBtn: () => requestCloseLayer('changePasscodeModal'),
    changePasscodeBtn: () => handleChangePasscode(),
    closeExportModalBtn: () => requestCloseLayer('exportModal'),
    performExportBtn: () => performExport(),
    closeImportPasscodeModalBtn: () => requestCloseLayer('importPasscodeModal'),
    decryptImportBtn: () => decryptAndImport(),
    closeAttachmentViewerBtn: () => requestCloseLayer('attachmentViewerModal'),
    lhdnAttachmentAddBtn: () => document.getElementById('lhdnAttachmentInput').click(),
    irasAttachmentAddBtn: () => document.getElementById('irasAttachmentInput').click(),
  };
  Object.entries(staticClickHandlers).forEach(([id, handler]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
    else console.warn(`Event wiring: #${id} not found in DOM.`);
  });

  const idleLockSelectEl = document.getElementById('idleLockSelect');
  if (idleLockSelectEl) idleLockSelectEl.addEventListener('change', handleIdleLockChange);

  // Dynamically re-rendered elements (records table, IRAS table, members
  // list, overview cards, income-source rows) carry a data-action
  // attribute instead of an id, since they're recreated on every render.
  // One delegated listener on document handles all of them.
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const { action, id, type } = target.dataset;
    switch (action) {
      case 'remove-source-row': removeSourceRow(target); break;
      case 'open-ledger': openLedger(Number(id), type); break;
      case 'save-member-edits': saveMemberEdits(Number(id)); break;
      case 'delete-member-entirely': deleteMemberEntirely(Number(id)); break;
      case 'edit-record': editRecord(Number(id)); break;
      case 'delete-record': deleteRecord(Number(id)); break;
      case 'edit-iras-record': editIrasRecord(Number(id)); break;
      case 'delete-iras-record': deleteIrasRecord(Number(id)); break;
      case 'open-record-attachment': openRecordAttachment(target.dataset.kind, Number(id), Number(target.dataset.idx)); break;
      case 'remove-existing-attachment': removeExistingAttachment(target.dataset.kind, Number(target.dataset.idx)); break;
      case 'remove-pending-attachment': removePendingAttachment(target.dataset.kind, Number(target.dataset.idx)); break;
    }
  });

  // change listeners (formerly onchange="...")
  document.getElementById('importFileInput').addEventListener('change', importJSON);
  ownerFilter.addEventListener('change', renderOverviewCards);
  document.getElementById('quickAddMember').addEventListener('change', updateQuickAddTypeOptions);
  document.getElementById('exportEncryptToggle').addEventListener('change', updateExportModalView);
  document.getElementById('lhdnAttachmentInput').addEventListener('change', (e) => handleAttachmentSelect('lhdn', e));
  document.getElementById('irasAttachmentInput').addEventListener('change', (e) => handleAttachmentSelect('iras', e));

  // keydown listeners (formerly onkeydown="...") — Enter-to-advance /
  // Enter-to-submit on passcode fields.
  document.getElementById('setupPasscode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('setupPasscodeConfirm').focus();
  });
  document.getElementById('setupPasscodeConfirm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSetupPasscode();
  });
  document.getElementById('unlockPasscode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleUnlock();
  });
  document.getElementById('importBackupPasscode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') decryptAndImport();
  });

  // ============================================================
  // App Initialization
  // ============================================================
  if (!(window.crypto && window.crypto.subtle)) {
    document.getElementById('lockScreen').style.display = 'none';
    showFatalError('Encryption (Web Crypto) is not available in this browser context. This usually happens when opening the file directly (file://) in a browser that restricts it to secure contexts. Try opening this file via a local web server (e.g. http://localhost) instead, or use a browser such as Chrome which generally supports it over file:// URLs.');
  } else {
    initDB().then(async () => {
      const meta = await getVaultMeta();
      showLockScreen(meta ? 'unlock' : 'setup');
    }).catch(err => {
      console.error(err);
      document.getElementById('lockScreen').style.display = 'none';
      showFatalError((err && err.message) ? err.message : 'Failed to initialize the local database. Try reloading the page.');
    });
  }

  // PWA: register the service worker for offline support. This is a no-op
  // (silently skipped) in contexts that don't support it, e.g. file:// URLs
  // in some browsers — the app still works fully without it.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }
