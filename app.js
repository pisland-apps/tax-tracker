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

  function getVaultMeta() {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_VAULT, 'readonly');
      const store = tx.objectStore(STORE_VAULT);
      const request = store.get('vault');
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  function saveVaultMeta(meta) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_VAULT, 'readwrite');
      const store = tx.objectStore(STORE_VAULT);
      const request = store.put({ id: 'vault', ...meta });
      request.onsuccess = () => resolve();
    });
  }

  // Returns the derived CryptoKey if the passcode is correct, or null if not.
  async function verifyPasscode(passcode, meta) {
    try {
      const key = await deriveKeyFromPasscode(passcode, meta.salt, meta.iterations || PBKDF2_ITERATIONS);
      const result = await decryptObject(meta.verify, key);
      return result === VAULT_CHECK_STRING ? key : null;
    } catch (e) {
      return null; // wrong passcode → AES-GCM auth tag check fails → decrypt throws
    }
  }

  // Raw (unencrypted-aware) helpers used only for the one-time legacy-data
  // migration below, where rows may or may not already be in {encData} form.
  function getAllRaw(storeName) {
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
    });
  }

  function putRaw(storeName, obj) {
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(obj);
      request.onsuccess = () => resolve();
    });
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

  // ============================================================
  // Member DB Methods (encrypted at rest — name & taxTypes are inside encData;
  // only the numeric `id` primary key stays in the clear)
  // ============================================================
  function getMembers() {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_MEMBERS, 'readonly');
      const store = tx.objectStore(STORE_MEMBERS);
      const request = store.getAll();
      request.onsuccess = async () => {
        const raw = request.result || [];
        const decrypted = await Promise.all(raw.map(async row => {
          if (row.encData) {
            const payload = await decryptObject(row.encData);
            return { id: row.id, ...payload };
          }
          return row;
        }));
        resolve(decrypted);
      };
    });
  }

  async function saveMember(name, taxTypes, birthYear) {
    const encData = await encryptObject({ name, taxTypes: taxTypes || { lhdn: true, iras: true }, birthYear: birthYear || null });
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_MEMBERS, 'readwrite');
      const store = tx.objectStore(STORE_MEMBERS);
      const request = store.add({ encData });
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function updateMemberInDB(member) {
    const { id, ...payload } = member;
    const encData = await encryptObject(payload);
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_MEMBERS, 'readwrite');
      const store = tx.objectStore(STORE_MEMBERS);
      const request = store.put({ id, encData });
      request.onsuccess = () => resolve(request.result);
    });
  }

  function deleteMemberFromDB(id) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_MEMBERS, 'readwrite');
      tx.objectStore(STORE_MEMBERS).delete(id);
      tx.oncomplete = () => resolve();
    });
  }

  // Members created before the LHDN/IRAS toggle existed default to both enabled.
  function memberTaxTypes(member) {
    return (member && member.taxTypes) ? member.taxTypes : { lhdn: true, iras: true };
  }

  // ============================================================
  // LHDN Record DB Methods (encrypted at rest — id & memberId stay in the
  // clear so the memberId index keeps working; everything else is encrypted)
  // ============================================================
  function getRecordsByMember(memberId) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_RECORDS, 'readonly');
      const store = tx.objectStore(STORE_RECORDS);
      const index = store.index('memberId');
      const request = index.getAll(memberId);
      request.onsuccess = async () => {
        const raw = request.result || [];
        const decrypted = await Promise.all(raw.map(async row => {
          const payload = await decryptObject(row.encData);
          return { id: row.id, memberId: row.memberId, ...payload };
        }));
        resolve(decrypted);
      };
    });
  }

  function getAllRecords() {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_RECORDS, 'readonly');
      const store = tx.objectStore(STORE_RECORDS);
      const request = store.getAll();
      request.onsuccess = async () => {
        const raw = request.result || [];
        const decrypted = await Promise.all(raw.map(async row => {
          const payload = await decryptObject(row.encData);
          return { id: row.id, memberId: row.memberId, ...payload };
        }));
        resolve(decrypted);
      };
    });
  }

  async function saveRecordToDB(record) {
    const { id, memberId, ...payload } = record;
    const encData = await encryptObject(payload);
    const toStore = { memberId, encData };
    if (id !== undefined && id !== null) toStore.id = id;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_RECORDS, 'readwrite');
      const store = tx.objectStore(STORE_RECORDS);
      const request = store.put(toStore);
      request.onsuccess = () => resolve(request.result);
    });
  }

  function deleteRecordFromDB(id) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_RECORDS, 'readwrite');
      const store = tx.objectStore(STORE_RECORDS);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
    });
  }

  // ============================================================
  // IRAS (Singapore) Record DB Methods (same encrypted-at-rest pattern)
  // ============================================================
  function getIrasRecordsByMember(memberId) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_IRAS_RECORDS, 'readonly');
      const store = tx.objectStore(STORE_IRAS_RECORDS);
      const index = store.index('memberId');
      const request = index.getAll(memberId);
      request.onsuccess = async () => {
        const raw = request.result || [];
        const decrypted = await Promise.all(raw.map(async row => {
          const payload = await decryptObject(row.encData);
          return { id: row.id, memberId: row.memberId, ...payload };
        }));
        resolve(decrypted);
      };
    });
  }

  function getAllIrasRecords() {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_IRAS_RECORDS, 'readonly');
      const store = tx.objectStore(STORE_IRAS_RECORDS);
      const request = store.getAll();
      request.onsuccess = async () => {
        const raw = request.result || [];
        const decrypted = await Promise.all(raw.map(async row => {
          const payload = await decryptObject(row.encData);
          return { id: row.id, memberId: row.memberId, ...payload };
        }));
        resolve(decrypted);
      };
    });
  }

  async function saveIrasRecordToDB(record) {
    const { id, memberId, ...payload } = record;
    const encData = await encryptObject(payload);
    const toStore = { memberId, encData };
    if (id !== undefined && id !== null) toStore.id = id;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_IRAS_RECORDS, 'readwrite');
      const store = tx.objectStore(STORE_IRAS_RECORDS);
      const request = store.put(toStore);
      request.onsuccess = () => resolve(request.result);
    });
  }

  function deleteIrasRecordFromDB(id) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_IRAS_RECORDS, 'readwrite');
      const store = tx.objectStore(STORE_IRAS_RECORDS);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
    });
  }

  async function deleteMemberCascade(memberId) {
    const records = await getRecordsByMember(memberId);
    for (const r of records) await deleteRecordFromDB(r.id);
    const irasRecords = await getIrasRecordsByMember(memberId);
    for (const r of irasRecords) await deleteIrasRecordFromDB(r.id);
    await deleteMemberFromDB(memberId);
  }

  function clearAllData() {
    return new Promise((resolve) => {
      const tx = db.transaction([STORE_RECORDS, STORE_MEMBERS, STORE_IRAS_RECORDS], 'readwrite');
      tx.objectStore(STORE_RECORDS).clear();
      tx.objectStore(STORE_MEMBERS).clear();
      tx.objectStore(STORE_IRAS_RECORDS).clear();
      tx.oncomplete = () => resolve();
    });
  }

  // ============================================================
  // Export / Import JSON (optionally encrypted with its own backup passcode,
  // independent of the app's own vault passcode — so a backup stays
  // importable even after the app passcode is later changed)
  // ============================================================
  let pendingImportPayload = null; // holds a parsed *encrypted* backup awaiting its passcode

  function openExportModal() {
    document.getElementById('exportEncryptToggle').checked = true;
    document.getElementById('exportPasscode').value = '';
    document.getElementById('exportPasscodeConfirm').value = '';
    document.getElementById('exportError').style.display = 'none';
    updateExportModalView();
    document.getElementById('exportModal').classList.add('open');
  }

  function closeExportModal() {
    document.getElementById('exportModal').classList.remove('open');
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

    const members = await getMembers();
    const records = await getAllRecords();
    const irasRecords = await getAllIrasRecords();

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

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload, null, 2));
    const downloadAnchor = document.createElement('a');

    const today = new Date().toISOString().split('T')[0];
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `tax_records_backup_${today}${encrypt ? '_encrypted' : ''}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();

    closeExportModal();
  }

  async function importJSON(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const importedData = JSON.parse(e.target.result);

        if (importedData.encrypted) {
          pendingImportPayload = importedData;
          document.getElementById('importBackupPasscode').value = '';
          document.getElementById('importPasscodeError').style.display = 'none';
          document.getElementById('importPasscodeModal').classList.add('open');
          return;
        }

        if (!importedData.members || !importedData.records) {
          alert("Invalid backup format.");
          return;
        }

        await applyImportedData(importedData);
      } catch (err) {
        alert("Failed to parse JSON backup file.");
        console.error(err);
      }
    };

    reader.readAsText(file);
    event.target.value = '';
  }

  function closeImportPasscodeModal() {
    document.getElementById('importPasscodeModal').classList.remove('open');
    pendingImportPayload = null;
  }

  async function decryptAndImport() {
    const passcode = document.getElementById('importBackupPasscode').value;
    const errEl = document.getElementById('importPasscodeError');
    errEl.style.display = 'none';

    try {
      const key = await deriveKeyFromPasscode(passcode, pendingImportPayload.salt, pendingImportPayload.iterations || PBKDF2_ITERATIONS);
      const decrypted = await decryptObject({ iv: pendingImportPayload.iv, ct: pendingImportPayload.ct }, key);

      if (!decrypted.members || !decrypted.records) {
        errEl.textContent = 'Invalid backup contents.';
        errEl.style.display = 'block';
        return;
      }

      const dataToImport = decrypted;
      closeImportPasscodeModal();
      await applyImportedData(dataToImport);
    } catch (err) {
      errEl.textContent = 'Incorrect backup passcode, or corrupted file.';
      errEl.style.display = 'block';
    }
  }

  async function applyImportedData(importedData) {
    if (confirm("Overwriting existing data with imported backup. Proceed?")) {
      await clearAllData();

      // Preserve original IDs on import — records reference members by
      // memberId, so re-adding members with saveMember() (which always
      // generates a brand-new ID) would silently orphan every record.
      for (const m of importedData.members) {
        await updateMemberInDB({ id: m.id, name: m.name, taxTypes: m.taxTypes || { lhdn: true, iras: true } });
      }
      for (const r of importedData.records) {
        await saveRecordToDB(r);
      }
      for (const r of (importedData.irasRecords || [])) {
        await saveIrasRecordToDB(r);
      }

      alert("Import completed successfully!");
      backToOverview();
      await initApp();
    }
  }

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
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatCurrency(val, currency = 'MYR') {
    if (val === null || val === undefined || isNaN(val)) return '-';
    const prefix = currency === 'SGD' ? 'S$' : 'RM';
    return prefix + ' ' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    if (mode === 'unlock') {
      setTimeout(() => document.getElementById('unlockPasscode').focus(), 50);
    } else {
      setTimeout(() => document.getElementById('setupPasscode').focus(), 50);
    }
  }

  function showApp() {
    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('appContainer').style.display = 'flex';
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
      await saveVaultMeta({ salt, verify, iterations: PBKDF2_ITERATIONS });

      // Encrypt any pre-existing plaintext data from before this feature existed.
      await migrateLegacyDataToEncrypted();

      showApp();
      await initApp();
    } catch (err) {
      console.error(err);
      vaultKey = null;
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
      showApp();
      await initApp();
    } catch (err) {
      console.error(err);
      showLockError('Something went wrong while unlocking. Please try again.');
    }
  }

  function lockApp() {
    vaultKey = null;
    currentMemberId = null;
    ledgerMemberId = null;
    ledgerType = null;
    currentMemberBirthYear = null;
    document.getElementById('ledgerView').style.display = 'none';
    document.getElementById('overviewView').style.display = 'block';
    showLockScreen('unlock');
  }

  function openChangePasscodeModal() {
    document.getElementById('currentPasscodeInput').value = '';
    document.getElementById('newPasscodeInput').value = '';
    document.getElementById('newPasscodeConfirmInput').value = '';
    document.getElementById('changePasscodeError').style.display = 'none';
    document.getElementById('changePasscodeModal').classList.add('open');
  }

  function closeChangePasscodeModal() {
    document.getElementById('changePasscodeModal').classList.remove('open');
  }

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
      const meta = await getVaultMeta();
      const testKey = await verifyPasscode(current, meta);
      if (!testKey) { showErr('Current passcode is incorrect.'); return; }

      // Decrypt everything under the old key first (via the normal, already-
      // decryption-aware getters, since vaultKey is still the old key here).
      const members = await getMembers();
      const records = await getAllRecords();
      const irasRecords = await getAllIrasRecords();

      // Derive the new key, then re-encrypt every row under it.
      const newSalt = bufToB64(crypto.getRandomValues(new Uint8Array(16)));
      const newKey = await deriveKeyFromPasscode(next, newSalt, PBKDF2_ITERATIONS);

      vaultKey = newKey;
      for (const m of members) await updateMemberInDB(m);
      for (const r of records) await saveRecordToDB(r);
      for (const r of irasRecords) await saveIrasRecordToDB(r);

      const verify = await encryptObject(VAULT_CHECK_STRING);
      await saveVaultMeta({ salt: newSalt, verify, iterations: PBKDF2_ITERATIONS });

      closeChangePasscodeModal();
      alert('Passcode updated successfully.');
    } catch (err) {
      console.error(err);
      showErr('Failed to update passcode. Please try again.');
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
    if (members.length === 0) {
      await saveMember("Husband", { lhdn: true, iras: true });
      await saveMember("Wife", { lhdn: true, iras: true });
    }
    await populateOwnerFilter();
    await renderOverviewCards();
  }

  async function populateOwnerFilter() {
    const members = await getMembers();
    const prevVal = ownerFilter.value || 'all';
    ownerFilter.innerHTML = `<option value="all">All Owners</option>` +
      members.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
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
          <div class="member-card lhdn-card" data-action="open-ledger" data-id="${m.id}" data-type="lhdn">
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
          <div class="member-card iras-card" data-action="open-ledger" data-id="${m.id}" data-type="iras">
            <div class="member-card-badge">IRAS · Singapore</div>
            <div class="member-card-name">${escapeHtml(m.name)}</div>
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
  }

  // ============================================================
  // Ledger Navigation
  // ============================================================
  async function openLedger(memberId, type, opts = {}) {
    ledgerMemberId = memberId;
    ledgerType = type;
    currentMemberId = memberId;

    overviewView.style.display = 'none';
    ledgerView.style.display = 'block';

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
      return `
        <div class="member-row">
          <input type="text" value="${escapeHtml(m.name)}" id="memberName_${m.id}">
          <input type="number" value="${m.birthYear || ''}" id="memberBirthYear_${m.id}" placeholder="Birth year" style="width: 110px;">
          <label><input type="checkbox" id="memberLhdn_${m.id}" ${t.lhdn ? 'checked' : ''}> LHDN</label>
          <label><input type="checkbox" id="memberIras_${m.id}" ${t.iras ? 'checked' : ''}> IRAS</label>
          <button class="btn btn-secondary" data-action="save-member-edits" data-id="${m.id}">Save</button>
          <button class="icon-btn delete" title="Delete Member" data-action="delete-member-entirely" data-id="${m.id}">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
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

    if (!name) { alert('Name cannot be empty.'); return; }
    if (!lhdn && !iras) { alert('Select at least one tax type: LHDN or IRAS.'); return; }

    await updateMemberInDB({ id, name, taxTypes: { lhdn, iras }, birthYear });
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
    if (ledgerMemberId === id) await backToOverview();

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
    memberSelect.innerHTML = members.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
    await updateQuickAddTypeOptions();
    document.getElementById('quickAddModal').classList.add('open');
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
    await openLedger(memberId, type, { autoExpandForm: true });
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
      lhdnAdjustedTax
    };

    if (recordId) {
      record.id = parseInt(recordId, 10);
    }

    await saveRecordToDB(record);
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

    const irasYearSubmit = irasYearSubmitVal !== '' ? parseInt(irasYearSubmitVal, 10) : null;
    const irasNoa = irasNoaVal !== '' ? irasNoaVal : null;
    const irasNoaIncome = irasNoaIncomeVal !== '' ? parseFloat(irasNoaIncomeVal) : null;
    const irasTaxPayment = irasTaxPaymentVal !== '' ? parseFloat(irasTaxPaymentVal) : null;

    const irasRecord = {
      memberId: currentMemberId,
      yearWorking: irasYearWorking,
      yearSubmit: irasYearSubmit,
      noa: irasNoa,
      noaIncome: irasNoaIncome,
      taxPayment: irasTaxPayment
    };

    if (irasRecordId) {
      irasRecord.id = parseInt(irasRecordId, 10);
    }

    await saveIrasRecordToDB(irasRecord);
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
      const lhdnYearStr = r.lhdnYear ? ` (Year ${r.lhdnYear})` : '';
      const lhdnBadge = `<span class="badge badge-lhdn">LHDN Adj${lhdnYearStr}</span>`;

      const sourcesList = r.sources.length > 0
        ? r.sources.map(s => `<div><strong>${escapeHtml(s.name)}:</strong> ${formatCurrency(s.amount, 'MYR')}</div>`).join('')
        : '';
      const sourcesCell = [sourcesList, hasLhdn ? lhdnBadge : ''].filter(Boolean).join('<br>')
        || '<span style="color: var(--text-muted);">-</span>';

      const hasYearSubmit = (r.yearSubmit !== null && r.yearSubmit !== undefined && !isNaN(r.yearSubmit));
      const hasTahunTaksiran = (r.tahunTaksiran !== null && r.tahunTaksiran !== undefined && !isNaN(r.tahunTaksiran));
      const submitLine = hasYearSubmit ? `Submit: ${r.yearSubmit}` : '';
      const yaBadge = hasTahunTaksiran ? `<span class="badge">YA ${r.tahunTaksiran}</span>` : '';
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

      const ageStr = currentMemberBirthYear ? `<br><small style="color: var(--text-muted);">Age: ${r.yearWorking - currentMemberBirthYear}</small>` : '';

      return `
        <tr>
          <td><strong>${r.yearWorking}</strong>${ageStr}</td>
          <td>${submitYaCell}</td>
          <td>${sourcesCell}</td>
          <td><strong>${formatCurrency(r.totalDerivedIncome, 'MYR')}</strong></td>
          <td><strong>${formatCurrency(effectiveDeclaredIncome, 'MYR')}</strong>${declaredDiffHtml}</td>
          <td style="color: var(--danger);">${taxAmountStr}</td>
          <td style="color: var(--success); font-weight: bold;">${formatCurrency(effectiveNet, 'MYR')}</td>
          <td class="no-print">
            <button class="icon-btn edit" title="Edit Record" data-action="edit-record" data-id="${r.id}">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button class="icon-btn delete" title="Delete Record" data-action="delete-record" data-id="${r.id}">
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

      const annualBreakdown = years.map(y => `<div><strong>${y}:</strong> ${formatCurrency(data.years[y], 'MYR')}</div>`).join('');

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

      const annualBreakdown = years.map(y => `<div><strong>${y}:</strong> ${formatCurrency(data.years[y], 'MYR')}</div>`).join('');

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
      const yearSubmitStr = (r.yearSubmit !== null && r.yearSubmit !== undefined && !isNaN(r.yearSubmit)) ? r.yearSubmit : '-';
      const noaStr = r.noa ? `<span class="badge badge-iras">${escapeHtml(r.noa)}</span>` : '<span style="color: var(--text-muted);">-</span>';
      const noaIncomeStr = (r.noaIncome !== null && r.noaIncome !== undefined) ? formatCurrency(r.noaIncome, 'SGD') : '-';
      const taxPaymentStr = (r.taxPayment !== null && r.taxPayment !== undefined) ? formatCurrency(r.taxPayment, 'SGD') : '-';
      const netIncome = (r.noaIncome || 0) - (r.taxPayment || 0);
      const netIncomeStr = (r.noaIncome !== null && r.noaIncome !== undefined) || (r.taxPayment !== null && r.taxPayment !== undefined)
        ? formatCurrency(netIncome, 'SGD') : '-';

      const ageStr = currentMemberBirthYear ? `<br><small style="color: var(--text-muted);">Age: ${r.yearWorking - currentMemberBirthYear}</small>` : '';

      return `
        <tr>
          <td><strong>${r.yearWorking}</strong>${ageStr}</td>
          <td>${yearSubmitStr}</td>
          <td>${noaStr}</td>
          <td>${noaIncomeStr}</td>
          <td style="color: var(--iras-red); font-weight: bold;">${taxPaymentStr}</td>
          <td style="color: var(--success); font-weight: bold;">${netIncomeStr}</td>
          <td class="no-print">
            <button class="icon-btn edit" title="Edit IRAS Record" data-action="edit-iras-record" data-id="${r.id}">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button class="icon-btn delete" title="Delete IRAS Record" data-action="delete-iras-record" data-id="${r.id}">
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
    backToOverviewBtn: () => backToOverview(),
    printLedgerBtn: () => printCurrentView(),
    toggleLhdnFormBtn: () => toggleLhdnForm(),
    cancelEditBtn: () => resetForm(),
    companyReportTableBtn: () => setCompanyReportView('table'),
    companyReportCardBtn: () => setCompanyReportView('card'),
    toggleIrasFormBtn: () => toggleIrasForm(),
    cancelIrasEditBtn: () => resetIrasForm(),
    addMemberBtn: () => addMemberFromModal(),
    closeMembersModalBtn: () => closeMembersModal(),
    closeQuickAddModalBtn: () => closeQuickAddModal(),
    quickAddGoBtn: () => quickAddGo(),
    closeChangePasscodeModalBtn: () => closeChangePasscodeModal(),
    changePasscodeBtn: () => handleChangePasscode(),
    closeExportModalBtn: () => closeExportModal(),
    performExportBtn: () => performExport(),
    closeImportPasscodeModalBtn: () => closeImportPasscodeModal(),
    decryptImportBtn: () => decryptAndImport(),
  };
  Object.entries(staticClickHandlers).forEach(([id, handler]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
    else console.warn(`Event wiring: #${id} not found in DOM.`);
  });

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
    }
  });

  // change listeners (formerly onchange="...")
  document.getElementById('importFileInput').addEventListener('change', importJSON);
  ownerFilter.addEventListener('change', renderOverviewCards);
  document.getElementById('quickAddMember').addEventListener('change', updateQuickAddTypeOptions);
  document.getElementById('exportEncryptToggle').addEventListener('change', updateExportModalView);

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
