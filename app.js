/* ═══════════════════════════════════════════════════
   ASG Commercial — Property Dashboard
   ═══════════════════════════════════════════════════ */

// ─── Auth ─────────────────────────────────────────
const AUTH_KEY     = 'asg_credentials';
const SESSION_KEY  = 'asg_session';

function getCredentials() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || { user: 'admin', pass: 'asg2024' }; }
  catch { return { user: 'admin', pass: 'asg2024' }; }
}

function getSession()  { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } }
function isLoggedIn()  { return getSession() !== null; }
function isAdmin()     { const s = getSession(); return s && s.type === 'admin'; }
function isAgentUser() { const s = getSession(); return s && s.type === 'agent'; }

// Maps a backend user record into the shape the rest of the app expects in sessionStorage.
function _sessionFromApiUser(u) {
  if (u.role === 'admin') {
    return { type: 'admin', userId: u.id, name: u.name };
  }
  return {
    type: 'agent',
    agentId: u.id,
    name: u.name,
    role: u.agentRole || '',
    perms: u.permissions || {},
    isTeamLeader: !!u.isTeamLeader,
    teamLeaderId: u.teamLeaderId || ''
  };
}

// Phase C: doLogin now calls the backend /api/auth/login.
// Falls back to legacy localStorage-only login when the API is unreachable
// (e.g. opening the file directly via file:// or the backend is down).
async function doLogin() {
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  const err  = document.getElementById('loginError');
  err.style.display = 'none';
  if (!user || !pass) { err.textContent = 'Please enter your username and password.'; err.style.display = 'block'; return; }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: user, password: pass })
    });
    if (res.ok) {
      const data = await res.json();
      const session = _sessionFromApiUser(data.user);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      document.getElementById('loginScreen').style.display = 'none';
      boot();
      return;
    }
    if (res.status === 401) {
      err.textContent = 'Incorrect username or password.';
      err.style.display = 'block';
      document.getElementById('loginPass').value = '';
      document.getElementById('loginPass').focus();
      return;
    }
    throw new Error('HTTP ' + res.status);
  } catch (netErr) {
    console.warn('[doLogin] Backend unreachable, falling back to localStorage:', netErr.message);
    return _legacyLocalStorageLogin(user, pass, err);
  }
}

function _legacyLocalStorageLogin(user, pass, err) {
  const creds = getCredentials();
  if (user === creds.user && pass === creds.pass) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ type: 'admin' }));
    document.getElementById('loginScreen').style.display = 'none';
    boot();
    return;
  }
  const agents = loadAgents();
  const agent  = agents.find(a => a.active && a.username === user && a.password === pass);
  if (agent) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ type: 'agent', agentId: agent.id, name: agent.name, role: agent.role || '', perms: agent.permissions || {}, isTeamLeader: !!agent.isTeamLeader, teamLeaderId: agent.teamLeaderId || '' }));
    document.getElementById('loginScreen').style.display = 'none';
    boot();
    return;
  }
  err.textContent = 'Incorrect username or password. Please try again.';
  err.style.display = 'block';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginPass').focus();
}

async function doLogout() {
  if (!confirm('Sign out of ASG Commercial?')) return;
  // Best-effort: tell the backend to destroy the session, but don't block on failure.
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (e) {
    console.warn('[doLogout] Backend unreachable:', e.message);
  }
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
}

function openChangePass() {
  document.getElementById('cpCurrent').value = '';
  document.getElementById('cpUser').value    = getCredentials().user;
  document.getElementById('cpNew').value     = '';
  document.getElementById('cpConfirm').value = '';
  const err = document.getElementById('cpError');
  err.style.display = 'none';
  document.getElementById('changePassOverlay').classList.add('active');
}

function closeChangePass() {
  document.getElementById('changePassOverlay').classList.remove('active');
}

function doChangePass() {
  const current = document.getElementById('cpCurrent').value;
  const newUser = document.getElementById('cpUser').value.trim();
  const newPass = document.getElementById('cpNew').value;
  const confirm = document.getElementById('cpConfirm').value;
  const creds   = getCredentials();
  const err     = document.getElementById('cpError');
  err.style.display = 'none';

  if (current !== creds.pass) { err.textContent = 'Current password is incorrect.'; err.style.display = 'block'; return; }
  if (!newUser)                { err.textContent = 'Username cannot be empty.'; err.style.display = 'block'; return; }
  if (newPass.length < 6)      { err.textContent = 'New password must be at least 6 characters.'; err.style.display = 'block'; return; }
  if (newPass !== confirm)     { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }

  localStorage.setItem(AUTH_KEY, JSON.stringify({ user: newUser, pass: newPass }));
  closeChangePass();
  showToast('Credentials updated successfully', 'success');
}

// ─── IndexedDB (file + media storage) ────────────
const IDB_NAME    = 'asg_files_db';
const IDB_VERSION = 1;
const IDB_STORE   = 'files';
let idb = null;

function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(IDB_STORE))
        d.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = e => { idb = e.target.result; res(); };
    req.onerror   = () => rej(req.error);
  });
}

function idbPut(id, file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ id, name: file.name, mime: file.type, data: e.target.result });
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    };
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

function idbGet(id) {
  return new Promise((res, rej) => {
    const tx  = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function idbDel(id) {
  return new Promise((res, rej) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}

// ─── LocalStorage (property data) ────────────────
// ─── Income helpers: account for partnership share & deductions ────
// Returns YOUR share of the NET annual rent for a property.
// Net = annualRent − all per-property deductions (floored at 0).
//   - own:        100% of net
//   - partnership: ourShare% of net
//   - management:  0 (you don't earn rent on managed; mgmtFee instead)
function totalDeductions(p) {
  if (!p) return 0;
  return (Number(p.landCharges)         || 0)
       + (Number(p.licenseFees)         || 0)
       + (Number(p.serviceCharges)      || 0)
       + (Number(p.dewaCharges)         || 0)
       + (Number(p.ejariFees)           || 0)
       + (Number(p.civilDefenseCharges) || 0)
       + (Number(p.legalFee)            || 0)
       + (Number(p.corporateTax)        || 0);
}
function ourRentShare(p) {
  if (!p) return 0;
  const rent = Number(p.annualRent) || 0;
  const net  = Math.max(0, rent - totalDeductions(p));
  if (p.ownership === 'management') return 0;
  if (p.ownership === 'partnership') {
    const share = Number(p.ourShare) || 0;
    return net * share / 100;
  }
  return net;
}

// ─── Generic API-backed list factory ──────────────────────
// Replaces localStorage list-of-objects storage with a backend API while
// keeping the same sync interface (load/save) for legacy callers. Each
// `save(arr)` call diffs against the previous cache and fires the right
// CRUD operations against the API in the background.
//
//   const x = makeApiList('/api/leads', 'leads');
//   x.load()                   → cached array (sync)
//   await x.fetch()            → refresh cache from server
//   x.save(arr)                → optimistic cache update + background sync
function makeApiList(endpoint, pluralKey) {
  let cache = [];
  return {
    // Return a shallow copy so callers can mutate freely without
    // corrupting the cache. (Without this copy, code like
    //   const arr = loadTasks(); arr.push(newTask); saveTasks(arr);
    // ends up mutating the cache before save() can diff it, and the
    // "new" item is silently treated as already-present — no POST.)
    load: () => cache.slice(),
    fetch: async () => {
      try {
        const r = await fetch(endpoint, { credentials: 'same-origin' });
        if (!r.ok) return cache;
        const d = await r.json();
        cache = (d[pluralKey] || []).map(x => ({
          ...x,
          id: x.id != null ? String(x.id) : x.id,
        }));
        return cache;
      } catch (e) {
        console.warn(`[api-list ${endpoint}] fetch failed:`, e.message);
        return cache;
      }
    },
    save: async (arr) => {
      const before = new Map(cache.map(x => [String(x.id), x]));
      const after  = new Map(arr.map(x => [String(x.id), x]));
      cache = arr;  // optimistic: subsequent loads see new state immediately

      const errors = [];
      // Deletes
      for (const [id] of before) {
        if (!after.has(id) && /^\d+$/.test(id)) {
          try {
            const r = await fetch(`${endpoint}/${id}`, { method: 'DELETE', credentials: 'same-origin' });
            if (!r.ok) {
              const e = await r.json().catch(() => ({}));
              errors.push(`Delete ${id} failed: ${e.error || 'HTTP ' + r.status}`);
            }
          } catch (e) {
            errors.push(`Delete ${id} error: ${e.message}`);
          }
        }
      }
      // Creates / updates
      for (const [id, item] of after) {
        if (!before.has(id)) {
          try {
            const r = await fetch(endpoint, {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(item),
            });
            if (!r.ok) {
              const e = await r.json().catch(() => ({}));
              errors.push(`Create failed: ${e.error || 'HTTP ' + r.status}`);
            }
          } catch (e) {
            errors.push(`Create error: ${e.message}`);
          }
        } else if (/^\d+$/.test(id)) {
          try {
            const r = await fetch(`${endpoint}/${id}`, {
              method: 'PATCH', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(item),
            });
            if (!r.ok) {
              const e = await r.json().catch(() => ({}));
              errors.push(`Update ${id} failed: ${e.error || 'HTTP ' + r.status}`);
            }
          } catch (e) {
            errors.push(`Update ${id} error: ${e.message}`);
          }
        }
      }

      if (errors.length) {
        // Re-sync cache from server so UI reflects reality, not the optimistic state
        try {
          const r = await fetch(endpoint, { credentials: 'same-origin' });
          if (r.ok) {
            const d = await r.json();
            cache = (d[pluralKey] || []).map(x => ({ ...x, id: x.id != null ? String(x.id) : x.id }));
          }
        } catch {}
        const msg = `Save partially failed: ${errors[0]}${errors.length > 1 ? ` (+${errors.length-1} more)` : ''}`;
        console.warn(`[api-list ${endpoint}]`, errors.join('; '));
        if (typeof showToast === 'function') showToast(msg, 'error');
      }
    },
  };
}

// All API-backed lists. Each replaces a previous localStorage entity.
const _api = {
  disputes:        makeApiList('/api/disputes',                'disputes'),
  construction:    makeApiList('/api/construction',            'projects'),
  leads:           makeApiList('/api/leads',                   'leads'),
  tasks:           makeApiList('/api/tasks',                   'tasks'),
  pending:         makeApiList('/api/pending-properties',      'submissions'),
  announcements:   makeApiList('/api/announcements',           'announcements'),
  leaves:          makeApiList('/api/leaves',                  'leaves'),
  proposals:       makeApiList('/api/proposals',               'proposals'),
  meetings:        makeApiList('/api/meetings',                'meetings'),
  offplanDevs:     makeApiList('/api/offplan/developers',      'developers'),
  offplanProjects: makeApiList('/api/offplan/projects',        'projects'),
  secondary:       makeApiList('/api/secondary',               'listings'),
  users:           makeApiList('/api/users',                   'users'),
  calendar:        makeApiList('/api/calendar',                'events'),
};

async function fetchAllEntities() {
  await Promise.all(Object.values(_api).map(api => api.fetch().catch(() => null)));
}

// ─── Properties: API-backed with sync cache ───────────────
// Properties are now stored server-side in the SQLite DB and fetched via the
// REST API. We keep an in-memory cache so existing sync callers (loadProps()
// in 45+ places) keep working without each one becoming async. The cache is
// populated by fetchProperties() at boot and after every write.
let _propsCache = [];

async function fetchProperties() {
  try {
    const res = await fetch('/api/properties', { credentials: 'same-origin' });
    if (!res.ok) {
      console.warn('[fetchProperties] HTTP', res.status);
      return _propsCache;
    }
    const data = await res.json();
    _propsCache = (data.properties || []).map(p => ({
      ...p,
      // Frontend uses camelCase already; rowToApi converts snake_case → camelCase.
      // Ensure id is always a string so existing string-comparison code keeps working.
      id: p.id != null ? String(p.id) : p.id,
    }));
    // Hydrate cheques into the cache so the Rentals tab and other places that
    // read p.cheques have data without one fetch per property.
    try {
      const cr = await fetch('/api/properties/cheques/all', { credentials: 'same-origin' });
      if (cr.ok) {
        const { cheques } = await cr.json();
        const byProp = new Map();
        for (const c of (cheques || [])) {
          const pid = String(c.propertyId);
          if (!byProp.has(pid)) byProp.set(pid, []);
          byProp.get(pid).push({
            n:        c.chequeNum,
            noText:   c.chequeNoText || '',
            date:     c.chequeDate,
            amount:   c.amount,
            status:   c.status,
            lateFees: c.lateFees || null,
          });
        }
        _propsCache.forEach(p => { p.cheques = byProp.get(String(p.id)) || []; });
      }
    } catch (e) {
      console.warn('[fetchProperties] cheque hydration failed:', e.message);
    }
    return _propsCache;
  } catch (err) {
    console.error('[fetchProperties] failed:', err);
    return _propsCache;
  }
}

function loadProps() { return _propsCache; }

// API write helpers. Each one updates the backend, then refreshes the cache
// so subsequent loadProps() reflects the change.
async function apiCreateProperty(prop) {
  const res = await fetch('/api/properties', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prop),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Create failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  await fetchProperties();
  return data.property;
}

async function apiUpdateProperty(id, updates) {
  const res = await fetch(`/api/properties/${id}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Update failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  await fetchProperties();
  return data.property;
}

async function apiDeleteProperty(id) {
  const res = await fetch(`/api/properties/${id}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Delete failed: HTTP ${res.status}`);
  }
  await fetchProperties();
}

// ─── Property Files API helpers ───────────────────────
async function apiUploadPropertyFile(propertyId, category, file) {
  const fd = new FormData();
  fd.append('category', category);
  fd.append('file', file);
  const res = await fetch(`/api/properties/${propertyId}/files`, {
    method: 'POST',
    credentials: 'same-origin',
    body: fd,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed: HTTP ${res.status}`);
  }
  return (await res.json()).file;
}

async function apiListPropertyFiles(propertyId) {
  const res = await fetch(`/api/properties/${propertyId}/files`, { credentials: 'same-origin' });
  if (!res.ok) return [];
  return (await res.json()).files || [];
}

async function apiDeletePropertyFile(propertyId, fileId) {
  const res = await fetch(`/api/properties/${propertyId}/files/${fileId}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  return res.ok;
}

// ─── Cheque-only edit modal (used by Rentals tab) ─────
let _chequeEditPropertyId = null;

async function openChequeEditModal(propertyId) {
  _chequeEditPropertyId = String(propertyId);
  const p = loadProps().find(x => String(x.id) === _chequeEditPropertyId);
  if (!p) { showToast('Property not found', 'error'); return; }

  document.getElementById('chequeEditPropName').textContent = p.name || '';
  const cheques = (p.cheques || []).slice();
  document.getElementById('chequeEditCount').value = cheques.length || (Number(p.numCheques) || 0);
  renderChequeEditFields(cheques);
  const ov = document.getElementById('chequeEditOverlay');
  ov.style.display = '';
  ov.classList.add('active');
}

function closeChequeEditModal() {
  const ov = document.getElementById('chequeEditOverlay');
  ov.classList.remove('active');
  ov.style.display = 'none';
  _chequeEditPropertyId = null;
  if (typeof flushDeferredSseRefreshes === 'function') flushDeferredSseRefreshes();
}

function renderChequeEditFields(prefill) {
  const n = parseInt(document.getElementById('chequeEditCount').value, 10) || 0;
  const container = document.getElementById('chequeEditFields');
  if (!container) return;

  // Capture existing values before re-rendering
  const existing = [];
  container.querySelectorAll('.cheque-row').forEach((row, i) => {
    existing[i] = {
      noText:    row.querySelector('.cheque-no-text')?.value || '',
      date:      row.querySelector('.cheque-date')?.value    || '',
      amount:    row.querySelector('.cheque-amount')?.value  || '',
      status:    row.querySelector('.cheque-status')?.value  || 'pending',
      lateFees:  row.querySelector('.cheque-fees')?.value    || '',
    };
  });
  if (prefill && prefill.length) {
    prefill.forEach((c, i) => {
      existing[i] = {
        noText:   c.chequeNoText || c.noText || '',
        date:     c.date   || c.chequeDate || '',
        amount:   c.amount != null ? String(c.amount) : '',
        status:   c.status || 'pending',
        lateFees: c.lateFees != null ? String(c.lateFees) : '',
      };
    });
  }

  if (!n) { container.innerHTML = '<p style="color:var(--text-3);font-size:13px;">No cheques. Increase the count above to add rows.</p>'; return; }
  let html = '<div class="cheque-table"><div class="cheque-head"><span>#</span><span>Cheque No.</span><span>Cheque Date</span><span>Amount (AED)</span><span>Status</span><span>Fees (AED)</span></div>';
  for (let i = 0; i < n; i++) {
    const prev = existing[i] || {};
    const showFees = prev.status === 'late' || prev.status === 'bounced';
    html += `<div class="cheque-row">
      <span class="cheque-num">${i + 1}</span>
      <input type="text" class="cheque-no-text" placeholder="e.g. 00012345" value="${prev.noText || ''}">
      <input type="date" class="cheque-date" value="${prev.date || ''}">
      <input type="number" class="cheque-amount" placeholder="e.g. 10,000" min="0" value="${prev.amount || ''}">
      <select class="cheque-status" onchange="onChequeStatusChange(this)">
        <option value="pending"  ${(!prev.status || prev.status==='pending')  ? 'selected':''}>⏳ Pending</option>
        <option value="received" ${prev.status==='received' ? 'selected':''}>✅ Received</option>
        <option value="late"     ${prev.status==='late'     ? 'selected':''}>⚠️ Late Submission</option>
        <option value="bounced"  ${prev.status==='bounced'  ? 'selected':''}>❌ Bounced</option>
      </select>
      <input type="number" class="cheque-fees" placeholder="${showFees ? 'fee amount' : '—'}" min="0" value="${prev.lateFees || ''}" ${showFees ? '' : 'disabled style="background:#f3f4f6;cursor:not-allowed;"'}>
    </div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

// Toggle fees input enabled when status is late/bounced
function onChequeStatusChange(selectEl) {
  const row = selectEl.closest('.cheque-row');
  if (!row) return;
  const fees = row.querySelector('.cheque-fees');
  if (!fees) return;
  const apply = (selectEl.value === 'late' || selectEl.value === 'bounced');
  fees.disabled = !apply;
  if (apply) {
    fees.placeholder = 'fee amount';
    fees.style.background = '';
    fees.style.cursor = '';
  } else {
    fees.value = '';
    fees.placeholder = '—';
    fees.style.background = '#f3f4f6';
    fees.style.cursor = 'not-allowed';
  }
}

async function saveChequeEdit() {
  const propId = _chequeEditPropertyId;
  if (!propId) return;
  if (typeof markLocalMutation === 'function') markLocalMutation();

  // Build cheques array from the form rows
  const rows = [];
  document.getElementById('chequeEditFields').querySelectorAll('.cheque-row').forEach((row, i) => {
    rows.push({
      n:        i + 1,
      noText:   row.querySelector('.cheque-no-text')?.value.trim() || null,
      date:     row.querySelector('.cheque-date')?.value           || null,
      amount:   Number(row.querySelector('.cheque-amount')?.value) || null,
      status:   row.querySelector('.cheque-status')?.value         || 'pending',
      lateFees: Number(row.querySelector('.cheque-fees')?.value)   || null,
    });
  });

  // Update num_cheques on the property + sync the cheque sub-resource
  try {
    await apiUpdateProperty(propId, { numCheques: rows.length });
    await apiSyncPropertyCheques(propId, rows);
    await fetchProperties();
    closeChequeEditModal();
    if (activeTab === 'payment') renderPayments();
    else if (activeTab === 'home') renderHome();
    else if (activeTab === 'financials') renderFinancials();
    else refresh();
    showToast('Cheques updated', 'success');
  } catch (e) {
    showToast(`Save failed: ${e.message}`, 'error');
  }
}

// ─── Property Cheques API ─────────────────────────────
async function apiListPropertyCheques(propertyId) {
  const res = await fetch(`/api/properties/${propertyId}/cheques`, { credentials: 'same-origin' });
  if (!res.ok) return [];
  return (await res.json()).cheques || [];
}

// Replace ALL cheques for a property with the given list (as built by the form).
// Form items: {n, date, amount, status}; API expects {chequeNum, chequeDate, amount, status}.
async function apiSyncPropertyCheques(propertyId, formCheques) {
  // 1) wipe existing — fire all deletes in parallel
  const existing = await apiListPropertyCheques(propertyId);
  await Promise.all(existing.map(c =>
    fetch(`/api/properties/${propertyId}/cheques/${c.id}`, {
      method: 'DELETE', credentials: 'same-origin',
    }).catch(() => {})
  ));
  // 2) create new from the form — fire all creates in parallel
  await Promise.all((formCheques || []).map(c =>
    fetch(`/api/properties/${propertyId}/cheques`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chequeNum:    c.n,
        chequeNoText: c.noText || null,
        chequeDate:   c.date || null,
        amount:       c.amount || null,
        status:       c.status || 'pending',
        lateFees:     c.lateFees || null,
      }),
    }).catch(() => {})
  ));
}

// Legacy persistProps shim. Some callers pass the entire mutated array.
// We update the cache *immediately* (so the next loadProps() returns the new
// state) and fire-and-forget the corresponding API calls in the background.
// Errors are logged but not rolled back — this matches the previous
// localStorage behavior, which also never failed.
function persistProps(arr) {
  const before = new Map(_propsCache.map(p => [String(p.id), p]));
  const after  = new Map(arr.map(p => [String(p.id), p]));
  _propsCache = arr;  // optimistic update — loadProps reflects new state immediately

  // Background sync to API
  (async () => {
    // Deletes
    for (const [id, _p] of before) {
      if (!after.has(id) && /^\d+$/.test(id)) {
        try { await apiDeleteProperty(id); }
        catch (e) { console.warn('persistProps: delete failed', id, e.message); }
      }
    }
    // Creates / updates
    for (const [id, p] of after) {
      if (!before.has(id)) {
        try { await apiCreateProperty(p); }
        catch (e) { console.warn('persistProps: create failed', e.message); }
      } else if (/^\d+$/.test(id)) {
        try { await apiUpdateProperty(id, p); }
        catch (e) { console.warn('persistProps: update failed', id, e.message); }
      }
    }
  })();

  if (typeof xlsyncQueueWrite === 'function' && !window._xlsyncIngesting) {
    xlsyncQueueWrite();
  }
}
function uid()             { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ─── State ────────────────────────────────────────
let pendingFiles      = { drec: null, ijari: null, ijari2: null, affection: null, tenancy: null, license: null, tenantlicense: null, addendum: null };
let pendingMedia      = [];           // new File objects to add
let existingMediaMeta = [];           // { id, name, mime } already saved
let removedMediaIds   = [];           // IDB ids to delete on save
let currentDetailId   = null;

// Lightbox state
let lbItems = [];   // { data, mime, name }
let lbIndex = 0;

// ─── Tab State ────────────────────────────────────
let activeTab        = 'warehouses';
let activeTypeFilter = 'warehouse';

// ─── Boot ─────────────────────────────────────────
async function boot() {
  const session = getSession();
  if (!session) { location.reload(); return; }

  // Tag the body so CSS can scope mobile-specific rules per user type
  document.body.classList.toggle('user-admin', session.type === 'admin');
  document.body.classList.toggle('user-agent', session.type === 'agent');

  if (session.type === 'admin') {
    document.getElementById('adminHeader').style.display    = '';
    document.getElementById('appBody').style.display        = '';
    document.getElementById('agentHeader').style.display    = 'none';
    document.getElementById('agentDashboard').style.display = 'none';
    await openIDB();
    await fetchProperties();   // hydrate cache from backend before first render
    await fetchAllEntities();
    bindUI();
    showTab('home');
    renderNavCounts(loadProps());
    setInterval(() => renderAlerts(loadProps()), 60000);
    renderAlerts(loadProps());
    updateApiStatusUI();
    setupMetaAutoSync();
  } else if (session.type === 'agent') {
    document.getElementById('adminHeader').style.display    = 'none';
    document.getElementById('appBody').style.display        = 'none';
    document.getElementById('agentHeader').style.display    = '';
    document.getElementById('agentDashboard').style.display = '';
    await fetchProperties();   // agents also need property cache
    await fetchAllEntities();
    showAgentTab('overview');
    updateAgentBadges();
  }
}

// ─── Event Bindings ───────────────────────────────
function bindUI() {
  $('addPropertyBtn').addEventListener('click', openAddModal);
  $('closePropertyModal').addEventListener('click', closeAddModal);
  $('cancelPropertyBtn').addEventListener('click', closeAddModal);
  $('savePropertyBtn').addEventListener('click', handleSave);

  $('closeDetailModal').addEventListener('click', closeDetailModal);
  $('closeDetailBtn').addEventListener('click', closeDetailModal);
  // editFromDetailBtn was removed from the detail modal — bind only if present (legacy guard).
  $('editFromDetailBtn')?.addEventListener('click', () => { closeDetailModal(); openEditModal(currentDetailId); });
  $('deletePropertyBtn').addEventListener('click', handleDelete);

  $('searchInput').addEventListener('input', refresh);
  $('filterStatus').addEventListener('change', refresh);
  $('filterOwnership').addEventListener('change', refresh);

  $('propertyModalOverlay').addEventListener('click', e => { if (e.target === $('propertyModalOverlay')) closeAddModal(); });
  $('detailModalOverlay').addEventListener('click',   e => { if (e.target === $('detailModalOverlay'))   closeDetailModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeLightbox(); closeAddModal(); closeDetailModal(); }
    if (e.key === 'ArrowLeft')  lightboxNav(-1);
    if (e.key === 'ArrowRight') lightboxNav(1);
  });
}

function $(id) { return document.getElementById(id); }

// ─── Tab Switching ────────────────────────────────
function showTab(tab) {
  activeTab = tab;
  const propTabs = ['warehouses', 'offices', 'residential'];
  const isPropTab = propTabs.includes(tab);

  const homeEl = $('homeView');         if (homeEl) homeEl.style.display = tab === 'home' ? '' : 'none';
  $('dashboardView').style.display    = isPropTab             ? '' : 'none';
  $('remindersView').style.display    = tab === 'reminders'    ? '' : 'none';
  $('calendarView').style.display     = tab === 'calendar'     ? '' : 'none';
  $('contractView').style.display     = tab === 'contract'     ? '' : 'none';
  $('disputesView').style.display     = tab === 'disputes'     ? '' : 'none';
  $('constructionView').style.display = tab === 'construction' ? '' : 'none';
  $('paymentView').style.display      = tab === 'payment'      ? '' : 'none';
  const proposalsEl = $('proposalsView'); if (proposalsEl) proposalsEl.style.display = tab === 'proposals' ? '' : 'none';
  $('mapView').style.display          = tab === 'map'          ? '' : 'none';
  $('teamView').style.display         = tab === 'team'         ? '' : 'none';
  const myTasksEl = $('myTasksView');   if (myTasksEl) myTasksEl.style.display = tab === 'mytasks' ? '' : 'none';
  $('financialsView').style.display   = tab === 'financials'   ? '' : 'none';

  ['Home','Warehouses','Offices','Residential','Reminders','Calendar','Contract','Disputes','Construction','Payment','Proposals','Map','MyTasks','Team','Financials'].forEach(t => {
    const el = $('tab' + t);
    if (el) el.classList.toggle('active', t.toLowerCase() === tab);
  });

  if (isPropTab) {
    const typeMap = { warehouses: 'warehouse', offices: 'office', residential: 'residential' };
    activeTypeFilter = typeMap[tab];
    refresh();
  }
  if (tab === 'home')         renderHome();
  if (tab === 'reminders')    renderReminders();
  if (tab === 'calendar')     renderCalendar();
  if (tab === 'contract')     initContractTab();
  if (tab === 'disputes')     renderDisputes();
  if (tab === 'construction') renderProjects();
  if (tab === 'payment')      renderPayments();
  if (tab === 'proposals')    renderProposals();
  if (tab === 'map')          initMapTab();
  if (tab === 'team')         renderTeamTab();
  if (tab === 'mytasks')      renderMyTasks();
  if (tab === 'financials')   renderFinancials();
}

// ─── Contract Builder ─────────────────────────────
function initContractTab() {
  const sel = $('contractLoadProp');
  const props = loadProps();
  sel.innerHTML = '<option value="">— Auto-fill from property —</option>' +
    props.map(p => `<option value="${p.id}">${h(p.name)}</option>`).join('');
  if (!$('cf_date').value) $('cf_date').value = new Date().toISOString().split('T')[0];
}

function loadContractFromProperty(propId) {
  if (!propId) return;
  const p = loadProps().find(x => x.id === propId);
  if (!p) return;
  if (p.tenantName)  $('cf_tenant_name').value   = p.tenantName;
  if (p.tenantPhone) $('cf_tenant_phone').value   = p.tenantPhone;
  if (p.tenantEmail) $('cf_tenant_email').value   = p.tenantEmail;
  if (p.location)    $('cf_location').value       = p.location;
  if (p.type)        $('cf_property_type').value  = p.type === 'warehouse' ? 'Warehouse' : 'Office';
  if (p.size)        $('cf_property_area').value  = (p.size / 10.764).toFixed(1);
  if (p.annualRent)  { $('cf_annual_rent').value  = p.annualRent; $('cf_contract_value').value = p.annualRent; }
  if (p.leaseStart)  $('cf_from').value           = p.leaseStart;
  if (p.leaseEnd)    $('cf_to').value             = p.leaseEnd;
  const usageInput = document.querySelector('input[name="cf_usage"][value="Commercial"]');
  if (usageInput) usageInput.checked = true;
  showToast(`Filled from "${p.name}"`, 'success');
}

function clearContractForm() {
  ['cf_date','cf_owner_name','cf_lessor_name','cf_lessor_eid','cf_lessor_license','cf_lessor_auth',
   'cf_lessor_phone','cf_lessor_email','cf_tenant_name','cf_tenant_eid','cf_tenant_license',
   'cf_tenant_auth','cf_tenant_email','cf_tenant_phone','cf_cooccupants','cf_plot_no','cf_makani_no',
   'cf_building_name','cf_property_no','cf_property_type','cf_property_area','cf_location',
   'cf_dewa_no','cf_from','cf_to','cf_contract_value','cf_annual_rent','cf_security_deposit',
   'cf_payment_mode','cf_term_1','cf_term_2','cf_term_3','cf_term_4','cf_term_5'
  ].forEach(id => { if ($(id)) $(id).value = ''; });
  const usageInput = document.querySelector('input[name="cf_usage"][value="Commercial"]');
  if (usageInput) usageInput.checked = true;
  $('contractLoadProp').value = '';
  $('cf_date').value = new Date().toISOString().split('T')[0];
  showToast('Form cleared', 'success');
}

function getContractData() {
  return {
    date:            $('cf_date').value,
    ownerName:       $('cf_owner_name').value.trim(),
    lessorName:      $('cf_lessor_name').value.trim(),
    lessorEid:       $('cf_lessor_eid').value.trim(),
    lessorLicense:   $('cf_lessor_license').value.trim(),
    lessorAuth:      $('cf_lessor_auth').value.trim(),
    lessorPhone:     $('cf_lessor_phone').value.trim(),
    lessorEmail:     $('cf_lessor_email').value.trim(),
    tenantName:      $('cf_tenant_name').value.trim(),
    tenantEid:       $('cf_tenant_eid').value.trim(),
    tenantLicense:   $('cf_tenant_license').value.trim(),
    tenantAuth:      $('cf_tenant_auth').value.trim(),
    tenantEmail:     $('cf_tenant_email').value.trim(),
    tenantPhone:     $('cf_tenant_phone').value.trim(),
    coOccupants:     $('cf_cooccupants').value.trim(),
    propUsage:       document.querySelector('input[name="cf_usage"]:checked')?.value || 'Commercial',
    plotNo:          $('cf_plot_no').value.trim(),
    makaniNo:        $('cf_makani_no').value.trim(),
    buildingName:    $('cf_building_name').value.trim(),
    propertyNo:      $('cf_property_no').value.trim(),
    propertyType:    $('cf_property_type').value.trim(),
    propertyArea:    $('cf_property_area').value.trim(),
    location:        $('cf_location').value.trim(),
    dewaNo:          $('cf_dewa_no').value.trim(),
    contractFrom:    $('cf_from').value,
    contractTo:      $('cf_to').value,
    contractValue:   $('cf_contract_value').value.trim(),
    annualRent:      $('cf_annual_rent').value.trim(),
    securityDeposit: $('cf_security_deposit').value.trim(),
    paymentMode:     $('cf_payment_mode').value.trim(),
    term1:           $('cf_term_1').value.trim(),
    term2:           $('cf_term_2').value.trim(),
    term3:           $('cf_term_3').value.trim(),
    term4:           $('cf_term_4').value.trim(),
    term5:           $('cf_term_5').value.trim(),
  };
}

function fv(val) { return val || ''; }
function fmtAED(val) { return val ? 'AED ' + Number(val).toLocaleString() : ''; }
function fmtContractDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-AE', { day: '2-digit', month: 'long', year: 'numeric' });
}

function previewContract() {
  const d = getContractData();
  const html = generateContractHTML(d);
  const win = window.open('', '_blank');
  if (!win) { showToast('Please allow pop-ups to download PDF', 'error'); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 800);
}

function generateContractHTML(d) {
  // Normalise field names so this function matches buildAgentContractHTML
  const nd = {
    date:            d.date,
    ownerName:       d.ownerName,
    lessorName:      d.lessorName || d.ownerName,
    lessorEid:       d.lessorEid,
    lessorPhone:     d.lessorPhone,
    lessorEmail:     d.lessorEmail,
    lessorLicense:   d.lessorLicense,
    lessorAuthority: d.lessorAuth,
    tenantName:      d.tenantName,
    tenantEid:       d.tenantEid,
    tenantPhone:     d.tenantPhone,
    tenantEmail:     d.tenantEmail,
    tenantLicense:   d.tenantLicense,
    tenantAuthority: d.tenantAuth,
    usage:           d.propUsage || 'Commercial',
    plotNo:          d.plotNo,
    makaniNo:        d.makaniNo,
    buildingName:    d.buildingName,
    propertyNo:      d.propertyNo,
    propType:        d.propertyType,
    area:            d.propertyArea,
    location:        d.location,
    dewaNo:          d.dewaNo,
    from:            d.contractFrom,
    to:              d.contractTo,
    contractValue:   d.contractValue,
    annualRent:      d.annualRent,
    deposit:         d.securityDeposit,
    paymentMode:     d.paymentMode,
    add1: d.term1, add2: d.term2, add3: d.term3, add4: d.term4, add5: d.term5
  };
  return buildAgentContractHTML(nd);
}

function generateContractHTML_old_unused(d) {
  const usageCheck = u => d.propUsage === u
    ? '<span style="display:inline-block;width:12px;height:12px;border:1.5px solid #333;border-radius:50%;background:#111;margin-right:4px;vertical-align:middle;"></span>'
    : '<span style="display:inline-block;width:12px;height:12px;border:1.5px solid #333;border-radius:50%;margin-right:4px;vertical-align:middle;"></span>';

  const line = val => `<span style="display:inline-block;min-width:200px;border-bottom:1px solid #aaa;padding:0 4px;"> ${val || ''}</span>`;
  const row  = (label, val, labelAr) =>
    `<tr><td class="fl">${label}</td><td class="fv">${line(val)}</td><td class="far">${labelAr}</td></tr>`;

  const additionalTermsRows = [d.term1, d.term2, d.term3, d.term4, d.term5]
    .filter(t => t)
    .map((t, i) =>
      `<tr><td style="padding:6px 8px;border:1px solid #ccc;width:24px;font-weight:600;">${i+1}</td>
           <td style="padding:6px 8px;border:1px solid #ccc;">${h(t)}</td>
           <td style="padding:6px 8px;border:1px solid #ccc;width:24px;font-weight:600;">${i+1}</td></tr>`
    ).join('');

  const usageAr = { Residential: 'سكني', Commercial: 'تجاري', Industrial: 'صناعي' };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Tenancy Contract${d.tenantName ? ' — ' + d.tenantName : ''}</title>
<style>
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size: 10pt; color: #111; background: #fff; padding: 20px; }
  .page { max-width: 780px; margin: 0 auto; }
  .header { display:flex; justify-content:space-between; align-items:center; border-bottom: 3px double #c9a84c; padding-bottom:12px; margin-bottom:14px; }
  .header-logo { font-size:13pt; font-weight:800; color:#111; letter-spacing:1px; }
  .header-logo span { color:#c9a84c; }
  .header-dld { text-align:right; font-size:8pt; color:#555; }
  .contract-title { text-align:center; margin:14px 0; }
  .contract-title h1 { font-size:16pt; font-weight:800; letter-spacing:3px; color:#111; }
  .contract-title .ar { font-size:13pt; color:#555; margin-top:2px; }
  .contract-date { text-align:right; font-size:9pt; margin-bottom:12px; }
  .section { margin-bottom:12px; border:1px solid #c9a84c; border-radius:4px; overflow:hidden; }
  .section-head { background:#111; color:#fff; padding:6px 12px; display:flex; justify-content:space-between; align-items:center; }
  .section-head .en { font-weight:700; font-size:9.5pt; }
  .section-head .ar { font-size:9pt; color:#c9a84c; }
  table.fields { width:100%; border-collapse:collapse; }
  table.fields td { padding:5px 10px; vertical-align:middle; font-size:9pt; }
  td.fl  { width:30%; font-weight:600; color:#333; white-space:nowrap; }
  td.fv  { width:40%; }
  td.far { width:30%; text-align:right; color:#555; font-size:8.5pt; direction:rtl; }
  .usage-row { padding:8px 12px; display:flex; gap:24px; align-items:center; }
  .usage-item { display:flex; align-items:center; gap:6px; font-size:9.5pt; }
  .tc-section { margin-bottom:12px; }
  .tc-section .tc-head { background:#111; color:#fff; padding:6px 12px; display:flex; justify-content:space-between; border-radius:4px 4px 0 0; }
  .tc-section .tc-head .en { font-weight:700; font-size:9.5pt; }
  .tc-section .tc-head .ar { font-size:9pt; color:#c9a84c; }
  .tc-body { border:1px solid #c9a84c; border-top:none; border-radius:0 0 4px 4px; padding:10px 14px; }
  .tc-item { display:flex; gap:8px; margin-bottom:7px; font-size:8.5pt; line-height:1.5; }
  .tc-num { font-weight:700; min-width:18px; }
  .tc-ar { direction:rtl; text-align:right; color:#555; margin-top:4px; font-size:8pt; }
  .sig-section { margin-top:16px; }
  .sig-row { display:flex; gap:20px; justify-content:space-between; }
  .sig-box { flex:1; border:1px solid #ccc; border-radius:4px; padding:12px; text-align:center; min-height:80px; }
  .sig-box .sig-label { font-size:8.5pt; color:#555; margin-bottom:4px; }
  .sig-box .sig-label-ar { font-size:8pt; color:#888; }
  .sig-line { border-bottom:1px solid #ccc; height:40px; margin:8px 0 4px; }
  .sig-date { font-size:8pt; color:#777; }
  .additional-terms table { width:100%; border-collapse:collapse; }
  .footer-note { margin-top:14px; border-top:1px solid #ddd; padding-top:8px; font-size:7.5pt; color:#888; text-align:center; }
  .know-rights { margin-top:10px; background:#f9f6ee; border:1px solid #c9a84c; border-radius:4px; padding:8px 12px; font-size:8pt; }
  .know-rights h4 { font-size:9pt; margin-bottom:6px; display:flex; justify-content:space-between; }
  .ejari { margin-top:8px; background:#f0f0f0; border-radius:4px; padding:8px 12px; font-size:8pt; }
  .ejari h4 { font-size:9pt; margin-bottom:6px; display:flex; justify-content:space-between; }
  @media print {
    body { padding:0; font-size:9pt; }
    .page { max-width:100%; }
    @page { size: A4; margin: 14mm 12mm; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="header-logo">ASG <span>Commercial</span></div>
    <div class="contract-title">
      <h1>TENANCY CONTRACT</h1>
      <div class="ar">عـقـد إيـجـــار</div>
    </div>
    <div class="header-dld">
      دائرة الأراضي والأملاك<br>Land Department<br>
      <strong>Date: ${fmtContractDate(d.date)}</strong><br>
      <span style="direction:rtl;">التاريخ: ${fmtContractDate(d.date)}</span>
    </div>
  </div>

  <!-- Owner / Lessor -->
  <div class="section">
    <div class="section-head">
      <span class="en">Owner / Lessor Information</span>
      <span class="ar">معلومات المالك / المؤجر</span>
    </div>
    <table class="fields">
      ${row("Owner's Name", fv(d.ownerName), "اسم المالك")}
      ${row("Lessor's Name", fv(d.lessorName), "اسم المؤجر")}
      ${row("Lessor's Emirates ID", fv(d.lessorEid), "الهوية الإماراتية للمؤجر")}
      ${row("License No.", fv(d.lessorLicense), "رقم الرخصة")}
      ${row("Licensing Authority", fv(d.lessorAuth), "سلطة الترخيص")}
      ${row("Lessor's Email", fv(d.lessorEmail), "البريد الإلكتروني للمؤجر")}
      ${row("Lessor's Phone", fv(d.lessorPhone), "رقم هاتف المؤجر")}
    </table>
  </div>

  <!-- Tenant -->
  <div class="section">
    <div class="section-head">
      <span class="en">Tenant Information</span>
      <span class="ar">معلومات المستأجر</span>
    </div>
    <table class="fields">
      ${row("Tenant's Name", fv(d.tenantName), "اسم المستأجر")}
      ${row("Tenant's Emirates ID", fv(d.tenantEid), "الهوية الإماراتية للمستأجر")}
      ${row("License No.", fv(d.tenantLicense), "رقم الرخصة")}
      ${row("Licensing Authority", fv(d.tenantAuth), "سلطة الترخيص")}
      ${row("Tenant's Email", fv(d.tenantEmail), "البريد الإلكتروني للمستأجر")}
      ${row("Tenant's Phone", fv(d.tenantPhone), "رقم هاتف المستأجر")}
      ${row("Number of Co-Occupants", fv(d.coOccupants), "عدد القاطنين")}
    </table>
  </div>

  <!-- Property -->
  <div class="section">
    <div class="section-head">
      <span class="en">Property Information</span>
      <span class="ar">معلومات العقار</span>
    </div>
    <div class="usage-row">
      <span style="font-weight:600;font-size:9pt;">Property Usage — استخدام العقار:</span>
      <span class="usage-item">${usageCheck('Residential')} Residential — سكني</span>
      <span class="usage-item">${usageCheck('Commercial')} Commercial — تجاري</span>
      <span class="usage-item">${usageCheck('Industrial')} Industrial — صناعي</span>
    </div>
    <table class="fields">
      ${row("Plot No.", fv(d.plotNo), "رقم الأرض")}
      ${row("Makani No.", fv(d.makaniNo), "رقم مكاني")}
      ${row("Building Name", fv(d.buildingName), "اسم المبنى")}
      ${row("Property No.", fv(d.propertyNo), "رقم العقار")}
      ${row("Property Type", fv(d.propertyType), "نوع الوحدة")}
      ${row("Property Area (sq.m)", fv(d.propertyArea), "مساحة العقار (متر.مربع)")}
      ${row("Location", fv(d.location), "الموقع")}
      ${row("Premises No. (DEWA)", fv(d.dewaNo), "رقم المبنى (ديوا)")}
    </table>
  </div>

  <!-- Contract Info -->
  <div class="section">
    <div class="section-head">
      <span class="en">Contract Information</span>
      <span class="ar">معلومات العقد</span>
    </div>
    <table class="fields">
      <tr>
        <td class="fl">Contract Period — فترة العقد</td>
        <td class="fv">From ${line(fmtContractDate(d.contractFrom))} &nbsp; To ${line(fmtContractDate(d.contractTo))}</td>
        <td class="far">من — إلى</td>
      </tr>
      ${row("Contract Value — قيمة العقد", fmtAED(d.contractValue), "قيمة العقد")}
      ${row("Annual Rent — الايجار السنوي", fmtAED(d.annualRent), "الايجار السنوي")}
      ${row("Security Deposit — مبلغ التأمين", fmtAED(d.securityDeposit), "مبلغ التأمين")}
      ${row("Mode of Payment — طريقة الدفع", fv(d.paymentMode), "طريقة الدفع")}
    </table>
  </div>

  <!-- Terms & Conditions -->
  <div class="tc-section">
    <div class="tc-head">
      <span class="en">Terms and Conditions</span>
      <span class="ar">الأحكام و الشروط</span>
    </div>
    <div class="tc-body">
      <div class="tc-item"><span class="tc-num">1.</span><span>The tenant has inspected the premises and agreed to lease the unit on its current condition.</span></div>
      <div class="tc-item"><span class="tc-num">2.</span><span>Tenant undertakes to use the premises for designated purpose. Tenant has no rights to transfer or relinquish the tenancy contract either with or without counterpart to any party without landlord written approval. Also, tenant is not allowed to sublease the premises or any part thereof to third party in whole or in part unless it is legally permitted.</span></div>
      <div class="tc-item"><span class="tc-num">3.</span><span>The tenant undertakes not to make any amendments, modifications or addendums to the premises subject of the contract without obtaining the landlord written approval. Tenant shall be liable for any damages or failure due to that.</span></div>
      <div class="tc-item"><span class="tc-num">4.</span><span>The tenant shall be responsible for payment of all electricity, water, cooling and gas charges resulting of occupying leased unit unless other condition agreed in written.</span></div>
      <div class="tc-item"><span class="tc-num">5.</span><span>The tenant must pay the rent amount in the manner and dates agreed with the landlord.</span></div>
      <div class="tc-item"><span class="tc-num">6.</span><span>The tenant fully undertakes to comply with all the regulations and instructions related to the management of the property and the use of the premises and of common areas.</span></div>
      <div class="tc-item"><span class="tc-num">7.</span><span>Tenancy contract parties declare all mentioned email addresses and phone numbers are correct, all formal and legal notifications will be sent to those addresses in case of dispute between parties.</span></div>
      <div class="tc-item"><span class="tc-num">8.</span><span>The landlord undertakes to enable the tenant of the full use of the premises including its facilities and do the regular maintenance as intended unless other condition agreed in written.</span></div>
      <div class="tc-item"><span class="tc-num">9.</span><span>By signing this agreement, the "Landlord" hereby confirms and undertakes that he is the current owner of the property or his legal representative under legal power of attorney duly entitled by the competent authorities.</span></div>
      <div class="tc-item"><span class="tc-num">10.</span><span>Any disagreement or dispute may arise from execution or interpretation of this contract shall be settled by the Rental Dispute Center.</span></div>
      <div class="tc-item"><span class="tc-num">11.</span><span>This contract is subject to all provisions of Law No (26) of 2007 regulating the relation between landlords and tenants in the emirate of Dubai as amended, and as it will be changed or amended from time to time, as long with any related legislations and regulations applied in the emirate of Dubai.</span></div>
      <div class="tc-item"><span class="tc-num">12.</span><span>Any additional condition will not be considered in case it conflicts with law.</span></div>
      <div class="tc-item"><span class="tc-num">13.</span><span>In case of discrepancy occurs between Arabic and non-Arabic texts with regards to the interpretation of this agreement or the scope of its application, the Arabic text shall prevail.</span></div>
      <div class="tc-item"><span class="tc-num">14.</span><span>The landlord undertakes to register this tenancy contract on EJARI affiliated to Dubai Land Department and provide with all required documents.</span></div>
    </div>
  </div>

  <!-- Signatures Page 1 -->
  <div class="sig-section">
    <div class="sig-row">
      <div class="sig-box">
        <div class="sig-label">Lessor's Signature — <span class="sig-label-ar">توقيع المؤجر</span></div>
        <div class="sig-line"></div>
        <div class="sig-date">Date التاريخ: ____________________</div>
      </div>
      <div class="sig-box">
        <div class="sig-label">Tenant's Signature — <span class="sig-label-ar">توقيع المستأجر</span></div>
        <div class="sig-line"></div>
        <div class="sig-date">Date التاريخ: ____________________</div>
      </div>
    </div>
  </div>

  ${additionalTermsRows ? `
  <!-- Additional Terms -->
  <div class="tc-section additional-terms" style="margin-top:14px;">
    <div class="tc-head">
      <span class="en">Additional Terms</span>
      <span class="ar">شروط إضافية</span>
    </div>
    <div class="tc-body" style="padding:0;">
      <table style="width:100%;border-collapse:collapse;">
        ${additionalTermsRows}
      </table>
    </div>
  </div>` : ''}

  <!-- Know Your Rights -->
  <div class="know-rights" style="margin-top:14px;">
    <h4><span>Know Your Rights</span><span style="direction:rtl;">لمعرفة حقوق الأطراف</span></h4>
    <div style="display:flex;gap:20px;">
      <ul style="list-style:disc;padding-left:16px;line-height:1.8;">
        <li>You may visit Rental Dispute Center website through <strong>www.dubailand.gov.ae</strong></li>
        <li>Law No 26 of 2007 regulating relationship between landlords and tenants.</li>
        <li>Law No 33 of 2008 amending law 26 of year 2007.</li>
        <li>Law No 43 of 2013 determining rent increases for properties.</li>
      </ul>
    </div>
  </div>

  <!-- Ejari -->
  <div class="ejari">
    <h4><span>Attachments for Ejari Registration</span><span style="direction:rtl;">مرفقات التسجيل في إيجاري</span></h4>
    <ol style="padding-left:16px;line-height:1.8;">
      <li>Original unified tenancy contract — نسخة أصلية عن عقد الايجار الموحد</li>
      <li>Original emirates ID of applicant — الهوية الإماراتية الأصلية لمقدم الطلب</li>
    </ol>
  </div>

  <!-- Final Signatures -->
  <div class="sig-section" style="margin-top:14px;">
    <div class="sig-row">
      <div class="sig-box">
        <div class="sig-label">Lessor's Signature — <span class="sig-label-ar">توقيع المؤجر</span></div>
        <div class="sig-line"></div>
        <div class="sig-date">Date التاريخ: ____________________</div>
      </div>
      <div class="sig-box">
        <div class="sig-label">Tenant's Signature — <span class="sig-label-ar">توقيع المستأجر</span></div>
        <div class="sig-line"></div>
        <div class="sig-date">Date التاريخ: ____________________</div>
      </div>
    </div>
  </div>

  <div class="footer-note">
    Note: You may add addendum to this tenancy contract in case you have additional terms while it needs to be signed by all parties.<br>
    ملاحظة: يمكن إضافة ملحق إلى هذا العقد في حال وجود أي شروط إضافية، على أن يوقع من أطراف التعاقد.
  </div>

</div>
</body>
</html>`;
}

// ─── Render Pipeline ──────────────────────────────
function refresh() {
  const all      = loadProps();
  const filtered = applyFilters(all);
  renderStats(all);
  renderNavCounts(all);
  renderAlerts(all);
  renderReminderBadge(all);
  renderGrid(filtered);
  if (activeTab === 'reminders') renderReminders();
}

function applyFilters(props) {
  const q          = $('searchInput').value.toLowerCase().trim();
  const statusF    = $('filterStatus').value;
  const ownershipF = $('filterOwnership').value;
  return props.filter(p => {
    if (q && !`${p.name} ${p.location||''} ${p.tenantName||''}`.toLowerCase().includes(q)) return false;
    if (activeTypeFilter && p.type !== activeTypeFilter) return false;
    if (statusF    && p.status    !== statusF)    return false;
    if (ownershipF && p.ownership !== ownershipF) return false;
    return true;
  });
}

function renderStats(props) {
  const tf      = activeTypeFilter;
  const typed   = tf ? props.filter(p => p.type === tf) : props;
  const revenue = typed.filter(p => p.status === 'rented').reduce((s, p) => s + ourRentShare(p), 0);
  const area    = typed.reduce((s, p) => s + (Number(p.size)||0), 0);
  const icons   = { warehouse: '🏭', office: '🏢', residential: '🏠' };
  const labels  = { warehouse: 'Warehouses', office: 'Offices', residential: 'Residential' };
  if ($('statTypeIcon'))   $('statTypeIcon').textContent   = icons[tf]  || '🏗️';
  if ($('statTotalLabel')) $('statTotalLabel').textContent = labels[tf] || 'All Properties';
  $('statTotal').textContent     = typed.length;
  $('statRented').textContent    = typed.filter(p => p.status === 'rented').length;
  $('statVacant').textContent    = typed.filter(p => p.status === 'vacant').length;
  $('statManaged').textContent   = typed.filter(p => p.ownership === 'management').length;
  $('statRevenue').textContent   = revenue ? 'AED ' + revenue.toLocaleString() : 'AED 0';
  $('statTotalArea').textContent = area ? area.toLocaleString() : '0';
}

function renderNavCounts(props) {
  props = props || loadProps();
  const wEl = $('navCountWarehouses');
  const oEl = $('navCountOffices');
  const rEl = $('navCountResidential');
  if (wEl) wEl.textContent = props.filter(p => p.type === 'warehouse').length  || '';
  if (oEl) oEl.textContent = props.filter(p => p.type === 'office').length     || '';
  if (rEl) rEl.textContent = props.filter(p => p.type === 'residential').length || '';
  updateTaskBadge();
}

function renderAlerts(props) {
  const banner = $('alertBanner');
  if (!banner) return;

  // Hidden for this session?
  if (sessionStorage.getItem('asg_alerts_dismissed') === '1') {
    banner.style.display = 'none';
    return;
  }

  const today = new Date();
  const items = props
    .filter(p => p.status === 'rented' && p.leaseEnd)
    .map(p => {
      const days = Math.ceil((new Date(p.leaseEnd) - today) / 86400000);
      const threshold = Number(p.reminderDays) || 60;
      return { p, days, threshold };
    })
    .filter(x => x.days <= x.threshold)
    .sort((a, b) => a.days - b.days);

  if (!items.length) { banner.style.display = 'none'; return; }

  const expired = items.filter(x => x.days <= 0);
  const soon    = items.filter(x => x.days > 0);

  // Show up to 2 most-critical items inline
  const critical = items.slice(0, 2).map(x => {
    const isExp = x.days <= 0;
    const label = isExp
      ? `expired ${Math.abs(x.days)}d ago`
      : `${x.days}d left`;
    const cls = isExp ? 'al-pill al-pill-exp' : (x.days <= 14 ? 'al-pill al-pill-warn' : 'al-pill');
    return `<span class="${cls}" onclick="event.stopPropagation();openDetailModal('${x.p.id}')">
              <strong>${h(x.p.name)}</strong> · ${label}
            </span>`;
  }).join('');

  const moreCount = items.length - 2;

  banner.style.display = 'flex';
  banner.innerHTML = `
    <div class="al-left">
      <span class="al-icon">🔔</span>
      <div class="al-summary">
        <span class="al-title">Lease Alerts</span>
        <span class="al-counts">
          ${expired.length ? `<span class="al-c-exp">${expired.length} expired</span>` : ''}
          ${expired.length && soon.length ? `<span class="al-dot">·</span>` : ''}
          ${soon.length ? `<span class="al-c-soon">${soon.length} expiring soon</span>` : ''}
        </span>
      </div>
    </div>
    <div class="al-mid">${critical}${moreCount > 0 ? `<span class="al-more">+${moreCount} more</span>` : ''}</div>
    <div class="al-right">
      <button class="al-cta" onclick="showTab('reminders')">View All
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
      <button class="al-close" onclick="dismissAlertBanner()" title="Hide for this session">×</button>
    </div>
  `;
}

function dismissAlertBanner() {
  sessionStorage.setItem('asg_alerts_dismissed', '1');
  const b = $('alertBanner');
  if (b) b.style.display = 'none';
}

function renderGrid(props) {
  const grid  = $('propertiesGrid');
  const empty = $('emptyState');
  if (!props.length) {
    grid.innerHTML = '';
    const icons  = { warehouse: '🏭', office: '🏢', residential: '🏠' };
    const labels = { warehouse: 'Warehouses', office: 'Offices', residential: 'Residential Properties' };
    const icon   = icons[activeTypeFilter]  || '🏗️';
    const label  = labels[activeTypeFilter] || 'Properties';
    const el = empty.querySelector('.empty-icon');
    const h3 = empty.querySelector('h3');
    const p  = empty.querySelector('p');
    if (el) el.textContent = icon;
    if (h3) h3.textContent = `No ${label} Added Yet`;
    if (p)  p.textContent  = `Add your first ${label.toLowerCase().replace(' properties','')} to get started.`;
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = props.map(cardHTML).join('');
  props.forEach(p => { if (p.media?.length) loadCardMedia(p); });
}

// ─── Property Card ────────────────────────────────
function cardHTML(p) {
  const typeIcon = p.type === 'warehouse' ? '🏭' : '🏢';
  const today    = new Date();
  const reminderThreshold = Number(p.reminderDays) || 60;
  let leaseBadge = '';
  if (p.status === 'rented' && p.leaseEnd) {
    const days = Math.ceil((new Date(p.leaseEnd) - today) / 86400000);
    if      (days < 0)                    leaseBadge = `<span class="lease-badge lease-expired">Expired</span>`;
    else if (days <= reminderThreshold)   leaseBadge = `<span class="lease-badge lease-warning">${days}d left</span>`;
    else                                  leaseBadge = `<span class="lease-badge lease-ok">${days}d left</span>`;
  }

  const ownershipChip = p.ownership === 'partnership'
    ? `<span class="chip chip-partnership">🤝 Partnership ${p.ourShare ? p.ourShare+'%' : ''}</span>`
    : p.ownership === 'own'        ? `<span class="chip chip-on">✓ Own</span>`
    : p.ownership === 'management' ? `<span class="chip chip-management">📋 Managed</span>`
    : '';
  const agentSourcedChip = p.addedByAgent
    ? `<span class="chip chip-agent-sourced" title="Sourced by ${h(p.addedByAgentName||'agent')}">⭐ ${h(p.addedByAgentName||'Agent')}</span>`
    : '';

  const mapChip = p.mapLink
    ? `<span class="chip chip-map" onclick="event.stopPropagation();window.open('${p.mapLink}','_blank')">🗺 Map</span>`
    : '';

  const mediaStrip = p.media?.length
    ? `<div class="card-media-strip count-${Math.min(p.media.length, 3)}" id="strip-${p.id}">
        ${p.media.slice(0, 3).map((m, i) =>
          isVideo(m.mime)
            ? `<video id="strip-${p.id}-${i}" muted></video>`
            : `<img id="strip-${p.id}-${i}" alt="">`
        ).join('')}
        ${p.media.length > 3 ? `<div class="card-media-more">+${p.media.length - 3}</div>` : ''}
      </div>`
    : '';

  const cardWaHref = waLink(p.tenantPhone, p.tenantName, p.name);
  const tenantSection = (p.status === 'rented' && p.tenantName) ? `
    <hr class="card-divider">
    <div class="card-tenant">
      <div class="tenant-left">
        <div class="tenant-avatar">${p.tenantName.charAt(0).toUpperCase()}</div>
        <div>
          <div class="tenant-name">${h(p.tenantName)}</div>
          <div class="tenant-dates">${fmtDate(p.leaseStart)} → ${fmtDate(p.leaseEnd)}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${cardWaHref ? `<a href="${cardWaHref}" target="_blank" class="card-wa-btn" onclick="event.stopPropagation()" title="WhatsApp ${h(p.tenantName)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.126 1.533 5.858L.057 23.5l5.797-1.452A11.943 11.943 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.891 0-3.667-.498-5.2-1.37l-.373-.22-3.44.861.92-3.352-.242-.386A9.944 9.944 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg></a>` : ''}
        ${leaseBadge}
      </div>
    </div>` : '';

  const vacantBanner = p.status === 'vacant'
    ? `<div style="padding:6px 10px;background:var(--danger-bg);border-radius:6px;font-size:12px;font-weight:600;color:var(--danger);text-align:center;">🔓 Vacant — Available for Rent${p.annualRent ? ' · Asking AED '+num(p.annualRent) : ''}</div>`
    : '';

  return `
    <div class="property-card${p.status === 'vacant' ? ' card-vacant' : ''}" onclick="openDetailModal('${p.id}')">
      <div class="card-header">
        <div class="card-header-top">
          <div>
            <div class="card-type-pill pill-${p.type}">${typeIcon} ${p.type}</div>
            <div class="card-title">${h(p.name)}</div>
            ${p.location ? `<div class="card-location">📍 ${h(p.location)}</div>` : ''}
          </div>
          ${p.status ? `<span class="card-status-badge status-${p.status}">${p.status}</span>` : ''}
        </div>
      </div>
      ${mediaStrip}
      <div class="card-body">
        <div class="card-kpis">
          <div class="kpi">
            <span class="kpi-label">Size</span>
            <span class="kpi-value">${p.size ? num(p.size)+' sq ft' : '—'}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Purchase Price</span>
            <span class="kpi-value">${p.purchasePrice ? 'AED '+num(p.purchasePrice) : '—'}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">${p.status === 'vacant' ? 'Asking Rent' : 'Annual Rent'}</span>
            <span class="kpi-value gold">${p.annualRent ? 'AED '+num(p.annualRent) : '—'}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Yield</span>
            <span class="kpi-value">${yieldPct(p.annualRent, p.purchasePrice)}</span>
          </div>
        </div>
        <div class="card-chips">
          <span class="chip ${p.compound  === 'yes' ? 'chip-on' : 'chip-off'}">${p.compound  === 'yes' ? '✓' : '✗'} Compound</span>
          <span class="chip ${p.mezzanine === 'yes' ? 'chip-on' : 'chip-off'}">${p.mezzanine === 'yes' ? '✓' : '✗'} Mezzanine</span>
          ${ownershipChip}
          ${agentSourcedChip}
          ${mapChip}
        </div>
        ${vacantBanner}
        ${tenantSection}
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        <button class="card-action-btn" onclick="openDetailModal('${p.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          View
        </button>
        <button class="card-action-btn" onclick="openEditModal('${p.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        <button class="card-action-btn del" onclick="quickDelete('${p.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          Delete
        </button>
      </div>
    </div>`;
}

async function loadCardMedia(p) {
  for (let i = 0; i < Math.min(p.media.length, 3); i++) {
    const meta = p.media[i];
    const el = $(`strip-${p.id}-${i}`);
    if (!el) continue;
    if (meta.propertyId && meta.id) {
      // API-backed photo: stream from the backend
      el.src = `/api/properties/${meta.propertyId}/files/${meta.id}/download`;
    } else if (meta.id) {
      // Legacy IDB photo
      const rec = await idbGet(meta.id).catch(() => null);
      if (rec) el.src = rec.data;
    }
  }
}

// ─── Add / Edit Modal ─────────────────────────────
function openAddModal() {
  $('editPropertyId').value = '';
  $('modalTitle').textContent = 'Add New Property';
  $('saveBtnText').textContent = 'Save Property';
  $('propertyForm').reset();
  pendingFiles = { drec: null, ijari: null, ijari2: null, affection: null, tenancy: null, license: null, tenantlicense: null, addendum: null };
  pendingMedia = []; existingMediaMeta = []; removedMediaIds = [];
  resetFileZones();
  renderMediaPreviews();
  toggleOwnership();
  toggleRentalSection();
  if (typeof togglePropUsageCustom === 'function') togglePropUsageCustom();
  $('propNumCheques').value = '';
  $('chequeFields').innerHTML = '';
  const partnerFieldsEl = $('partnerFields');
  if (partnerFieldsEl) partnerFieldsEl.innerHTML = '';
  const cashGroupEl = document.getElementById('cashAmountGroup');
  if (cashGroupEl) cashGroupEl.style.display = 'none';
  $('propertyModalOverlay').classList.add('active');
}

// Show/hide the "specify custom usage" text input based on the dropdown
function togglePropUsageCustom() {
  const sel = $('propUsage');
  const custom = $('propUsageCustom');
  if (!sel || !custom) return;
  if (sel.value === '__other__') {
    custom.style.display = '';
    setTimeout(() => custom.focus(), 50);
  } else {
    custom.style.display = 'none';
    custom.value = '';
  }
}

async function openEditModal(id) {
  const p = loadProps().find(x => x.id === id);
  if (!p) return;

  $('editPropertyId').value = id;
  $('modalTitle').textContent = 'Edit Property';
  $('saveBtnText').textContent = 'Save Changes';
  pendingFiles = { drec: null, ijari: null, ijari2: null, affection: null, tenancy: null, license: null, tenantlicense: null, addendum: null };
  pendingMedia = [];
  existingMediaMeta = p.media ? [...p.media] : [];
  removedMediaIds   = [];
  resetFileZones();

  $('propName').value          = p.name          || '';
  $('propType').value          = p.type          || '';
  if ($('propUnitNo'))       $('propUnitNo').value       = p.unitNo       || '';
  if ($('propTradeLicense')) $('propTradeLicense').value = p.tradeLicense || '';
  // Property usage: known options pre-fill the dropdown; anything else maps to "Other"
  if ($('propUsage') && $('propUsageCustom')) {
    const usageVal = (p.usage || '').toLowerCase();
    const known = ['warehouse','garage','shed','factory','labour_camp','retail_shop','storage','office','workshop','showroom'];
    if (!usageVal) {
      $('propUsage').value = '';
      $('propUsageCustom').value = '';
      $('propUsageCustom').style.display = 'none';
    } else if (known.includes(usageVal)) {
      $('propUsage').value = usageVal;
      $('propUsageCustom').value = '';
      $('propUsageCustom').style.display = 'none';
    } else {
      $('propUsage').value = '__other__';
      $('propUsageCustom').value = p.usage;
      $('propUsageCustom').style.display = '';
    }
  }
  $('propLocation').value      = p.location      || '';
  $('propMapLink').value       = p.mapLink        || '';
  $('propCoords').value        = p.coords         || '';
  $('propSize').value          = p.size          || '';
  $('propArea').value          = p.area          || '';
  $('propOwnership').value     = p.ownership     || '';
  $('propPurchasePrice').value = p.purchasePrice || '';
  $('propPartnerName').value   = p.partnerName   || '';
  $('propOurShare').value      = p.ourShare      || '';
  $('propOwnerName').value     = p.ownerName     || '';
  $('propOwnerPhone').value    = p.ownerPhone    || '';
  $('propMgmtFee').value       = p.mgmtFee       || '';
  $('propMgmtDate').value      = p.mgmtDate      || '';
  $('propPurchaseDate').value  = p.purchaseDate  || '';
  $('propMarketValue').value   = p.marketValue   || '';
  $('propLandCharges').value   = p.landCharges   || '';
  $('propLicenseFees').value   = p.licenseFees   || '';
  $('propDewaCharges').value           = p.dewaCharges          || '';
  $('propEjariFees').value             = p.ejariFees            || '';
  $('propCivilDefenseCharges').value   = p.civilDefenseCharges  || '';
  $('propLegalFee').value              = p.legalFee             || '';
  $('propCorporateTax').value          = p.corporateTax         || '';
  $('propSecurityDeposit').value       = p.securityDeposit      || '';
  $('propPremiseNo').value             = p.premiseNumber || '';
  $('propDewaNo').value                = p.dewaNumber    || '';
  $('propOwnerEmail').value            = p.ownerEmail    || '';
  // Partners: hydrate from JSON. If legacy single-partner data is present
  // and partners JSON is empty, seed the partners array with the legacy row.
  let partnersArr = [];
  if (p.partners) {
    try { partnersArr = JSON.parse(p.partners); } catch { partnersArr = []; }
  } else if (p.partnerName) {
    partnersArr = [{ name: p.partnerName, phone: '' }];
  }
  $('propNumPartners').value = partnersArr.length || '';
  renderPartnerFields(partnersArr);
  $('propRent').value          = p.annualRent    || '';
  $('propServiceCharges').value = p.serviceCharges || '';
  $('propMaintenanceFees').value = p.maintenanceFees || '';
  $('propSubLeaseFees').value    = p.subLeaseFees    || '';
  recalcVat();
  $('propTenantName').value    = p.tenantName    || '';
  $('propTenantPhone').value   = p.tenantPhone   || '';
  $('propTenantEmail').value   = p.tenantEmail   || '';
  $('propReminderDays').value  = p.reminderDays  || '60';
  $('propLeaseStart').value    = p.leaseStart    || '';
  $('propLeaseEnd').value      = p.leaseEnd      || '';
  $('propNotes').value         = p.notes         || '';

  // Restore the payment-method dropdown: cash mode if a cashAmount is set,
  // otherwise the cheque count.
  if (Number(p.cashAmount) > 0) {
    $('propNumCheques').value = 'cash';
  } else {
    $('propNumCheques').value = p.numCheques ? String(p.numCheques) : '';
  }
  $('propCashAmount').value = p.cashAmount  || '';
  $('propBrokerage').value  = p.brokerageAmount || '';
  renderChequeFields();
  if (p.cheques?.length) {
    $('chequeFields').querySelectorAll('.cheque-row').forEach((row, i) => {
      const c = p.cheques[i];
      if (!c) return;
      const noTextEl = row.querySelector('.cheque-no-text');
      if (noTextEl) noTextEl.value = c.noText || c.chequeNoText || '';
      row.querySelector('.cheque-date').value   = c.date   || '';
      row.querySelector('.cheque-amount').value = c.amount || '';
      const statusEl = row.querySelector('.cheque-status');
      statusEl.value = c.status || 'pending';
      const feesEl   = row.querySelector('.cheque-fees');
      if (feesEl) feesEl.value = c.lateFees != null ? c.lateFees : '';
      // sync the fees input enabled state to match the loaded status
      onChequeStatusChange(statusEl);
    });
  }

  setRadio('propCompound',  p.compound  || 'no');
  setRadio('propMezzanine', p.mezzanine || 'no');
  if (p.status) setRadio('propStatus', p.status);
  else          setRadio('propStatus', '');

  toggleOwnership();
  toggleRentalSection();

  showExisting('drec',          p.files?.drec);
  showExisting('ijari',         p.files?.ijari);
  showExisting('ijari2',        p.files?.ijari2);
  showExisting('affection',     p.files?.affection);
  showExisting('tenancy',       p.files?.tenancy);
  showExisting('license',       p.files?.license);
  showExisting('tenantlicense', p.files?.tenantlicense);
  showExisting('addendum',      p.files?.addendum);

  await renderMediaPreviews();
  $('propertyModalOverlay').classList.add('active');
}

function closeAddModal() {
  $('propertyModalOverlay').classList.remove('active');
  if (typeof flushDeferredSseRefreshes === 'function') flushDeferredSseRefreshes();
}

function toggleOwnership() {
  const v = $('propOwnership').value;
  $('partnershipFields').style.display = v === 'partnership' ? 'block' : 'none';
  $('managementFields').style.display  = v === 'management'  ? 'block' : 'none';
}

// ─── Partner rows (multi-partner support) ───────────────────
// Driven by the Number of Partners input. Each row collects {name, phone}.
// Existing values are preserved when the count changes.
function renderPartnerFields(prefill) {
  const container = document.getElementById('partnerFields');
  if (!container) return;
  const n = parseInt(document.getElementById('propNumPartners')?.value, 10) || 0;
  // Capture current values
  const existing = [];
  container.querySelectorAll('.partner-row').forEach((row, i) => {
    existing[i] = {
      name:  row.querySelector('.partner-name')?.value  || '',
      phone: row.querySelector('.partner-phone')?.value || '',
    };
  });
  if (Array.isArray(prefill)) {
    prefill.forEach((p, i) => existing[i] = { name: p.name || '', phone: p.phone || '' });
  }
  if (!n) { container.innerHTML = ''; return; }
  let html = '<div class="partner-list">';
  for (let i = 0; i < n; i++) {
    const v = existing[i] || {};
    html += `
      <div class="partner-row" style="display:grid;grid-template-columns:32px 1fr 1fr;gap:8px;align-items:center;margin-bottom:8px;">
        <span style="font-size:12px;font-weight:700;color:var(--text-3);text-align:center;">P${i+1}</span>
        <input type="text" class="partner-name"  placeholder="Partner ${i+1} name"   value="${h(v.name || '')}">
        <input type="tel"  class="partner-phone" placeholder="+971 XX XXX XXXX"      value="${h(v.phone || '')}">
      </div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

// Auto-calculate 5% VAT from annual rent only
function recalcVat() {
  const rent = Number(document.getElementById('propRent')?.value) || 0;
  const vat  = Math.round(rent * 0.05);
  const out  = document.getElementById('propVat');
  if (out) out.value = vat || '';
}

function renderChequeFields() {
  const container = $('chequeFields');
  // Toggle the Cash Amount field based on payment-method selection
  const sel = $('propNumCheques')?.value || '';
  const cashGroup = document.getElementById('cashAmountGroup');
  if (cashGroup) cashGroup.style.display = sel === 'cash' ? '' : 'none';
  // 'cash' mode: clear any cheque rows, the amount lives in cashAmount instead
  if (sel === 'cash') { container.innerHTML = ''; return; }
  const n = parseInt(sel) || 0;
  if (!n) { container.innerHTML = ''; return; }
  const existing = [];
  container.querySelectorAll('.cheque-row').forEach((row, i) => {
    existing[i] = {
      noText:   row.querySelector('.cheque-no-text')?.value || '',
      date:     row.querySelector('.cheque-date')?.value    || '',
      amount:   row.querySelector('.cheque-amount')?.value  || '',
      status:   row.querySelector('.cheque-status')?.value  || 'pending',
      lateFees: row.querySelector('.cheque-fees')?.value    || '',
    };
  });
  let html = '<div class="cheque-table"><div class="cheque-head"><span>#</span><span>Cheque No.</span><span>Cheque Date</span><span>Amount (AED)</span><span>Status</span><span>Fees (AED)</span></div>';
  for (let i = 0; i < n; i++) {
    const prev = existing[i] || {};
    const showFees = prev.status === 'late' || prev.status === 'bounced';
    html += `<div class="cheque-row">
      <span class="cheque-num">${i + 1}</span>
      <input type="text" class="cheque-no-text" placeholder="e.g. 00012345" value="${prev.noText || ''}">
      <input type="date" class="cheque-date" value="${prev.date || ''}">
      <input type="number" class="cheque-amount" placeholder="e.g. 45,000" min="0" value="${prev.amount || ''}">
      <select class="cheque-status" onchange="onChequeStatusChange(this)">
        <option value="pending"  ${(!prev.status || prev.status==='pending')  ? 'selected':''}>⏳ Pending</option>
        <option value="received" ${prev.status==='received' ? 'selected':''}>✅ Received</option>
        <option value="late"     ${prev.status==='late'     ? 'selected':''}>⚠️ Late Submission</option>
        <option value="bounced"  ${prev.status==='bounced'  ? 'selected':''}>❌ Bounced</option>
      </select>
      <input type="number" class="cheque-fees" placeholder="${showFees ? 'fee amount' : '—'}" min="0" value="${prev.lateFees || ''}" ${showFees ? '' : 'disabled style="background:#f3f4f6;cursor:not-allowed;"'}>
    </div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

function toggleRentalSection() {
  const status = getRadio('propStatus');
  const tenantSec  = $('tenantSection');
  const vacantNote = $('vacantNotice');
  const rentLabel  = $('rentLabel');

  if (status === 'vacant') {
    tenantSec.classList.add('collapsed');
    vacantNote.style.display = 'flex';
    if (rentLabel) rentLabel.textContent = '(asking rent)';
  } else {
    tenantSec.classList.remove('collapsed');
    vacantNote.style.display = 'none';
    if (rentLabel) rentLabel.textContent = '';
  }
}

function setRadio(name, val) {
  document.querySelectorAll(`input[name="${name}"]`).forEach(r => { r.checked = r.value === val; });
}

function getRadio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || null;
}

// ─── Document File Handling ───────────────────────
function handleFile(e, key) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) { showToast('File too large (max 50 MB)', 'error'); return; }
  pendingFiles[key] = file;
  const display = file.name.length > 24 ? file.name.slice(0, 22) + '…' : file.name;
  // Mirror state across every zone with the same data-doc-key (e.g. Ijari shown in both sections)
  document.querySelectorAll(`.file-zone[data-doc-key="${key}"]`).forEach(zone => {
    zone.classList.add('has-file');
    const lbl = zone.querySelector('.file-zone-text');
    if (lbl) lbl.textContent = display;
  });
}

function showExisting(key, info) {
  // Update every existing-file-tag bound to this key (data attribute), and the legacy id one
  const tags = Array.from(document.querySelectorAll(`[data-existing-key="${key}"]`));
  const legacy = $(`existing${cap(key)}`);
  if (legacy && !tags.includes(legacy)) tags.push(legacy);
  tags.forEach(tagEl => {
    if (info?.name) {
      tagEl.style.display = 'flex';
      tagEl.innerHTML = `✅ ${h(info.name)} <span style="color:var(--text-3)">(existing)</span>`;
    } else {
      tagEl.style.display = 'none';
    }
  });
}

function resetFileZones() {
  const labels = { drec: 'Upload DREC', ijari: 'Upload Owner Ijari', ijari2: 'Upload Tenancy Ijari', affection: 'Upload Plan', tenancy: 'Upload Contract' };
  ['drec', 'ijari', 'ijari2', 'affection', 'tenancy'].forEach(key => {
    // Reset every <input type=file> tied to this key (e.g. fileIjari and fileIjari2)
    document.querySelectorAll(`.file-zone[data-doc-key="${key}"] input[type="file"]`).forEach(inp => { inp.value = ''; });
    document.querySelectorAll(`.file-zone[data-doc-key="${key}"]`).forEach(zone => {
      zone.classList.remove('has-file');
      const lbl = zone.querySelector('.file-zone-text');
      if (lbl) lbl.textContent = labels[key];
    });
    // Legacy id-based reset (still applies to fileDrecLabel, fileIjariLabel etc.)
    const legacyLabel = $(`file${cap(key)}Label`);
    if (legacyLabel) legacyLabel.textContent = labels[key];
    document.querySelectorAll(`[data-existing-key="${key}"]`).forEach(t => { t.style.display = 'none'; });
    const tag = $(`existing${cap(key)}`);
    if (tag) tag.style.display = 'none';
  });
}

// ─── Media Handling ───────────────────────────────
function handleMediaFiles(e) {
  const files = Array.from(e.target.files);
  for (const file of files) {
    if (file.size > 100 * 1024 * 1024) { showToast(`${file.name} is too large (max 100 MB)`, 'error'); continue; }
    pendingMedia.push(file);
  }
  e.target.value = ''; // allow re-selecting same file
  renderMediaPreviews();
}

async function renderMediaPreviews() {
  const grid = $('mediaPreviewGrid');
  if (!grid) return;
  grid.innerHTML = '';

  // Existing media (already saved). Source can be either an API-backed
  // photo (has propertyId, served via /download) or a legacy IDB blob.
  for (let i = 0; i < existingMediaMeta.length; i++) {
    const meta = existingMediaMeta[i];
    let dataUrl, mime, name;
    if (meta.propertyId && meta.id) {
      dataUrl = `/api/properties/${meta.propertyId}/files/${meta.id}/download`;
      mime    = meta.mime || '';
      name    = meta.filename || 'photo';
    } else if (meta.id) {
      const rec = await idbGet(meta.id).catch(() => null);
      if (!rec) continue;
      dataUrl = rec.data;
      mime    = meta.mime || '';
      name    = meta.name || 'photo';
    } else {
      continue;
    }

    const thumb = document.createElement('div');
    thumb.className = 'media-thumb';

    if (isVideo(mime)) {
      const vid = document.createElement('video');
      vid.src = dataUrl; vid.muted = true;
      vid.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      thumb.appendChild(vid);
      const icon = document.createElement('div');
      icon.className = 'media-thumb-video-icon'; icon.textContent = '▶';
      thumb.appendChild(icon);
    } else {
      const img = document.createElement('img');
      img.src = dataUrl; img.alt = name;
      thumb.appendChild(img);
    }

    const badge = document.createElement('div');
    badge.className = 'media-thumb-badge'; badge.textContent = 'Saved';
    thumb.appendChild(badge);

    const nameEl = document.createElement('div');
    nameEl.className = 'media-thumb-name';
    nameEl.textContent = name;
    thumb.appendChild(nameEl);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'media-thumb-remove'; rmBtn.textContent = '×';
    rmBtn.title = 'Remove';
    const capturedId   = meta.id;
    const capturedIdx  = i;
    rmBtn.onclick = e => {
      e.stopPropagation();
      removedMediaIds.push(capturedId);
      existingMediaMeta = existingMediaMeta.filter((_, idx) => idx !== capturedIdx);
      renderMediaPreviews();
    };
    thumb.appendChild(rmBtn);
    grid.appendChild(thumb);
  }

  // Pending new media (not yet saved)
  pendingMedia.forEach((file, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'media-thumb';
    const url = URL.createObjectURL(file);

    if (isVideo(file.type)) {
      const vid = document.createElement('video');
      vid.src = url; vid.muted = true;
      vid.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      thumb.appendChild(vid);
      const icon = document.createElement('div');
      icon.className = 'media-thumb-video-icon'; icon.textContent = '▶';
      thumb.appendChild(icon);
    } else {
      const img = document.createElement('img');
      img.src = url; img.alt = file.name;
      thumb.appendChild(img);
    }

    const badge = document.createElement('div');
    badge.className = 'media-thumb-badge'; badge.textContent = 'New';
    badge.style.background = 'rgba(5,150,105,.8)';
    thumb.appendChild(badge);

    const name = document.createElement('div');
    name.className = 'media-thumb-name'; name.textContent = file.name;
    thumb.appendChild(name);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'media-thumb-remove'; rmBtn.textContent = '×';
    rmBtn.title = 'Remove';
    const capturedIdx = i;
    rmBtn.onclick = e => {
      e.stopPropagation();
      pendingMedia.splice(capturedIdx, 1);
      renderMediaPreviews();
    };
    thumb.appendChild(rmBtn);
    grid.appendChild(thumb);
  });
}

// ─── Save Property ────────────────────────────────
async function handleSave() {
  if (typeof markLocalMutation === 'function') markLocalMutation();
  const name = $('propName').value.trim();
  const type = $('propType').value;
  const status = getRadio('propStatus');
  if (!name || !type) { showToast('Property Name and Type are required', 'error'); return; }
  if (!status || (status !== 'rented' && status !== 'vacant')) {
    showToast('Pick a Rental Status (Rented or Vacant)', 'error');
    return;
  }

  const btn = $('savePropertyBtn');
  btn.disabled = true;
  $('saveBtnText').textContent = 'Saving…';

  const editId = $('editPropertyId').value;
  const props  = loadProps();

  // Property Usage with "Other (specify)" support
  const usageSel = ($('propUsage')?.value || '').trim();
  const usageCustom = ($('propUsageCustom')?.value || '').trim();
  const usage = usageSel === '__other__' ? usageCustom : usageSel;

  const property = {
    id:            editId || uid(),
    name, type,
    unitNo:        $('propUnitNo')?.value.trim()        || null,
    tradeLicense:  $('propTradeLicense')?.value.trim()  || null,
    usage:         usage                                 || null,
    location:      $('propLocation').value.trim()      || null,
    mapLink:       $('propMapLink').value.trim()        || null,
    size:          Number($('propSize').value)          || null,
    area:          Number($('propArea').value)          || null,
    compound:      getRadio('propCompound')             || 'no',
    mezzanine:     getRadio('propMezzanine')            || 'no',
    ownership:     $('propOwnership').value             || null,
    partnerName:   $('propPartnerName').value.trim()    || null,
    ourShare:      Number($('propOurShare').value)      || null,
    ownerName:     $('propOwnerName').value.trim()      || null,
    ownerPhone:    $('propOwnerPhone').value.trim()     || null,
    mgmtFee:       Number($('propMgmtFee').value)       || null,
    mgmtDate:      $('propMgmtDate').value              || null,
    purchasePrice: Number($('propPurchasePrice').value) || null,
    purchaseDate:  $('propPurchaseDate').value          || null,
    marketValue:   Number($('propMarketValue').value)   || null,
    landCharges:           Number($('propLandCharges').value)           || null,
    licenseFees:           Number($('propLicenseFees').value)           || null,
    dewaCharges:           Number($('propDewaCharges').value)           || null,
    ejariFees:             Number($('propEjariFees').value)             || null,
    civilDefenseCharges:   Number($('propCivilDefenseCharges').value)   || null,
    legalFee:              Number($('propLegalFee').value)              || null,
    corporateTax:          Number($('propCorporateTax').value)          || null,
    securityDeposit:       Number($('propSecurityDeposit').value)       || null,
    cashAmount:            Number($('propCashAmount').value)            || null,
    brokerageAmount:       Number($('propBrokerage').value)             || null,
    premiseNumber:         $('propPremiseNo').value.trim()  || null,
    dewaNumber:            $('propDewaNo').value.trim()     || null,
    ownerEmail:            $('propOwnerEmail').value.trim() || null,
    partners:              (() => {
      const n = parseInt($('propNumPartners')?.value, 10) || 0;
      if (!n) return null;
      const list = [];
      document.querySelectorAll('#partnerFields .partner-row').forEach(row => {
        const name  = row.querySelector('.partner-name')?.value.trim()  || '';
        const phone = row.querySelector('.partner-phone')?.value.trim() || '';
        if (name || phone) list.push({ name, phone });
      });
      return list.length ? JSON.stringify(list) : null;
    })(),
    status:        getRadio('propStatus')               || null,
    annualRent:    Number($('propRent').value)          || null,
    serviceCharges:  Number($('propServiceCharges').value)  || null,
    maintenanceFees: Number($('propMaintenanceFees').value) || null,
    vat:             Number($('propVat').value)             || null,
    subLeaseFees:    Number($('propSubLeaseFees').value)    || null,
    coords:        $('propCoords').value.trim()        || null,
    tenantName:    $('propTenantName').value.trim()   || null,
    tenantPhone:   $('propTenantPhone').value.trim()  || null,
    tenantEmail:   $('propTenantEmail').value.trim()  || null,
    reminderDays:  Number($('propReminderDays').value) || 60,
    leaseStart:    $('propLeaseStart').value           || null,
    leaseEnd:      $('propLeaseEnd').value             || null,
    notes:         $('propNotes').value.trim()          || null,
    numCheques:    (() => {
      const v = $('propNumCheques').value;
      if (v === 'cash') return null;       // cash mode: tracked via cashAmount
      return parseInt(v) || null;
    })(),
    cheques:       (() => {
      const rows = [];
      $('chequeFields').querySelectorAll('.cheque-row').forEach((row, i) => {
        rows.push({
          n:        i + 1,
          noText:   row.querySelector('.cheque-no-text')?.value.trim()  || null,
          date:     row.querySelector('.cheque-date')?.value            || null,
          amount:   Number(row.querySelector('.cheque-amount')?.value)  || null,
          status:   row.querySelector('.cheque-status')?.value          || 'pending',
          lateFees: Number(row.querySelector('.cheque-fees')?.value)    || null,
        });
      });
      return rows.length ? rows : null;
    })(),
    files:         {},
    media:         [],
    createdAt:     editId ? (props.find(p => p.id === editId)?.createdAt || iso()) : iso(),
    updatedAt:     iso(),
  };

  // ─── Save property to backend, then upload pending files via API ─
  let savedId;
  try {
    if (editId && /^\d+$/.test(editId)) {
      const updated = await apiUpdateProperty(editId, property);
      savedId = updated.id;
    } else {
      const created = await apiCreateProperty(property);
      savedId = created.id;
    }
  } catch (e) {
    showToast(`Save failed: ${e.message}`, 'error');
    btn.disabled = false;
    $('saveBtnText').textContent = 'Save Property';
    return;
  }

  // Sync cheques sub-resource (these are dropped from the property body
  // because they're a separate table). Replace all cheques to match the form.
  if (property.cheques !== undefined) {
    try { await apiSyncPropertyCheques(savedId, property.cheques); }
    catch (e) { console.warn('cheque sync failed:', e); }
  }

  // Upload pending document files in parallel — sequential awaits made
  // saves take 10-30s when several files were attached.
  const uploads = ['drec', 'ijari', 'ijari2', 'affection', 'tenancy', 'license', 'tenantlicense', 'addendum']
    .filter(k => pendingFiles[k])
    .map(k => apiUploadPropertyFile(savedId, k, pendingFiles[k])
      .catch(e => { console.warn(`upload ${k} failed:`, e); showToast(`Upload of ${k} failed`, 'error'); })
    );
  if (uploads.length) await Promise.all(uploads);

  // Delete media flagged for removal
  for (const id of removedMediaIds) {
    if (typeof id === 'number' || /^\d+$/.test(String(id))) {
      try { await apiDeletePropertyFile(savedId, id); } catch (e) {}
    } else {
      // legacy IDB id
      await idbDel(id).catch(() => {});
    }
  }

  // Upload pending media (photos / videos)
  for (let i = 0; i < pendingMedia.length; i++) {
    const file = pendingMedia[i];
    try { await apiUploadPropertyFile(savedId, 'photo', file); }
    catch (e) { console.warn('upload photo failed:', e); }
  }

  await fetchProperties();
  closeAddModal();
  refresh();
  // Re-render whatever tab the user came from — Rentals/Financials/Home all
  // read from the property cache and need to redraw with the new cheque /
  // financial state. Without this they stay stale until a full page reload.
  if (typeof activeTab !== 'undefined' && activeTab) {
    if (activeTab === 'payment')         renderPayments();
    else if (activeTab === 'financials') renderFinancials();
    else if (activeTab === 'home')       renderHome();
  }
  showToast(editId ? 'Property updated' : 'Property added', 'success');

  btn.disabled = false;
  $('saveBtnText').textContent = 'Save Property';
}

// ─── Delete ───────────────────────────────────────
function quickDelete(id) {
  if (!confirm('Delete this property? This cannot be undone.')) return;
  doDelete(id);
}

async function handleDelete() {
  if (!currentDetailId) return;
  if (!confirm('Delete this property? This cannot be undone.')) return;
  if (typeof markLocalMutation === 'function') markLocalMutation();
  await doDelete(currentDetailId);
  closeDetailModal();
}

async function doDelete(id) {
  const props = loadProps();
  const p     = props.find(x => x.id === id);
  if (p?.files) {
    for (const info of Object.values(p.files)) {
      if (info?.id) await idbDel(info.id).catch(() => {});
    }
  }
  if (p?.media) {
    for (const m of p.media) {
      await idbDel(m.id).catch(() => {});
    }
  }
  persistProps(props.filter(x => x.id !== id));
  refresh();
  showToast('Property deleted', 'success');
}

// ─── Detail Modal ─────────────────────────────────
async function openDetailModal(id) {
  currentDetailId = id;
  const p = loadProps().find(x => x.id === id);
  if (!p) return;

  // Pull API-tracked files (Drive-mirrored uploads) and group by category.
  // Falls back to p.files / p.media (legacy IDB) if the API has nothing.
  if (/^\d+$/.test(String(id))) {
    try {
      const files = await apiListPropertyFiles(id);
      if (files && files.length) {
        const byCat = {};
        for (const f of files) {
          const cat = f.category || 'other';
          if (cat === 'photo') {
            byCat.photos = byCat.photos || [];
            byCat.photos.push(f);
          } else {
            byCat[cat] = f; // last one wins per doc category
          }
        }
        // Overwrite legacy fields so the existing render uses API data.
        p.files = {
          drec:          byCat.drec,
          ijari:         byCat.ijari,
          ijari2:        byCat.ijari2,
          affection:     byCat.affection,
          tenancy:       byCat.tenancy,
          license:       byCat.license,
          tenantlicense: byCat.tenantlicense,
          addendum:      byCat.addendum,
        };
        p.media = byCat.photos || [];
      }
    } catch (e) { console.warn('[openDetailModal] file fetch failed:', e); }

    // Pull cheques from sub-resource and adapt to the {n, date, amount, status}
    // shape the existing detail render uses.
    try {
      const apiCheques = await apiListPropertyCheques(id);
      p.cheques = apiCheques.map(c => ({
        n:        c.chequeNum,
        noText:   c.chequeNoText || '',
        date:     c.chequeDate,
        amount:   c.amount,
        status:   c.status,
        lateFees: c.lateFees || null,
      }));
    } catch (e) { console.warn('[openDetailModal] cheque fetch failed:', e); }
  }

  const typeIcon = p.type === 'warehouse' ? '🏭' : '🏢';
  $('detailTypeIcon').textContent = typeIcon;
  $('detailName').textContent     = p.name;

  let leaseNote = '';
  if (p.status === 'rented' && p.leaseEnd) {
    const days = Math.ceil((new Date(p.leaseEnd) - new Date()) / 86400000);
    if      (days < 0)   leaseNote = `<span class="d-badge d-badge-vacant">Lease Expired ${Math.abs(days)}d ago</span>`;
    else if (days <= 60) leaseNote = `<span class="d-badge" style="background:var(--warn-bg);color:var(--warn);">⚠️ ${days}d until expiry</span>`;
  }

  $('detailMeta').innerHTML = `
    <span class="d-badge d-badge-${p.type}">${typeIcon} ${p.type}</span>
    ${p.status ? `<span class="d-badge d-badge-${p.status}">${p.status}</span>` : ''}
    ${p.ownership ? `<span class="d-badge d-badge-${p.ownership}">${
      p.ownership === 'own'        ? '100% Own'
      : p.ownership === 'management' ? '📋 Managed'
      : `Partnership${p.ourShare ? ' ('+p.ourShare+'%)' : ''}`
    }</span>` : ''}
    ${leaseNote}
  `;

  $('detailBody').innerHTML = `
    <div class="detail-sections">

      <div class="two-col-blocks">
        <div class="detail-block">
          <div class="detail-block-header">📍 Property Details</div>
          <div class="detail-rows">
            ${p.unitNo       ? `<div class="detail-row"><span class="dr-label">Unit No.</span><span class="dr-value">${h(p.unitNo)}</span></div>` : ''}
            ${p.usage        ? `<div class="detail-row"><span class="dr-label">Property Usage</span><span class="dr-value">${h(_fmtUsage(p.usage))}</span></div>` : ''}
            ${p.tradeLicense ? `<div class="detail-row"><span class="dr-label">Trade License</span><span class="dr-value">${h(p.tradeLicense)}</span></div>` : ''}
            ${p.location     ? `<div class="detail-row"><span class="dr-label">Location</span><span class="dr-value">${h(p.location)}</span></div>` : ''}
            ${p.mapLink      ? `<div class="detail-row"><span class="dr-label">Google Maps</span><span class="dr-value"><a href="${p.mapLink}" target="_blank">Open in Maps ↗</a></span></div>` : ''}
            ${p.size         ? `<div class="detail-row"><span class="dr-label">Built-up Size</span><span class="dr-value">${num(p.size)} sq ft</span></div>` : ''}
            ${p.area         ? `<div class="detail-row"><span class="dr-label">Plot Area</span><span class="dr-value">${num(p.area)} sq ft</span></div>` : ''}
            <div class="detail-row"><span class="dr-label">Compound</span><span class="dr-value">${p.compound  === 'yes' ? '✅ Yes' : '❌ No'}</span></div>
            <div class="detail-row"><span class="dr-label">Mezzanine</span><span class="dr-value">${p.mezzanine === 'yes' ? '✅ Yes' : '❌ No'}</span></div>
          </div>
        </div>
        <div class="detail-block">
          <div class="detail-block-header">💰 Financial Details</div>
          <div class="detail-rows">
            ${p.ownership ? `<div class="detail-row"><span class="dr-label">Ownership</span><span class="dr-value">${
              p.ownership === 'own' ? '100% Own'
              : p.ownership === 'management' ? '📋 Management Only (0%)'
              : 'Partnership'
            }</span></div>` : ''}
            ${p.ownership === 'partnership' && p.partnerName ? `<div class="detail-row"><span class="dr-label">Partner</span><span class="dr-value">${h(p.partnerName)}</span></div>` : ''}
            ${p.ownership === 'partnership' && p.ourShare    ? `<div class="detail-row"><span class="dr-label">Our Share</span><span class="dr-value">${p.ourShare}%</span></div>` : ''}
            ${p.ownership === 'management' && p.ownerName  ? `<div class="detail-row"><span class="dr-label">Property Owner</span><span class="dr-value">${h(p.ownerName)}</span></div>` : ''}
            ${p.ownership === 'management' && p.ownerPhone ? `<div class="detail-row"><span class="dr-label">Owner Phone</span><span class="dr-value"><a href="tel:${h(p.ownerPhone)}" class="contact-link phone-link">📞 ${h(p.ownerPhone)}</a></span></div>` : ''}
            ${p.ownership === 'management' && p.mgmtFee    ? `<div class="detail-row"><span class="dr-label">Management Fee</span><span class="dr-value big">AED ${num(p.mgmtFee)} / year</span></div>` : ''}
            ${p.ownership === 'management' && p.mgmtDate   ? `<div class="detail-row"><span class="dr-label">Agreement Date</span><span class="dr-value">${fmtDate(p.mgmtDate)}</span></div>` : ''}
            ${p.purchasePrice ? `<div class="detail-row"><span class="dr-label">Purchase Price</span><span class="dr-value big">AED ${num(p.purchasePrice)}</span></div>` : ''}
            ${p.purchaseDate  ? `<div class="detail-row"><span class="dr-label">Purchase Date</span><span class="dr-value">${fmtDate(p.purchaseDate)}</span></div>` : ''}
            ${p.marketValue   ? `<div class="detail-row"><span class="dr-label">Market Value</span><span class="dr-value">AED ${num(p.marketValue)}</span></div>` : ''}
            ${p.annualRent    ? `<div class="detail-row"><span class="dr-label">${p.status === 'vacant' ? 'Asking Rent' : 'Annual Rent'}</span><span class="dr-value big">AED ${num(p.annualRent)}</span></div>` : ''}
            ${p.landCharges          ? `<div class="detail-row"><span class="dr-label">Land Main Lease</span><span class="dr-value red">− AED ${num(p.landCharges)} / yr</span></div>` : ''}
            ${p.licenseFees          ? `<div class="detail-row"><span class="dr-label">License Fees</span><span class="dr-value red">− AED ${num(p.licenseFees)} / yr</span></div>` : ''}
            ${p.serviceCharges       ? `<div class="detail-row"><span class="dr-label">Service Charges</span><span class="dr-value red">− AED ${num(p.serviceCharges)} / yr</span></div>` : ''}
            ${p.dewaCharges          ? `<div class="detail-row"><span class="dr-label">DEWA Charges</span><span class="dr-value red">− AED ${num(p.dewaCharges)} / yr</span></div>` : ''}
            ${p.ejariFees            ? `<div class="detail-row"><span class="dr-label">Ejari Fees</span><span class="dr-value red">− AED ${num(p.ejariFees)}</span></div>` : ''}
            ${p.civilDefenseCharges  ? `<div class="detail-row"><span class="dr-label">Civil Defense</span><span class="dr-value red">− AED ${num(p.civilDefenseCharges)} / yr</span></div>` : ''}
            ${p.legalFee             ? `<div class="detail-row"><span class="dr-label">Legal Fee</span><span class="dr-value red">− AED ${num(p.legalFee)}</span></div>` : ''}
            ${p.corporateTax         ? `<div class="detail-row"><span class="dr-label">Corporate Tax</span><span class="dr-value red">− AED ${num(p.corporateTax)}</span></div>` : ''}
            ${p.annualRent && totalDeductions(p) ? `<div class="detail-row"><span class="dr-label">Net Annual Rent</span><span class="dr-value big green">AED ${num(Math.max(0, Number(p.annualRent) - totalDeductions(p)))}</span></div>` : ''}
            ${p.maintenanceFees      ? `<div class="detail-row"><span class="dr-label">Annual Maintenance</span><span class="dr-value">AED ${num(p.maintenanceFees)} / yr</span></div>` : ''}
            ${p.annualRent           ? `<div class="detail-row"><span class="dr-label">VAT (5%)</span><span class="dr-value">AED ${num(Math.round(Number(p.annualRent) * 0.05))}</span></div>` : ''}
            ${p.subLeaseFees         ? `<div class="detail-row"><span class="dr-label">Sub Lease Fees</span><span class="dr-value">AED ${num(p.subLeaseFees)}</span></div>` : ''}
            ${p.securityDeposit      ? `<div class="detail-row"><span class="dr-label">Security Deposit</span><span class="dr-value">AED ${num(p.securityDeposit)}</span></div>` : ''}
            ${p.cashAmount           ? `<div class="detail-row"><span class="dr-label">Cash Received</span><span class="dr-value green">💵 AED ${num(p.cashAmount)}</span></div>` : ''}
            ${p.brokerageAmount      ? `<div class="detail-row"><span class="dr-label">Brokerage</span><span class="dr-value green">+ AED ${num(p.brokerageAmount)}</span></div>` : ''}
            ${p.annualRent           ? `<div class="detail-row"><span class="dr-label">Rental Yield</span><span class="dr-value green">${yieldPct(p.annualRent, p.purchasePrice)}</span></div>` : ''}
          </div>
        </div>
      </div>

      ${p.status === 'rented' && (p.tenantName || p.leaseStart) ? `
      <div class="detail-block">
        <div class="detail-block-header">👤 Tenant Information</div>
        <div class="two-col-blocks" style="padding:0;">
          <div class="detail-rows">
            ${p.tenantName  ? `<div class="detail-row"><span class="dr-label">Tenant</span><span class="dr-value">${h(p.tenantName)}</span></div>` : ''}
            ${p.tenantPhone ? `<div class="detail-row"><span class="dr-label">Phone</span><span class="dr-value contact-actions"><a href="tel:${h(p.tenantPhone)}" class="contact-link phone-link">📞 ${h(p.tenantPhone)}</a>${waLink(p.tenantPhone, p.tenantName, p.name) ? `<a href="${waLink(p.tenantPhone, p.tenantName, p.name)}" target="_blank" class="wa-btn">WhatsApp</a>` : ''}</span></div>` : ''}
            ${p.tenantEmail ? `<div class="detail-row"><span class="dr-label">Email</span><span class="dr-value contact-actions"><a href="mailto:${h(p.tenantEmail)}" class="contact-link email-link" title="Open in mail app">✉️ ${h(p.tenantEmail)}</a><a href="https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(p.tenantEmail)}" target="_blank" class="gmail-btn" title="Open in Gmail">Gmail ↗</a></span></div>` : ''}
            ${p.annualRent  ? `<div class="detail-row"><span class="dr-label">Monthly Rent</span><span class="dr-value green">AED ${Math.round(p.annualRent/12).toLocaleString()}</span></div>` : ''}
          </div>
          <div class="detail-rows">
            ${p.leaseStart    ? `<div class="detail-row"><span class="dr-label">Lease Start</span><span class="dr-value">${fmtDate(p.leaseStart)}</span></div>` : ''}
            ${p.leaseEnd      ? `<div class="detail-row"><span class="dr-label">Lease End</span><span class="dr-value">${fmtDate(p.leaseEnd)}</span></div>` : ''}
            ${p.leaseEnd      ? `<div class="detail-row"><span class="dr-label">Remaining</span><span class="dr-value ${daysClass(p.leaseEnd, p.reminderDays)}">${daysRemaining(p.leaseEnd)}</span></div>` : ''}
            ${p.reminderDays  ? `<div class="detail-row"><span class="dr-label">Reminder Set</span><span class="dr-value reminder-pill">🔔 ${p.reminderDays} days before expiry</span></div>` : ''}
          </div>
        </div>
      </div>` : ''}

      ${p.status === 'vacant' ? `
      <div class="detail-block">
        <div class="detail-block-header">🔓 Vacant Property</div>
        <div class="detail-rows">
          <div class="detail-row"><span class="dr-label">Status</span><span class="dr-value red">Available for Rent</span></div>
          ${p.annualRent ? `<div class="detail-row"><span class="dr-label">Asking Rent</span><span class="dr-value big">AED ${num(p.annualRent)} / year</span></div>` : ''}
          ${p.annualRent ? `<div class="detail-row"><span class="dr-label">Per Month</span><span class="dr-value">AED ${Math.round(p.annualRent/12).toLocaleString()}</span></div>` : ''}
        </div>
      </div>` : ''}

      ${p.cheques?.length ? `
      <div class="detail-block">
        <div class="detail-block-header">💳 Cheque Schedule</div>
        <div class="cheque-detail-table">
          <div class="cdt-head"><span>#</span><span>Cheque No.</span><span>Date</span><span>Amount</span><span>Status</span><span>Fees</span></div>
          ${p.cheques.map((c, i) => `
          <div class="cdt-row">
            <span class="cdt-num">${i+1}</span>
            <span>${h(c.noText || '—')}</span>
            <span>${fmtDate(c.date)||'—'}</span>
            <span>${c.amount ? 'AED '+num(c.amount) : '—'}</span>
            <span class="cdt-badge cdt-${c.status||'pending'}">${
              c.status==='received' ? '✅ Received'
              : c.status==='bounced' ? '❌ Bounced'
              : c.status==='late'    ? '⚠️ Late'
              : '⏳ Pending'
            }</span>
            <span style="color:${c.lateFees?'var(--danger)':'#9ca3af'};font-weight:${c.lateFees?'600':'400'};">${c.lateFees ? 'AED '+num(c.lateFees) : '—'}</span>
          </div>`).join('')}
        </div>
      </div>` : ''}

      <div class="detail-block">
        <div class="detail-block-header">📁 Documents & Attachments</div>
        <div class="docs-grid">
          ${docTile('DREC Certificate', p.files?.drec)}
          ${docTile('Ijari (Owner)', p.files?.ijari)}
          ${docTile('Ijari (Tenancy)', p.files?.ijari2)}
          ${docTile('Affection Plan', p.files?.affection)}
          ${docTile('Tenancy Contract', p.files?.tenancy)}
          ${docTile('Trade License', p.files?.license)}
          ${docTile('Tenant License', p.files?.tenantlicense)}
          ${docTile('Addendum', p.files?.addendum)}
        </div>
      </div>

      <div class="detail-block" id="mediaGalleryBlock" style="${p.media?.length ? '' : 'display:none;'}">
        <div class="detail-block-header">📸 Photos & Videos <span style="margin-left:auto;font-weight:400;opacity:.6;">${p.media?.length || 0} file${(p.media?.length||0) === 1 ? '' : 's'}</span></div>
        <div class="detail-media-gallery" id="detailMediaGallery"></div>
      </div>

      ${p.notes ? `
      <div class="detail-block">
        <div class="detail-block-header">📝 Notes</div>
        <div style="padding:14px 16px;font-size:14px;color:var(--text);line-height:1.7;">${h(p.notes)}</div>
      </div>` : ''}

    </div>`;

  $('detailModalOverlay').classList.add('active');

  // Load media gallery async
  if (p.media?.length) {
    await loadDetailMedia(p);
  }
}

async function loadDetailMedia(p) {
  const gallery = $('detailMediaGallery');
  if (!gallery) return;

  const mediaItems = []; // collect { data, mime, name } for lightbox

  for (let i = 0; i < p.media.length; i++) {
    const meta = p.media[i];
    let dataUrl, mime, name;

    if (meta.propertyId && meta.id) {
      // API-backed photo — stream from /api/properties/:id/files/:fid/download
      dataUrl = `/api/properties/${meta.propertyId}/files/${meta.id}/download`;
      mime    = meta.mime || '';
      name    = meta.filename || 'photo';
    } else if (meta.id) {
      // Legacy IDB photo
      const rec = await idbGet(meta.id).catch(() => null);
      if (!rec) continue;
      dataUrl = rec.data;
      mime    = meta.mime || rec.mime || '';
      name    = meta.name || 'photo';
    } else {
      continue;
    }

    mediaItems.push({ data: dataUrl, mime, name });

    const item = document.createElement('div');
    item.className = 'detail-media-item';
    const idx = mediaItems.length - 1;
    item.onclick = () => openLightbox(mediaItems, idx);

    if (isVideo(mime)) {
      const vid = document.createElement('video');
      vid.src = dataUrl; vid.muted = true;
      item.appendChild(vid);
      const badge = document.createElement('div');
      badge.className = 'detail-media-video-badge'; badge.textContent = '▶';
      item.appendChild(badge);
    } else {
      const img = document.createElement('img');
      img.src = dataUrl; img.alt = name;
      item.appendChild(img);
    }

    const nameBadge = document.createElement('div');
    nameBadge.className = 'media-thumb-name'; nameBadge.textContent = name;
    item.appendChild(nameBadge);

    gallery.appendChild(item);
  }
}

function docTile(label, info) {
  if (!info) return `
    <div class="doc-tile doc-empty">
      <div class="doc-tile-icon">📋</div>
      <div class="doc-tile-title">${label}</div>
      <div class="doc-tile-name">Not uploaded</div>
    </div>`;
  const safeName = (info.filename || info.name || 'file').replace(/'/g, "\\'");
  const ext  = (info.filename || info.name || '').split('.').pop().toLowerCase();
  const icon = ['jpg','jpeg','png','gif','webp'].includes(ext) ? '🖼️' : ext === 'pdf' ? '📄' : '📋';

  // API-tracked file: serve from /api/properties/:id/files/:fileId/download
  if (info.id && info.propertyId) {
    const url = `/api/properties/${info.propertyId}/files/${info.id}/download`;
    return `
      <a class="doc-tile" href="${url}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;">
        <div class="doc-tile-icon">${icon}</div>
        <div class="doc-tile-title">${label}</div>
        <div class="doc-tile-name">${h(safeName)}</div>
        <div class="doc-tile-action">⬇ View / Download</div>
      </a>`;
  }

  // Legacy IDB file
  const safeId = (info.id || '').toString().replace(/'/g, "\\'");
  return `
    <div class="doc-tile" onclick="downloadFile('${safeId}','${safeName}')">
      <div class="doc-tile-icon">${icon}</div>
      <div class="doc-tile-title">${label}</div>
      <div class="doc-tile-name">${h(safeName)}</div>
      <div class="doc-tile-action">⬇ Download</div>
    </div>`;
}

async function downloadFile(fileId, fallbackName) {
  const rec = await idbGet(fileId);
  if (!rec) { showToast('File not found', 'error'); return; }
  const a = document.createElement('a');
  a.href = rec.data; a.download = rec.name || fallbackName;
  a.click();
}

function closeDetailModal() {
  $('detailModalOverlay').classList.remove('active');
  currentDetailId = null;
  if (typeof flushDeferredSseRefreshes === 'function') flushDeferredSseRefreshes();
}

// ─── Reminder Badge ───────────────────────────────
function renderReminderBadge(props) {
  const today   = new Date();
  const count   = props.filter(p => {
    if (p.status !== 'rented' || !p.leaseEnd) return false;
    const days = Math.ceil((new Date(p.leaseEnd) - today) / 86400000);
    return days <= (Number(p.reminderDays) || 60);
  }).length;

  const badge = $('reminderBadge');
  if (count > 0) {
    badge.textContent  = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// ─── Reminders Page ───────────────────────────────
function renderReminders() {
  const today = new Date();
  const props = loadProps();

  // Only include rented properties within their reminder window
  const triggered = props.filter(p => {
    if (p.status !== 'rented' || !p.leaseEnd) return false;
    const days = Math.ceil((new Date(p.leaseEnd) - today) / 86400000);
    return days <= (Number(p.reminderDays) || 60);
  });

  // Sort by days remaining ascending (most urgent first)
  triggered.sort((a, b) => {
    const da = Math.ceil((new Date(a.leaseEnd) - today) / 86400000);
    const db = Math.ceil((new Date(b.leaseEnd) - today) / 86400000);
    return da - db;
  });

  const groups = [
    { key: 'expired',  label: '⛔ Expired',              cls: 'rg-expired',  stripe: 'stripe-expired',  cd: 'cd-expired',  filter: d => d < 0 },
    { key: 'critical', label: '🔴 Critical — Under 30 Days', cls: 'rg-critical', stripe: 'stripe-critical', cd: 'cd-critical', filter: d => d >= 0  && d <= 30 },
    { key: 'warning',  label: '🟡 Soon — 31 to 60 Days', cls: 'rg-warning',  stripe: 'stripe-warning',  cd: 'cd-warning',  filter: d => d >= 31 && d <= 60 },
    { key: 'upcoming', label: '🔵 Upcoming — 61 to 90 Days', cls: 'rg-upcoming', stripe: 'stripe-upcoming', cd: 'cd-upcoming', filter: d => d >= 61 && d <= 90 },
    { key: 'advance',  label: '🟢 Advance Notice — 91 to 120 Days', cls: 'rg-advance',  stripe: 'stripe-advance',  cd: 'cd-advance',  filter: d => d >= 91 && d <= 120 },
  ];

  // Summary chips
  const chipDefs = [
    { key: 'expired',  label: 'Expired',    cls: 'chip-expired'  },
    { key: 'critical', label: 'Critical',   cls: 'chip-critical' },
    { key: 'warning',  label: 'Soon',       cls: 'chip-warning'  },
    { key: 'upcoming', label: 'Upcoming',   cls: 'chip-upcoming' },
    { key: 'advance',  label: 'Advance',    cls: 'chip-advance'  },
  ];

  const groupedCounts = {};
  groups.forEach(g => {
    groupedCounts[g.key] = triggered.filter(p => {
      const d = Math.ceil((new Date(p.leaseEnd) - today) / 86400000);
      return g.filter(d);
    }).length;
  });

  const chips = chipDefs
    .filter(c => groupedCounts[c.key] > 0)
    .map(c => `
      <div class="summary-chip ${c.cls}">
        <span class="chip-count">${groupedCounts[c.key]}</span>
        ${c.label}
      </div>`).join('');

  $('reminderSummaryChips').innerHTML = chips;

  const groupsEl  = $('reminderGroups');
  const emptyEl   = $('remindersEmpty');

  if (!triggered.length) {
    groupsEl.innerHTML  = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  let html = '';
  for (const grp of groups) {
    const items = triggered.filter(p => {
      const d = Math.ceil((new Date(p.leaseEnd) - today) / 86400000);
      return grp.filter(d);
    });
    if (!items.length) continue;

    html += `
      <div class="reminder-group">
        <div class="reminder-group-header ${grp.cls}">
          ${grp.label}
          <span class="rg-count">${items.length} propert${items.length === 1 ? 'y' : 'ies'}</span>
        </div>
        <div class="reminder-cards">
          ${items.map(p => reminderCardHTML(p, grp.stripe, grp.cd)).join('')}
        </div>
      </div>`;
  }
  groupsEl.innerHTML = html;
}

function reminderCardHTML(p, stripeClass, cdClass) {
  const today   = new Date();
  const days    = Math.ceil((new Date(p.leaseEnd) - today) / 86400000);
  const typeIcon = p.type === 'warehouse' ? '🏭' : '🏢';

  const countdownText = days < 0
    ? `${Math.abs(days)}<span style="font-size:18px;font-weight:600"> days\noverdue</span>`
    : `${days}`;
  const countdownLabel = days < 0 ? 'Days Overdue' : days === 0 ? 'Expires Today' : 'Days Left';

  const waHref = waLink(p.tenantPhone, p.tenantName, p.name);
  const phoneBtn = p.tenantPhone
    ? `<a href="tel:${h(p.tenantPhone)}" class="rc-phone-link" onclick="event.stopPropagation()">📞 ${h(p.tenantPhone)}</a>
       ${waHref ? `<a href="${waHref}" target="_blank" class="rc-wa-btn" onclick="event.stopPropagation()"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.126 1.533 5.858L.057 23.5l5.797-1.452A11.943 11.943 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.891 0-3.667-.498-5.2-1.37l-.373-.22-3.44.861.92-3.352-.242-.386A9.944 9.944 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg> WhatsApp</a>`
             : ''}`
    : '';
  const emailBtn = p.tenantEmail
    ? `<a href="mailto:${h(p.tenantEmail)}" class="rc-email-link" onclick="event.stopPropagation()">✉️ ${h(p.tenantEmail)}</a>
       <a href="https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(p.tenantEmail)}" target="_blank" class="rc-gmail-btn" onclick="event.stopPropagation()">Gmail ↗</a>`
    : '';

  return `
    <div class="reminder-card" onclick="openDetailModal('${p.id}'); showTab('dashboard');">
      <div class="reminder-card-stripe ${stripeClass}"></div>
      <div class="reminder-card-inner">
        <div class="rc-left">
          <div class="rc-property-row">
            <span class="rc-property-name">${typeIcon} ${h(p.name)}</span>
            <span class="rc-type-pill">${p.type}</span>
            ${p.location ? `<span class="rc-location">📍 ${h(p.location)}</span>` : ''}
          </div>

          ${p.tenantName ? `
          <div class="rc-tenant-row">
            <div class="rc-tenant-name">
              <div class="rc-avatar">${p.tenantName.charAt(0).toUpperCase()}</div>
              ${h(p.tenantName)}
            </div>
            <div class="rc-contact-links">
              ${phoneBtn}
              ${emailBtn}
            </div>
          </div>` : '<div style="font-size:13px;color:var(--text-3);">No tenant info recorded</div>'}

          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--text-3);">
              Lease: ${fmtDate(p.leaseStart)} → ${fmtDate(p.leaseEnd)}
            </span>
            <span class="reminder-pill" style="font-size:11px;">🔔 Reminder set at ${p.reminderDays || 60}d</span>
            ${p.annualRent ? `<span style="font-size:12px;font-weight:600;color:var(--success);">AED ${num(p.annualRent)}/yr</span>` : ''}
          </div>
        </div>

        <div class="rc-right">
          <div class="rc-countdown ${cdClass}">${days < 0 ? Math.abs(days) : days}</div>
          <div class="rc-countdown-label">${countdownLabel}</div>
          <div class="rc-lease-dates">${fmtDate(p.leaseEnd)}</div>
          <div class="rc-actions">
            <button class="rc-btn" onclick="event.stopPropagation();openEditModal('${p.id}')">Edit</button>
            <button class="rc-btn primary" onclick="event.stopPropagation();openDetailModal('${p.id}');showTab('dashboard');">View</button>
          </div>
        </div>
      </div>
    </div>`;
}

// ─── Lightbox ─────────────────────────────────────
function openLightbox(items, index) {
  lbItems = items; lbIndex = index;
  $('lightboxOverlay').classList.add('active');
  renderLightboxItem();
}

function renderLightboxItem() {
  const item    = lbItems[lbIndex];
  const content = $('lightboxContent');
  const caption = $('lightboxCaption');
  content.innerHTML = '';

  if (isVideo(item.mime)) {
    const vid = document.createElement('video');
    vid.src = item.data; vid.controls = true; vid.autoplay = true;
    vid.style.cssText = 'max-width:90vw;max-height:82vh;border-radius:8px;outline:none;';
    content.appendChild(vid);
  } else {
    const img = document.createElement('img');
    img.src = item.data; img.alt = item.name;
    content.appendChild(img);
  }

  caption.textContent = `${item.name}  (${lbIndex + 1} / ${lbItems.length})`;
  $('lightboxPrev').disabled = lbIndex === 0;
  $('lightboxNext').disabled = lbIndex === lbItems.length - 1;
}

function lightboxNav(dir) {
  if (!lbItems.length) return;
  const next = lbIndex + dir;
  if (next < 0 || next >= lbItems.length) return;
  lbIndex = next;
  renderLightboxItem();
}

function closeLightbox() {
  $('lightboxOverlay').classList.remove('active');
  $('lightboxContent').innerHTML = ''; // stop video
  lbItems = []; lbIndex = 0;
}

// ─── Toast ────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'success') {
  const el = $('toast');
  el.textContent = (type === 'success' ? '✓  ' : '✕  ') + msg;
  el.className   = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ─── Helpers ──────────────────────────────────────
function h(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str || ''));
  return d.innerHTML;
}

// WhatsApp link — strips non-digits, prepends country code if needed
function waLink(phone, tenantName, propName) {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  // If starts with 0, assume UAE and replace with 971
  if (digits.startsWith('0')) digits = '971' + digits.slice(1);
  const msg = encodeURIComponent(
    `Hello ${tenantName || 'there'},\n\nThis is a message regarding your tenancy for ${propName || 'the property'}.\n\nPlease feel free to reach out if you have any questions.\n\nThank you.`
  );
  return `https://wa.me/${digits}?text=${msg}`;
}
function num(val)  { return val ? Number(val).toLocaleString() : '—'; }

// Format property usage value for display ('labour_camp' → 'Labour Camp')
function _fmtUsage(u) {
  if (!u) return '';
  return String(u).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function iso()     { return new Date().toISOString(); }
function cap(str)  { return str.charAt(0).toUpperCase() + str.slice(1); }
function isVideo(mime) { return (mime || '').startsWith('video/'); }

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-AE', { day: '2-digit', month: 'short', year: 'numeric' });
}
function yieldPct(rent, price) {
  if (!rent || !price) return '—';
  return ((Number(rent) / Number(price)) * 100).toFixed(2) + '%';
}
function daysRemaining(leaseEnd) {
  const days = Math.ceil((new Date(leaseEnd) - new Date()) / 86400000);
  return days < 0 ? `Expired ${Math.abs(days)}d ago` : `${days} days`;
}
function daysClass(leaseEnd, reminderDays) {
  const days      = Math.ceil((new Date(leaseEnd) - new Date()) / 86400000);
  const threshold = Number(reminderDays) || 60;
  if (days < 0) return 'red'; if (days <= threshold) return 'gold'; return 'green';
}

// ═══════════════════════════════════════════════════
// DISPUTES
// ═══════════════════════════════════════════════════
function loadDisputes()        { return _api.disputes.load(); }
function persistDisputes(arr)  { _api.disputes.save(arr); }

const DISPUTE_TYPES = {
  'court':          '⚖️ Court Case',
  'rental-dispute': '🏠 Rental Dispute',
  'mediation':      '🤝 Mediation',
  'arbitration':    '📋 Arbitration',
  'other':          '📌 Other',
};
const DISPUTE_STATUS = {
  'active':    { label: 'Active',     cls: 'badge-danger'  },
  'pending':   { label: 'Pending',    cls: 'badge-warn'    },
  'appealed':  { label: 'Appealed',   cls: 'badge-blue'    },
  'resolved':  { label: 'Resolved',   cls: 'badge-success' },
  'withdrawn': { label: 'Withdrawn',  cls: 'badge-gray'    },
};

// ─── Payment Structure ────────────────────────────
function renderPayments() {
  const statusF = $('pmtFilterStatus')?.value || '';
  const typeF   = $('pmtFilterType')?.value   || '';
  const props   = loadProps();

  // Collect all cheques across all properties
  const rows = [];
  props.forEach(p => {
    if (!p.cheques?.length) return;
    p.cheques.forEach(c => {
      rows.push({ prop: p, cheque: c });
    });
  });

  // Filter
  const filtered = rows.filter(r => {
    if (statusF && r.cheque.status !== statusF) return false;
    if (typeF   && r.prop.type     !== typeF)   return false;
    return true;
  });

  // Stats
  const total    = filtered.length;
  const received = filtered.filter(r => r.cheque.status === 'received').length;
  const pending  = filtered.filter(r => r.cheque.status === 'pending').length;
  const bounced  = filtered.filter(r => r.cheque.status === 'bounced').length;
  const totalAmt = filtered.reduce((s, r) => s + (Number(r.cheque.amount) || 0), 0);
  const rcvdAmt  = filtered.filter(r => r.cheque.status === 'received').reduce((s, r) => s + (Number(r.cheque.amount) || 0), 0);

  // Aggregate additional charges across the same filtered properties
  const propIdsInView = new Set(filtered.map(r => r.prop.id));
  const propsInView   = props.filter(p => propIdsInView.has(p.id));
  const totalService  = propsInView.reduce((s,p) => s + (Number(p.serviceCharges)||0), 0);
  const totalMaint    = propsInView.reduce((s,p) => s + (Number(p.maintenanceFees)||0), 0);
  const totalVat      = propsInView.reduce((s,p) => s + Math.round((Number(p.annualRent)||0) * 0.05), 0);

  $('paymentStatsBar').innerHTML = `
    <div class="ts-chip ts-chip-default">💳 ${total} Cheque${total !== 1 ? 's' : ''}</div>
    <div class="ts-chip ts-chip-success">✅ ${received} Received</div>
    <div class="ts-chip ts-chip-warn">⏳ ${pending} Pending</div>
    <div class="ts-chip ts-chip-danger">❌ ${bounced} Bounced</div>
    ${totalAmt ? `<div class="ts-chip ts-chip-default" style="margin-left:auto;">Total: AED ${totalAmt.toLocaleString()}</div>` : ''}
    ${rcvdAmt  ? `<div class="ts-chip ts-chip-success">Collected: AED ${rcvdAmt.toLocaleString()}</div>` : ''}
    ${totalService ? `<div class="ts-chip ts-chip-default">Service: AED ${totalService.toLocaleString()}</div>` : ''}
    ${totalMaint   ? `<div class="ts-chip ts-chip-default">Maintenance: AED ${totalMaint.toLocaleString()}</div>` : ''}
    ${totalVat     ? `<div class="ts-chip ts-chip-default">VAT: AED ${totalVat.toLocaleString()}</div>` : ''}
  `;

  const table  = $('paymentTable');
  const empty  = $('paymentEmpty');

  if (!filtered.length) {
    table.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  // Group by property
  const byProp = {};
  filtered.forEach(r => {
    const id = r.prop.id;
    if (!byProp[id]) byProp[id] = { prop: r.prop, cheques: [] };
    byProp[id].cheques.push(r.cheque);
  });

  const typeIcon = t => t === 'warehouse' ? '🏭' : t === 'office' ? '🏢' : '🏠';

  table.innerHTML = Object.values(byProp).map(g => {
    const sc   = Number(g.prop.serviceCharges)  || 0;
    const mf   = Number(g.prop.maintenanceFees) || 0;
    const vat  = Math.round((Number(g.prop.annualRent) || 0) * 0.05);
    const addTotal = sc + mf + vat;
    return `
    <div class="pmt-group">
      <div class="pmt-group-header">
        <span class="pmt-prop-icon">${typeIcon(g.prop.type)}</span>
        <span class="pmt-prop-name">${h(g.prop.name)}</span>
        ${g.prop.tenantName ? `<span class="pmt-tenant">👤 ${h(g.prop.tenantName)}</span>` : ''}
        ${g.prop.annualRent ? `<span class="pmt-rent">AED ${num(g.prop.annualRent)} / yr</span>` : ''}
        <button class="pmt-edit-btn" onclick="openChequeEditModal('${g.prop.id}')">Edit Cheques</button>
      </div>
      <div class="pmt-table">
        <div class="pmt-thead">
          <span>#</span><span>Cheque No.</span><span>Cheque Date</span><span>Amount</span><span>Status</span><span>Fees</span>
        </div>
        ${g.cheques.map((c, i) => `
        <div class="pmt-trow pmt-trow-${c.status || 'pending'}">
          <span class="pmt-num">${c.n || i + 1}</span>
          <span>${h(c.noText || '—')}</span>
          <span>${fmtDate(c.date) || '—'}</span>
          <span class="pmt-amount">${c.amount ? 'AED ' + num(c.amount) : '—'}</span>
          <span>
            <span class="pmt-badge pmt-badge-${c.status || 'pending'}">${
              c.status === 'received' ? '✅ Received'
              : c.status === 'bounced' ? '❌ Bounced'
              : c.status === 'late'    ? '⚠️ Late'
              : '⏳ Pending'
            }</span>
          </span>
          <span style="color:${c.lateFees?'var(--danger)':'#9ca3af'};font-weight:${c.lateFees?'600':'400'};">${c.lateFees ? 'AED ' + num(c.lateFees) : '—'}</span>
        </div>`).join('')}
      </div>
      ${addTotal ? `
      <div class="pmt-additional">
        <div class="pmt-add-title">Additional Charges</div>
        <div class="pmt-add-grid">
          ${sc  ? `<div class="pmt-add-item"><span class="pmt-add-lbl">Service Charges</span><span class="pmt-add-val">AED ${num(sc)} / yr</span></div>` : ''}
          ${mf  ? `<div class="pmt-add-item"><span class="pmt-add-lbl">Annual Maintenance</span><span class="pmt-add-val">AED ${num(mf)} / yr</span></div>` : ''}
          ${vat ? `<div class="pmt-add-item"><span class="pmt-add-lbl">VAT (5% on rent)</span><span class="pmt-add-val">AED ${num(vat)}</span></div>` : ''}
          <div class="pmt-add-item pmt-add-total"><span class="pmt-add-lbl">Sub-total</span><span class="pmt-add-val">AED ${num(addTotal)}</span></div>
        </div>
      </div>` : ''}
    </div>
  `;}).join('');
}

// ─── Proposal Modal ───────────────────────────────
const PSL_ORDINAL = ['First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth','Ninth','Tenth','Eleventh','Twelfth'];

function openProposalModal() {
  const today = new Date().toISOString().split('T')[0];
  const validUntil = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];
  const ref = 'PSP-' + new Date().getFullYear() + '-' + String(Math.floor(Math.random()*900)+100);

  $('pslRef').value        = ref;
  $('pslDate').value       = today;
  $('pslValidUntil').value = validUntil;
  $('pslTitle').value      = 'Rental Payment Structure Proposal';
  $('pslPreparedBy').value = 'ASG Commercial Properties';
  ['pslPropName','pslPropLocation','pslPropSize','pslPropType',
   'pslClientName','pslClientCompany','pslClientPhone','pslClientEmail',
   'pslAnnualRent','pslLessorName','pslTenancyFrom','pslTenancyTo',
   'pslVatAmount','pslMaintAmount','pslAdminAmount','pslDrecAmount',
   'pslVatPayable','pslMaintPayable','pslNotes',
  ].forEach(id => { const el = $(id); if (el) el.value = ''; });
  $('pslVatDate').value     = 'CDC';
  $('pslMaintDate').value   = 'CDC';
  $('pslAdminDate').value   = 'CDC';
  $('pslDrecDate').value    = 'Cheque/Card';
  $('pslAdminPayable').value = 'ASG Commercial Properties L.L.C';
  $('pslDrecPayable').value  = 'DUBAI REAL ESTATE CORPORATION';
  $('pslNumCheques').value   = '4';
  $('pslTerms').value        = 'All post-dated cheques to be submitted upon signing of the tenancy contract\nSecurity deposit is fully refundable at end of tenancy, subject to property condition\nService charges are payable separately as per RERA / DLD regulations\nThis proposal is subject to final approval and signing of a formal tenancy agreement';

  $('proposalChequeFields').innerHTML = '';
  $('pslRentTotal').style.display = 'none';
  const prevEl = $('proposalTotalPreview');
  if (prevEl) prevEl.style.display = 'none';

  const props = loadProps();
  $('pslPropLink').innerHTML = '<option value="">— Select property to auto-fill —</option>' +
    props.map(p => `<option value="${p.id}">${p.name} (${p.type||''})</option>`).join('');

  // Render initial 4-cheque skeleton
  renderProposalCheques();

  $('proposalOverlay').classList.add('active');
}

function closeProposalModal() {
  $('proposalOverlay').classList.remove('active');
}

function autofillProposalProperty() {
  const id = $('pslPropLink').value;
  if (!id) return;
  const p = loadProps().find(x => x.id === id);
  if (!p) return;
  $('pslPropName').value     = p.name     || '';
  $('pslPropLocation').value = p.location || '';
  $('pslPropSize').value     = p.size     || '';
  const typeMap = { warehouse: 'Warehouse', office: 'Office', residential: 'Residential' };
  $('pslPropType').value = typeMap[p.type] || '';
  if (p.annualRent)  $('pslAnnualRent').value = p.annualRent;
  // Sync property's service charges, maintenance fees, and VAT into the proposal
  if (p.serviceCharges)  $('pslServiceAmount').value = p.serviceCharges;
  if (p.maintenanceFees) $('pslMaintAmount').value   = p.maintenanceFees;
  if (p.vat || p.annualRent) $('pslVatAmount').value = p.vat || Math.round(Number(p.annualRent) * 0.05);
  if (p.tenantName)  $('pslClientName').value  = p.tenantName;
  if (p.tenantPhone) $('pslClientPhone').value = p.tenantPhone;
  if (p.tenantEmail) $('pslClientEmail').value = p.tenantEmail;
  if (p.leaseStart)  $('pslTenancyFrom').value = p.leaseStart;
  if (p.leaseEnd)    $('pslTenancyTo').value   = p.leaseEnd;
  // Lessor: if managed property, the lessor IS the property owner;
  // otherwise default to ASG-style entity name (user can override).
  if (p.ownership === 'management' && p.ownerName) {
    $('pslLessorName').value = p.ownerName;
  } else if (p.partnerName) {
    $('pslLessorName').value = p.partnerName;
  }
  if (p.numCheques) $('pslNumCheques').value = p.numCheques;
  renderProposalCheques();
  recalcProposalCheques();
  recalcAdditionalCharges();
}

// Auto-set evenly-spaced cheque dates starting at the tenancy start
function autoSpacePslChequeDates() {
  const start = $('pslTenancyFrom')?.value;
  if (!start) return;
  const n = parseInt($('pslNumCheques').value) || 0;
  if (!n) return;
  const baseDate = new Date(start + 'T00:00:00');
  if (isNaN(baseDate)) return;
  const monthsPerCheque = 12 / n;
  const rows = $('proposalChequeFields').querySelectorAll('.psl-row');
  rows.forEach((row, i) => {
    const d = new Date(baseDate);
    d.setMonth(d.getMonth() + Math.round(i * monthsPerCheque));
    const iso = d.toISOString().split('T')[0];
    const inp = row.querySelector('.psl-date');
    if (inp && !inp.value) inp.value = iso;
  });
}

function recalcProposalCheques() {
  const n    = parseInt($('pslNumCheques').value) || 0;
  const rent = Number($('pslAnnualRent').value)   || 0;
  if (!n || !rent) { updatePslRentTotal(); return; }
  const per = Math.round(rent / n);
  $('proposalChequeFields').querySelectorAll('.psl-amount').forEach(inp => {
    inp.value = per;
  });
  // Auto-fill the Payable To if blank, defaulting to lessor name
  const lessor = ($('pslLessorName')?.value || '').trim();
  $('proposalChequeFields').querySelectorAll('.psl-payable').forEach(inp => {
    if (!inp.value && lessor) inp.value = lessor;
  });
  updatePslRentTotal();
  updateProposalGrandTotal();
}

// Auto-derive VAT (5% of rent) and the DREC line (20% sub-lease × 1.05 VAT)
function recalcAdditionalCharges() {
  const rent = Number($('pslAnnualRent').value) || 0;
  // 5% VAT auto-fills (still editable if user types over)
  const vatEl = $('pslVatAmount');
  if (vatEl && rent) vatEl.value = Math.round(rent * 0.05);
  // 20% DREC sub-lease × 1.05 VAT (does NOT include Ejari — user adds Ejari amount on top if desired)
  const drecEl = $('pslDrecAmount');
  if (drecEl && rent) drecEl.value = Math.round(rent * 0.20 * 1.05);
  updateProposalGrandTotal();
}

// Update the in-modal "TOTAL Rent Value" footer
function updatePslRentTotal() {
  let sum = 0;
  $('proposalChequeFields').querySelectorAll('.psl-amount').forEach(inp => {
    sum += Number(inp.value) || 0;
  });
  const wrap = $('pslRentTotal');
  const val  = $('pslRentTotalVal');
  if (!wrap || !val) return;
  if (sum > 0) {
    wrap.style.display = '';
    val.textContent = 'AED ' + sum.toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:2});
  } else {
    wrap.style.display = 'none';
  }
}

// Live grand total preview in the form (rent cheques + additional charges)
function updateProposalGrandTotal() {
  const gn = id => Number($(id)?.value) || 0;
  let chequeSum = 0;
  $('proposalChequeFields').querySelectorAll('.psl-amount').forEach(inp => {
    chequeSum += Number(inp.value) || 0;
  });
  const additional = gn('pslVatAmount') + gn('pslServiceAmount') + gn('pslMaintAmount') + gn('pslAdminAmount') + gn('pslDrecAmount');
  const grand = chequeSum + additional;

  const prevEl  = $('proposalTotalPreview');
  const totalEl = $('proposalGrandTotal');
  if (!prevEl || !totalEl) return;
  if (grand > 0) {
    prevEl.style.display = '';
    totalEl.textContent = 'AED ' + grand.toLocaleString();
  } else {
    prevEl.style.display = 'none';
  }
  updatePslRentTotal();
}

function renderProposalCheques() {
  const n    = parseInt($('pslNumCheques').value) || 4;
  const cont = $('proposalChequeFields');
  const rent = Number($('pslAnnualRent').value) || 0;
  const per  = n && rent ? Math.round(rent / n) : '';
  const lessor = ($('pslLessorName')?.value || '').trim();

  const existing = [];
  cont.querySelectorAll('.psl-row').forEach((row, i) => {
    existing[i] = {
      date:    row.querySelector('.psl-date')?.value    || '',
      amount:  row.querySelector('.psl-amount')?.value  || '',
      payable: row.querySelector('.psl-payable')?.value || '',
    };
  });

  let html = `<div class="cheque-table">
    <div class="cheque-head" style="grid-template-columns:34px 1.4fr 110px 1fr 1.4fr;">
      <span>#</span>
      <span>Particulars</span>
      <span>Cheque Date</span>
      <span>Amount (AED)</span>
      <span>Payable To</span>
    </div>`;
  for (let i = 0; i < n; i++) {
    const prev = existing[i] || {};
    const ord  = PSL_ORDINAL[i] || `Cheque ${i+1}`;
    html += `<div class="cheque-row psl-row" style="grid-template-columns:34px 1.4fr 110px 1fr 1.4fr;">
      <span class="cheque-num">${i+1}</span>
      <span class="psl-particulars">${ord} Rental Payment</span>
      <input type="date" class="psl-date" value="${prev.date || ''}">
      <input type="number" class="psl-amount" placeholder="${per || 'amount'}" min="0" value="${prev.amount || (per||'')}" oninput="updateProposalGrandTotal()">
      <input type="text"   class="psl-payable" placeholder="Defaults to Lessor" value="${prev.payable || lessor}">
    </div>`;
  }
  html += '</div>';
  cont.innerHTML = html;
  updatePslRentTotal();
}

function _readProposalForm() {
  const g  = id => $(id)?.value?.trim() || '';
  const gn = id => Number($(id)?.value) || 0;
  const cheques = [];
  $('proposalChequeFields').querySelectorAll('.psl-row').forEach((row, i) => {
    cheques.push({
      n:        i + 1,
      ord:      PSL_ORDINAL[i] || `Cheque ${i+1}`,
      date:     row.querySelector('.psl-date')?.value    || '',
      amount:   Number(row.querySelector('.psl-amount')?.value) || 0,
      payable:  row.querySelector('.psl-payable')?.value || '',
    });
  });
  return {
    id:           ($('pslEditId')?.value) || ('psl_' + uid()),
    title:        g('pslTitle')      || 'Rental Payment Structure Proposal',
    ref:          g('pslRef'),
    date:         g('pslDate'),
    validUntil:   g('pslValidUntil'),
    prepBy:       g('pslPreparedBy') || 'ASG Commercial Properties',
    propLink:     g('pslPropLink'),
    propName:     g('pslPropName'),
    propType:     g('pslPropType'),
    propLocation: g('pslPropLocation'),
    propSize:     gn('pslPropSize'),
    client:       g('pslClientName'),
    company:      g('pslClientCompany'),
    phone:        g('pslClientPhone'),
    email:        g('pslClientEmail'),
    rent:         gn('pslAnnualRent'),
    lessor:       g('pslLessorName'),
    tenancyFrom:  g('pslTenancyFrom'),
    tenancyTo:    g('pslTenancyTo'),
    numCheques:   parseInt(g('pslNumCheques')) || 0,
    vatAmount:    gn('pslVatAmount'),    vatDate:    g('pslVatDate'),    vatPayable:    g('pslVatPayable'),
    serviceAmount:gn('pslServiceAmount'),serviceDate:g('pslServiceDate'),servicePayable:g('pslServicePayable'),
    maintAmount:  gn('pslMaintAmount'),  maintDate:  g('pslMaintDate'),  maintPayable:  g('pslMaintPayable'),
    adminAmount:  gn('pslAdminAmount'),  adminDate:  g('pslAdminDate'),  adminPayable:  g('pslAdminPayable'),
    drecAmount:   gn('pslDrecAmount'),   drecDate:   g('pslDrecDate'),   drecPayable:   g('pslDrecPayable'),
    termsRaw:     g('pslTerms'),
    notes:        g('pslNotes'),
    cheques
  };
}

function downloadProposal() {
  const data = _readProposalForm();
  // Persist for the Proposals tab
  saveProposalRecord(data);
  printProposalDoc(data);
  closeProposalModal();
  if (typeof renderProposals === 'function') renderProposals();
  showToast('Proposal saved & opened for printing', 'success');
}

function printProposalDoc(d) {
  const title      = d.title      || 'Rental Payment Structure Proposal';
  const ref        = d.ref        || '';
  const date       = d.date       || '';
  const validUntil = d.validUntil || '';
  const prepBy     = d.prepBy     || 'ASG Commercial Properties';
  const propName   = d.propName   || '';
  const propType   = d.propType   || '';
  const propLoc    = d.propLocation || '';
  const propSize   = Number(d.propSize) || 0;
  const client     = d.client     || '';
  const company    = d.company    || '';
  const phone      = d.phone      || '';
  const email      = d.email      || '';
  const rent       = Number(d.rent) || 0;
  const lessor     = (d.lessor || '').trim() || prepBy;
  const tenancyFrom= d.tenancyFrom || '';
  const tenancyTo  = d.tenancyTo   || '';
  const numCheques = parseInt(d.numCheques) || 0;

  // Additional charges
  const vatAmount   = Number(d.vatAmount) || 0;
  const vatDate     = d.vatDate    || 'CDC';
  const vatPayable  = d.vatPayable || lessor;
  const serviceAmount = Number(d.serviceAmount) || 0;
  const serviceDate   = d.serviceDate    || 'CDC';
  const servicePayable= d.servicePayable || lessor;
  const maintAmount = Number(d.maintAmount) || 0;
  const maintDate   = d.maintDate    || 'CDC';
  const maintPayable= d.maintPayable || lessor;
  const adminAmount = Number(d.adminAmount) || 0;
  const adminDate   = d.adminDate    || 'CDC';
  const adminPayable= d.adminPayable || 'ASG Commercial Properties L.L.C';
  const drecAmount  = Number(d.drecAmount) || 0;
  const drecDate    = d.drecDate    || 'Cheque/Card';
  const drecPayable = d.drecPayable || 'DUBAI REAL ESTATE CORPORATION';

  const termsRaw   = d.termsRaw || '';
  const notes      = d.notes    || '';
  const terms      = termsRaw.split('\n').map(l => l.replace(/^[•\-*]\s*/,'')).filter(l => l.trim());

  const cheques = (d.cheques || []).map((c, i) => ({
    n:       i + 1,
    ord:     c.ord || PSL_ORDINAL[i] || `Cheque ${i+1}`,
    date:    c.date || '',
    amount:  Number(c.amount) || 0,
    payable: c.payable || lessor
  }));
  const rentTotal = cheques.reduce((s,c)=>s+(c.amount||0), 0);
  const grandTotal = rentTotal + vatAmount + serviceAmount + maintAmount + adminAmount + drecAmount;
  const modeOfPayment = numCheques ? `${numCheques} Cheque${numCheques>1?'s':''}` : '—';

  const fd = s => s ? new Date(s+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit',year:'numeric'}) : '—';
  const fa = n => n ? Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
  const fa0 = n => n ? 'AED ' + Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
  const he = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const doc = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${he(title)}${client?' — '+he(client):''}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#111;background:#fff;font-size:12.5px;line-height:1.5}
.page{max-width:820px;margin:0 auto;padding:0 44px 110px;position:relative;min-height:1100px}

/* ─── ASG Letterhead Header ─── */
.lh-header{position:relative;padding:22px 0 26px;margin-bottom:20px}
.lh-header-frame{
  border:2px solid #c9a84c;
  border-bottom:none;
  border-radius:70px 70px 0 0;
  height:130px;
  position:absolute;top:0;left:-44px;right:-44px;
  pointer-events:none;
}
.lh-logo-block{position:relative;padding:14px 0 0 6px;display:inline-block}
.lh-logo-icon{display:flex;align-items:flex-end;gap:2px;height:42px;margin-bottom:2px}
.lh-bar{background:#c9a84c;width:8px;border-radius:1px}
.lh-bar.b1{height:24px}
.lh-bar.b2{height:36px}
.lh-bar.b3{height:30px}
.lh-bar.b4{height:42px;width:10px}
.lh-divider{height:2px;width:440px;background:#c9a84c;margin:8px 0 0}
.lh-asg{font-size:34px;font-weight:900;letter-spacing:6px;color:#7a5d1e;line-height:1}
.lh-sub{font-size:11.5px;letter-spacing:2.6px;color:#7a5d1e;font-weight:700;margin-top:3px}

/* Document title block (right of header) */
.lh-doc-meta{position:absolute;right:0;top:34px;text-align:right;max-width:310px}
.doc-title{font-size:17px;font-weight:900;text-transform:uppercase;letter-spacing:.4px;color:#111}
.doc-ref{font-size:11px;color:#888;margin-top:2px}
.doc-dates{font-size:11px;color:#555;margin-top:4px}

/* ─── ASG Watermark ─── */
.lh-watermark{
  position:fixed;
  top:50%;left:50%;
  transform:translate(-50%,-50%);
  font-size:340px;font-weight:900;letter-spacing:30px;
  color:#f8efd5;
  z-index:0;
  pointer-events:none;
  user-select:none;
  white-space:nowrap;
}

/* Make sure all real content sits above the watermark */
.page > *{position:relative;z-index:1}

/* ─── ASG Letterhead Footer ─── */
.lh-footer{
  position:fixed;left:0;right:0;bottom:0;
  background:#1a1f2e;color:#fff;padding:14px 44px;
  z-index:5;
}
.lh-footer-grid{
  display:grid;
  grid-template-columns:1.1fr 1.1fr 1.6fr;
  gap:22px;
  max-width:820px;margin:0 auto;
  font-size:10.5px;line-height:1.4;
}
.lh-fcol{display:flex;flex-direction:column;gap:6px}
.lh-fitem{display:flex;align-items:center;gap:8px;color:#fff}
.lh-icon{
  width:18px;height:18px;border:1.2px solid #c9a84c;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;
  color:#c9a84c;font-size:9px;flex-shrink:0;
}

/* Brand row legacy hidden */
.brand-row{display:none}

/* Tenant/property summary block */
.tnt-summary{margin-bottom:18px}
.tnt-row{display:grid;grid-template-columns:170px 1fr;gap:14px;padding:3px 0;font-size:12px}
.tnt-lbl{color:#111;font-weight:700;text-transform:uppercase;letter-spacing:.4px;font-size:11px}
.tnt-val{color:#111;font-weight:600}
.tnt-val-em{color:#c9a84c;font-weight:800;font-size:13.5px}

/* Table title (centered, underlined italic) */
.tbl-title{text-align:center;font-size:14px;font-weight:800;font-style:italic;text-decoration:underline;text-underline-offset:3px;margin:18px 0 10px;text-transform:uppercase;letter-spacing:.5px}

/* Tables */
.psl-tbl{width:100%;border-collapse:collapse;margin-bottom:6px;border:1.5px solid #1a1a1a}
.psl-tbl th{background:#fef9d7;color:#111;padding:9px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;text-align:left;font-weight:800;border:1px solid #1a1a1a}
.psl-tbl td{padding:8px 12px;border:1px solid #d6d6d6;font-size:12px;vertical-align:middle}
.psl-tbl td.amt{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.psl-tbl td.center{text-align:center;color:#555}
.psl-tbl tr.total-row td{background:#fdf3d4;font-weight:800;border-top:2px solid #1a1a1a}
.psl-tbl tr.total-row td.lbl{color:#b91c1c;font-style:italic}
.psl-tbl tr.total-row td.val{color:#b91c1c}
.psl-tbl .italic{font-style:italic;color:#666;font-weight:400}

/* Terms / notes / signatures */
.terms-block{margin-top:24px;padding-top:14px;border-top:1px solid #ddd}
.terms-title{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#c9a84c;margin-bottom:8px}
ul.tlist{list-style:none}
ul.tlist li{padding:4px 0 4px 16px;position:relative;font-size:11.5px;color:#444;line-height:1.5}
ul.tlist li::before{content:'•';position:absolute;left:0;color:#c9a84c;font-weight:700}
.notes-box{background:#fffbf0;border:1px solid #e2c06a;border-radius:6px;padding:11px 14px;margin-top:14px;font-size:11.5px;color:#555}
.valid-bar{background:#f0fdf4;border:1px solid #a7f3d0;border-radius:6px;padding:9px 14px;margin-top:18px;font-size:11.5px;color:#065f46;text-align:center;font-weight:500}
.sigs{display:grid;grid-template-columns:1fr 1fr;gap:48px;margin-top:24px}
.sig{border-top:1.5px solid #111;padding-top:6px}
.sig-lbl{font-size:11px;color:#666}.sig-name{font-size:12px;font-weight:700;margin-top:1px}
.sig-space{height:38px}.sig-date{font-size:10.5px;color:#aaa;margin-top:6px}
.footer{margin-top:24px;padding-top:10px;border-top:1px solid #eee;text-align:center;font-size:9.5px;color:#bbb}
@media print{.page{padding:0 26px 110px}@page{size:A4;margin:10mm 10mm 0 10mm}}
</style></head><body>

<div class="lh-watermark">ASG</div>

<div class="page">

<div class="lh-header">
  <div class="lh-header-frame"></div>
  <div class="lh-logo-block">
    <div class="lh-logo-icon">
      <span class="lh-bar b1"></span>
      <span class="lh-bar b2"></span>
      <span class="lh-bar b3"></span>
      <span class="lh-bar b4"></span>
    </div>
    <div class="lh-asg">ASG</div>
    <div class="lh-sub">COMMERCIAL PROPERTIES L.L.C.</div>
    <div class="lh-divider"></div>
  </div>
  <div class="lh-doc-meta">
    <div class="doc-title">${he(title)}</div>
    ${ref ? `<div class="doc-ref">Ref: ${he(ref)}</div>` : ''}
    <div class="doc-dates">Date: ${fd(date)}${validUntil ? `&nbsp;&nbsp;|&nbsp;&nbsp;Valid Until: ${fd(validUntil)}` : ''}</div>
  </div>
</div>

<div class="tnt-summary">
  ${client       ? `<div class="tnt-row"><span class="tnt-lbl">Tenant Name:</span><span class="tnt-val">${he(client)}${company?` &nbsp;·&nbsp; ${he(company)}`:''}</span></div>` : ''}
  ${propName     ? `<div class="tnt-row"><span class="tnt-lbl">Property Details:</span><span class="tnt-val">${he(propName)}${propLoc?`, ${he(propLoc)}`:''}</span></div>` : ''}
  ${propSize     ? `<div class="tnt-row"><span class="tnt-lbl">Property Size:</span><span class="tnt-val">${Number(propSize).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} Sq.Ft</span></div>` : ''}
  ${(tenancyFrom||tenancyTo) ? `<div class="tnt-row"><span class="tnt-lbl">Tenancy Period:</span><span class="tnt-val">${fd(tenancyFrom)} to ${fd(tenancyTo)}</span></div>` : ''}
  ${rent         ? `<div class="tnt-row"><span class="tnt-lbl">Annual Rent:</span><span class="tnt-val tnt-val-em">${fa0(rent)}</span></div>` : ''}
  <div class="tnt-row"><span class="tnt-lbl">Mode of Payment:</span><span class="tnt-val">${he(modeOfPayment)}</span></div>
</div>

${cheques.length ? `
<div class="tbl-title">Rental Payment Breakdown</div>
<table class="psl-tbl">
  <thead><tr>
    <th style="width:34%">Particulars</th>
    <th style="width:18%">Cheque Date</th>
    <th style="width:18%;text-align:right">Amount in AED</th>
    <th style="width:30%">Payable To</th>
  </tr></thead>
  <tbody>
    ${cheques.map(c=>`<tr>
      <td>${he(c.ord)} Rental Payment</td>
      <td>${fd(c.date)}</td>
      <td class="amt">${fa(c.amount)}</td>
      <td>${he(c.payable)}</td>
    </tr>`).join('')}
    <tr class="total-row">
      <td class="lbl">TOTAL Rent Value <span class="italic">(exclusive of 5% VAT)</span></td>
      <td class="center">—</td>
      <td class="amt val">AED ${fa(rentTotal)}</td>
      <td class="center">—</td>
    </tr>
  </tbody>
</table>` : ''}

${(vatAmount||serviceAmount||maintAmount||adminAmount||drecAmount) ? `
<div class="tbl-title">Additional Charges</div>
<table class="psl-tbl">
  <thead><tr>
    <th style="width:34%">Particulars</th>
    <th style="width:18%">Cheque Date</th>
    <th style="width:18%;text-align:right">Amount in AED</th>
    <th style="width:30%">Payable To</th>
  </tr></thead>
  <tbody>
    ${vatAmount ? `<tr>
      <td>5% VAT on Rent</td>
      <td>${he(vatDate)}</td>
      <td class="amt">${fa(vatAmount)}</td>
      <td>${he(vatPayable)}</td>
    </tr>` : ''}
    ${serviceAmount ? `<tr>
      <td>Service Charges</td>
      <td>${he(serviceDate)}</td>
      <td class="amt">${fa(serviceAmount)}</td>
      <td>${he(servicePayable)}</td>
    </tr>` : ''}
    ${maintAmount ? `<tr>
      <td>Annual Maintenance Fee</td>
      <td>${he(maintDate)}</td>
      <td class="amt">${fa(maintAmount)}</td>
      <td>${he(maintPayable)}</td>
    </tr>` : ''}
    ${adminAmount ? `<tr>
      <td>Administration Fee <span class="italic">(inclusive of VAT)</span></td>
      <td>${he(adminDate)}</td>
      <td class="amt">${fa(adminAmount)}</td>
      <td>${he(adminPayable)}</td>
    </tr>` : ''}
    ${drecAmount ? `<tr>
      <td>20% DREC Sub-Lease Fee <span class="italic">(Inclusive of 5% VAT)</span> + Ejari Fees</td>
      <td>${he(drecDate)}</td>
      <td class="amt">${fa(drecAmount)}</td>
      <td>${he(drecPayable)}</td>
    </tr>` : ''}
  </tbody>
</table>` : ''}

${terms.length ? `
<div class="terms-block">
  <div class="terms-title">Terms &amp; Conditions</div>
  <ul class="tlist">${terms.map(t=>`<li>${he(t)}</li>`).join('')}</ul>
</div>` : ''}

${notes ? `<div class="notes-box"><strong>Note:</strong> ${he(notes)}</div>` : ''}

${validUntil ? `<div class="valid-bar">This proposal is valid until <strong>${fd(validUntil)}</strong>. All figures are subject to change after this date.</div>` : ''}

<div class="sigs">
  <div class="sig">
    <div class="sig-space"></div>
    <div class="sig-lbl">Landlord / Agent Signature</div>
    <div class="sig-name">${he(prepBy)}</div>
    <div class="sig-date">Date: _______________________</div>
  </div>
  <div class="sig">
    <div class="sig-space"></div>
    <div class="sig-lbl">Tenant / Client Signature</div>
    <div class="sig-name">${client ? he(client) : '_______________________'}</div>
    <div class="sig-date">Date: _______________________</div>
  </div>
</div>

</div>

<div class="lh-footer">
  <div class="lh-footer-grid">
    <div class="lh-fcol">
      <div class="lh-fitem"><span class="lh-icon">⌾</span>asg.commercial_properties</div>
      <div class="lh-fitem"><span class="lh-icon">⊕</span>www.asgholdings.ae</div>
    </div>
    <div class="lh-fcol">
      <div class="lh-fitem"><span class="lh-icon">✉</span>info@asggroup.ae</div>
      <div class="lh-fitem"><span class="lh-icon">☏</span>+971 4 264 2899</div>
    </div>
    <div class="lh-fcol">
      <div class="lh-fitem" style="align-items:flex-start;">
        <span class="lh-icon" style="margin-top:1px;">◉</span>
        <span>Office No. 1006, 10<sup>th</sup> Floor, Dubai National<br>Insurance Building, Port Saeed - Dubai</span>
      </div>
    </div>
  </div>
</div>

</body></html>`;

  const win = window.open('', '_blank');
  if (!win) { showToast('Allow pop-ups to download the PDF', 'error'); return; }
  win.document.write(doc);
  win.document.close();
  win.focus();
  setTimeout(() => {
    const imgs = win.document.images;
    if (!imgs.length) { win.print(); return; }
    let loaded = 0;
    Array.from(imgs).forEach(img => {
      const tick = () => { if (++loaded >= imgs.length) win.print(); };
      if (img.complete) tick();
      else { img.onload = tick; img.onerror = tick; }
    });
  }, 400);
}

function renderDisputes() {
  const items = loadDisputes();
  const grid  = $('disputesGrid');
  const empty = $('disputesEmpty');

  // Stats bar
  const active   = items.filter(d => d.status === 'active').length;
  const pending  = items.filter(d => d.status === 'pending').length;
  const resolved = items.filter(d => d.status === 'resolved').length;
  const totalAmt = items.reduce((s, d) => s + (Number(d.amountDisputed) || 0), 0);
  $('disputeStatsBar').innerHTML = items.length ? `
    <div class="ts-chip ts-chip-danger">🔴 ${active} Active</div>
    <div class="ts-chip ts-chip-warn">🟡 ${pending} Pending</div>
    <div class="ts-chip ts-chip-success">🟢 ${resolved} Resolved</div>
    ${totalAmt ? `<div class="ts-chip ts-chip-gold">💰 AED ${num(totalAmt)} total disputed</div>` : ''}
  ` : '';

  if (!items.length) { grid.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  grid.innerHTML = items.map(disputeCardHTML).join('');
}

function disputeCardHTML(d) {
  const st       = DISPUTE_STATUS[d.status] || { label: d.status || '—', cls: 'badge-gray' };
  const linked   = d.propertyId ? loadProps().find(p => p.id === d.propertyId) : null;
  const today    = new Date();
  let hearingTag = '';
  if (d.nextHearingDate) {
    const days = Math.ceil((new Date(d.nextHearingDate) - today) / 86400000);
    if      (days < 0)   hearingTag = `<span class="mini-badge badge-danger">Hearing overdue ${Math.abs(days)}d</span>`;
    else if (days <= 7)  hearingTag = `<span class="mini-badge badge-warn">Hearing in ${days}d</span>`;
    else                 hearingTag = `<span class="mini-badge badge-gray">Hearing ${fmtDate(d.nextHearingDate)}</span>`;
  }
  const waHref = d.lawyerPhone ? waLink(d.lawyerPhone, d.lawyer, d.title) : null;
  return `
    <div class="item-card" onclick="openEditDisputeModal('${d.id}')">
      <div class="ic-top">
        <div class="ic-left">
          <div class="ic-category">${DISPUTE_TYPES[d.type] || d.type || 'Dispute'}</div>
          <div class="ic-title">${h(d.title)}</div>
          ${linked ? `<div class="ic-sub">🏢 ${h(linked.name)}</div>` : ''}
        </div>
        <span class="ic-badge ${st.cls}">${st.label}</span>
      </div>
      <div class="ic-body">
        ${d.caseNo   ? `<div class="ic-row"><span class="ic-lbl">Case No.</span><span class="ic-val">${h(d.caseNo)}</span></div>` : ''}
        ${d.court    ? `<div class="ic-row"><span class="ic-lbl">Court</span><span class="ic-val">${h(d.court)}</span></div>` : ''}
        ${d.opponent ? `<div class="ic-row"><span class="ic-lbl">Opposing Party</span><span class="ic-val">${h(d.opponent)}</span></div>` : ''}
        ${d.filingDate ? `<div class="ic-row"><span class="ic-lbl">Filed</span><span class="ic-val">${fmtDate(d.filingDate)}</span></div>` : ''}
        ${d.amountDisputed ? `<div class="ic-row"><span class="ic-lbl">Amount</span><span class="ic-val gold">AED ${num(d.amountDisputed)}</span></div>` : ''}
        ${d.lawyer   ? `<div class="ic-row"><span class="ic-lbl">Lawyer</span><span class="ic-val">
          ${h(d.lawyer)}
          ${d.lawyerPhone ? `<a href="tel:${h(d.lawyerPhone)}" class="contact-link" onclick="event.stopPropagation()">📞 ${h(d.lawyerPhone)}</a>` : ''}
          ${waHref ? `<a href="${waHref}" target="_blank" class="wa-btn" onclick="event.stopPropagation()" style="padding:2px 8px;font-size:11px;">WhatsApp</a>` : ''}
        </span></div>` : ''}
        ${hearingTag ? `<div class="ic-row"><span class="ic-lbl">Next Hearing</span><span class="ic-val">${hearingTag}</span></div>` : ''}
        ${d.notes    ? `<div class="ic-notes">${h(d.notes)}</div>` : ''}
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        <button class="card-action-btn" onclick="openEditDisputeModal('${d.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        <button class="card-action-btn del" onclick="event.stopPropagation();quickDeleteDispute('${d.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
          Delete
        </button>
      </div>
    </div>`;
}

let currentDisputeId = null;

function openAddDisputeModal() {
  currentDisputeId = null;
  $('disputeModalTitle').textContent = 'Add Dispute / Case';
  $('disputeForm').reset();
  $('deleteDisputeBtn').style.display = 'none';
  populateDisputePropSelect(null);
  $('disputeModalOverlay').classList.add('active');
}

function openEditDisputeModal(id) {
  const d = loadDisputes().find(x => x.id === id);
  if (!d) return;
  currentDisputeId = id;
  $('disputeModalTitle').textContent = 'Edit Dispute / Case';
  $('deleteDisputeBtn').style.display = 'inline-flex';
  populateDisputePropSelect(d.propertyId);
  $('d_title').value         = d.title             || '';
  $('d_type').value          = d.type              || '';
  $('d_status').value        = d.status            || '';
  $('d_case_no').value       = d.caseNo            || '';
  $('d_court').value         = d.court             || '';
  $('d_opponent').value      = d.opponent          || '';
  $('d_filing_date').value   = d.filingDate        || '';
  $('d_hearing_date').value  = d.nextHearingDate   || '';
  $('d_amount').value        = d.amountDisputed    || '';
  $('d_lawyer').value        = d.lawyer            || '';
  $('d_lawyer_phone').value  = d.lawyerPhone       || '';
  $('d_notes').value         = d.notes             || '';
  $('disputeModalOverlay').classList.add('active');
}

function populateDisputePropSelect(selectedId) {
  $('d_property').innerHTML = '<option value="">— None —</option>' +
    loadProps().map(p => `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${h(p.name)}</option>`).join('');
}

function closeDisputeModal() {
  $('disputeModalOverlay').classList.remove('active');
  currentDisputeId = null;
}

function handleSaveDispute() {
  const title = $('d_title').value.trim();
  if (!title) { showToast('Dispute title is required', 'error'); return; }
  const items = loadDisputes();
  const item = {
    id:              currentDisputeId || uid(),
    title,
    propertyId:      $('d_property').value          || null,
    type:            $('d_type').value               || null,
    status:          $('d_status').value             || null,
    caseNo:          $('d_case_no').value.trim()     || null,
    court:           $('d_court').value.trim()       || null,
    opponent:        $('d_opponent').value.trim()    || null,
    filingDate:      $('d_filing_date').value        || null,
    nextHearingDate: $('d_hearing_date').value       || null,
    amountDisputed:  Number($('d_amount').value)     || null,
    lawyer:          $('d_lawyer').value.trim()      || null,
    lawyerPhone:     $('d_lawyer_phone').value.trim()|| null,
    notes:           $('d_notes').value.trim()       || null,
    createdAt: currentDisputeId ? (items.find(x => x.id === currentDisputeId)?.createdAt || iso()) : iso(),
    updatedAt: iso(),
  };
  if (currentDisputeId) {
    const idx = items.findIndex(x => x.id === currentDisputeId);
    if (idx >= 0) items[idx] = item; else items.push(item);
  } else {
    items.push(item);
  }
  persistDisputes(items);
  closeDisputeModal();
  renderDisputes();
  showToast(currentDisputeId ? 'Dispute updated' : 'Dispute added', 'success');
}

function deleteCurrentDispute() {
  if (!currentDisputeId) return;
  if (!confirm('Delete this dispute record? This cannot be undone.')) return;
  persistDisputes(loadDisputes().filter(x => x.id !== currentDisputeId));
  closeDisputeModal();
  renderDisputes();
  showToast('Dispute deleted', 'success');
}

function quickDeleteDispute(id) {
  if (!confirm('Delete this dispute? This cannot be undone.')) return;
  persistDisputes(loadDisputes().filter(x => x.id !== id));
  renderDisputes();
  showToast('Dispute deleted', 'success');
}


// ═══════════════════════════════════════════════════
// CONSTRUCTION PROJECTS
// ═══════════════════════════════════════════════════
function loadConstructionProjects()       { return _api.construction.load(); }
function persistConstructionProjects(arr) { _api.construction.save(arr); }

const PROJECT_TYPES = {
  'new-warehouse':  '🏗️ New Warehouse',
  'extension':      '📐 Extension',
  'renovation':     '🔧 Renovation',
  'office-fitout':  '🏢 Office Fitout',
  'infrastructure': '⚡ Infrastructure',
  'other':          '📌 Other',
};
const PROJECT_STATUS = {
  'planning':    { label: 'Planning',     cls: 'badge-gold',    fill: '#c9a84c' },
  'in-progress': { label: 'In Progress',  cls: 'badge-blue',    fill: '#2563eb' },
  'on-hold':     { label: 'On Hold',      cls: 'badge-warn',    fill: '#d97706' },
  'completed':   { label: 'Completed',    cls: 'badge-success', fill: '#059669' },
  'cancelled':   { label: 'Cancelled',    cls: 'badge-gray',    fill: '#9ca3af' },
};

function renderProjects() {
  const items = loadConstructionProjects();
  const grid  = $('constructionGrid');
  const empty = $('constructionEmpty');

  // Stats bar
  const inProg    = items.filter(p => p.status === 'in-progress').length;
  const planning  = items.filter(p => p.status === 'planning').length;
  const completed = items.filter(p => p.status === 'completed').length;
  const totalBudget = items.reduce((s, p) => s + (Number(p.budget) || 0), 0);
  const totalSpent  = items.reduce((s, p) => s + (Number(p.spentToDate) || 0), 0);
  $('constructionStatsBar').innerHTML = items.length ? `
    <div class="ts-chip ts-chip-blue">🔨 ${inProg} In Progress</div>
    <div class="ts-chip ts-chip-gold">📋 ${planning} Planning</div>
    <div class="ts-chip ts-chip-success">✅ ${completed} Completed</div>
    ${totalBudget ? `<div class="ts-chip ts-chip-gray">Budget: AED ${num(totalBudget)}</div>` : ''}
    ${totalSpent  ? `<div class="ts-chip ts-chip-gray">Spent: AED ${num(totalSpent)}</div>` : ''}
  ` : '';

  if (!items.length) { grid.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  grid.innerHTML = items.map(projectCardHTML).join('');
}

function projectCardHTML(p) {
  const st      = PROJECT_STATUS[p.status] || { label: p.status || '—', cls: 'badge-gray', fill: '#9ca3af' };
  const linked  = p.propertyId ? loadProps().find(x => x.id === p.propertyId) : null;
  const progress = Math.min(100, Math.max(0, Number(p.progress) || 0));
  const today   = new Date();
  let dueTag = '';
  if (p.expectedCompletion && p.status !== 'completed' && p.status !== 'cancelled') {
    const days = Math.ceil((new Date(p.expectedCompletion) - today) / 86400000);
    if      (days < 0)   dueTag = `<span class="mini-badge badge-danger">Overdue ${Math.abs(days)}d</span>`;
    else if (days <= 14) dueTag = `<span class="mini-badge badge-warn">${days}d to finish</span>`;
  }
  const budgetPct = (p.budget && p.spentToDate)
    ? Math.min(100, ((p.spentToDate / p.budget) * 100)).toFixed(0) : null;

  return `
    <div class="item-card" onclick="openEditProjectModal('${p.id}')">
      <div class="ic-top">
        <div class="ic-left">
          <div class="ic-category">${PROJECT_TYPES[p.type] || p.type || 'Project'}</div>
          <div class="ic-title">${h(p.name)}</div>
          ${linked    ? `<div class="ic-sub">🏢 ${h(linked.name)}</div>`
          : p.location? `<div class="ic-sub">📍 ${h(p.location)}</div>` : ''}
        </div>
        <span class="ic-badge ${st.cls}">${st.label}</span>
      </div>

      ${p.status !== 'planning' && p.status !== 'cancelled' ? `
      <div class="ic-progress">
        <div class="ic-progress-row">
          <span class="ic-progress-lbl">Progress</span>
          <span class="ic-progress-pct">${progress}%</span>
        </div>
        <div class="ic-progress-track">
          <div class="ic-progress-fill" style="width:${progress}%;background:${st.fill};"></div>
        </div>
      </div>` : ''}

      <div class="ic-body">
        ${p.contractor ? `<div class="ic-row"><span class="ic-lbl">Contractor</span><span class="ic-val">
          ${h(p.contractor)}
          ${p.contractorPhone ? `<a href="tel:${h(p.contractorPhone)}" class="contact-link" onclick="event.stopPropagation()">📞 ${h(p.contractorPhone)}</a>` : ''}
        </span></div>` : ''}
        ${p.startDate          ? `<div class="ic-row"><span class="ic-lbl">Start</span><span class="ic-val">${fmtDate(p.startDate)}</span></div>` : ''}
        ${p.expectedCompletion ? `<div class="ic-row"><span class="ic-lbl">Expected Done</span><span class="ic-val">${fmtDate(p.expectedCompletion)} ${dueTag}</span></div>` : ''}
        ${p.budget      ? `<div class="ic-row"><span class="ic-lbl">Budget</span><span class="ic-val gold">AED ${num(p.budget)}</span></div>` : ''}
        ${p.spentToDate ? `<div class="ic-row"><span class="ic-lbl">Spent</span><span class="ic-val ${budgetPct >= 90 ? 'red' : ''}">AED ${num(p.spentToDate)}${budgetPct ? ` · ${budgetPct}%` : ''}</span></div>` : ''}
        ${p.notes       ? `<div class="ic-notes">${h(p.notes)}</div>` : ''}
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        <button class="card-action-btn" onclick="openEditProjectModal('${p.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        <button class="card-action-btn del" onclick="event.stopPropagation();quickDeleteProject('${p.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
          Delete
        </button>
      </div>
    </div>`;
}

let currentProjectId = null;

function openAddProjectModal() {
  currentProjectId = null;
  $('projectModalTitle').textContent = 'Add Construction Project';
  $('projectForm').reset();
  $('p_progress_val').textContent = '0%';
  $('deleteProjectBtn').style.display = 'none';
  populateProjectPropSelect(null);
  $('constructionModalOverlay').classList.add('active');
}

function openEditProjectModal(id) {
  const p = loadConstructionProjects().find(x => x.id === id);
  if (!p) return;
  currentProjectId = id;
  $('projectModalTitle').textContent = 'Edit Construction Project';
  $('deleteProjectBtn').style.display = 'inline-flex';
  populateProjectPropSelect(p.propertyId);
  $('p_name').value             = p.name              || '';
  $('p_location').value         = p.location          || '';
  $('p_type').value             = p.type              || '';
  $('p_status').value           = p.status            || '';
  $('p_contractor').value       = p.contractor        || '';
  $('p_contractor_phone').value = p.contractorPhone   || '';
  $('p_start_date').value       = p.startDate         || '';
  $('p_expected').value         = p.expectedCompletion|| '';
  $('p_budget').value           = p.budget            || '';
  $('p_spent').value            = p.spentToDate       || '';
  $('p_progress').value         = p.progress          || 0;
  $('p_progress_val').textContent = (p.progress || 0) + '%';
  $('p_notes').value            = p.notes             || '';
  $('constructionModalOverlay').classList.add('active');
}

function populateProjectPropSelect(selectedId) {
  $('p_property').innerHTML = '<option value="">— None (standalone) —</option>' +
    loadProps().map(p => `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${h(p.name)}</option>`).join('');
}

function closeProjectModal() {
  $('constructionModalOverlay').classList.remove('active');
  currentProjectId = null;
}

function handleSaveProject() {
  const name = $('p_name').value.trim();
  if (!name) { showToast('Project name is required', 'error'); return; }
  const items = loadConstructionProjects();
  const item = {
    id:                  currentProjectId || uid(),
    name,
    propertyId:          $('p_property').value              || null,
    location:            $('p_location').value.trim()       || null,
    type:                $('p_type').value                  || null,
    status:              $('p_status').value                || null,
    contractor:          $('p_contractor').value.trim()     || null,
    contractorPhone:     $('p_contractor_phone').value.trim()|| null,
    startDate:           $('p_start_date').value            || null,
    expectedCompletion:  $('p_expected').value              || null,
    budget:              Number($('p_budget').value)        || null,
    spentToDate:         Number($('p_spent').value)         || null,
    progress:            Number($('p_progress').value)      || 0,
    notes:               $('p_notes').value.trim()          || null,
    createdAt: currentProjectId ? (items.find(x => x.id === currentProjectId)?.createdAt || iso()) : iso(),
    updatedAt: iso(),
  };
  if (currentProjectId) {
    const idx = items.findIndex(x => x.id === currentProjectId);
    if (idx >= 0) items[idx] = item; else items.push(item);
  } else {
    items.push(item);
  }
  persistConstructionProjects(items);
  closeProjectModal();
  renderProjects();
  showToast(currentProjectId ? 'Project updated' : 'Project added', 'success');
}

function deleteCurrentProject() {
  if (!currentProjectId) return;
  if (!confirm('Delete this project? This cannot be undone.')) return;
  persistConstructionProjects(loadConstructionProjects().filter(x => x.id !== currentProjectId));
  closeProjectModal();
  renderProjects();
  showToast('Project deleted', 'success');
}

function quickDeleteProject(id) {
  if (!confirm('Delete this project? This cannot be undone.')) return;
  persistConstructionProjects(loadConstructionProjects().filter(x => x.id !== id));
  renderProjects();
  showToast('Project deleted', 'success');
}

// ═══════════════════════════════════════════════════
// MAP  (MapLibre GL JS + OpenFreeMap — always English)
// ═══════════════════════════════════════════════════
let mlMap     = null;
let mlMarkers = [];

function parseLatLng(p) {
  if (p.coords) {
    const parts = p.coords.split(',').map(s => parseFloat(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]))
      return { lat: parts[0], lng: parts[1] };
  }
  if (p.mapLink) {
    const url = p.mapLink;
    let m = url.match(/@(-?\d+\.?\d+),(-?\d+\.?\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    m = url.match(/[?&]q=(-?\d+\.?\d+),(-?\d+\.?\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    m = url.match(/ll=(-?\d+\.?\d+),(-?\d+\.?\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    m = url.match(/\/(-?\d{1,3}\.\d{4,}),(-?\d{1,3}\.\d{4,})/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  }
  return null;
}

function makePinEl(p) {
  const isWH  = p.type === 'warehouse';
  const isRes = p.type === 'residential';
  const color = isWH ? '#c9a84c' : isRes ? '#059669' : '#111111';
  const ring  = isWH ? '#8a6d20' : isRes ? '#036040' : '#555';
  const emoji = isWH ? '🏭' : isRes ? '🏠' : '🏢';
  const el = document.createElement('div');
  el.style.cssText = 'cursor:pointer;width:36px;height:46px;position:relative;filter:drop-shadow(0 3px 8px rgba(0,0,0,.4));';
  el.innerHTML = `
    <svg width="36" height="46" viewBox="0 0 36 46" xmlns="http://www.w3.org/2000/svg" style="display:block;">
      <path d="M18 0C8.059 0 0 8.059 0 18c0 12.255 18 28 18 28S36 30.255 36 18C36 8.059 27.941 0 18 0z" fill="${color}"/>
      <circle cx="18" cy="18" r="10" fill="white" fill-opacity="0.93"/>
      <circle cx="18" cy="18" r="10" fill="none" stroke="${ring}" stroke-width="1" stroke-opacity="0.3"/>
    </svg>
    <div style="position:absolute;top:8px;left:50%;transform:translateX(-50%);font-size:13px;line-height:1;user-select:none;">${emoji}</div>`;
  return el;
}

function initMapTab() {
  if (mlMap) { mlMap.remove(); mlMap = null; mlMarkers = []; }

  mlMap = new maplibregl.Map({
    container: 'leafletMap',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [55.2708, 25.2048],
    zoom: 10,
  });

  mlMap.addControl(new maplibregl.NavigationControl(), 'top-right');
  mlMap.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

  mlMap.on('load', () => {
    renderMapMarkers();
  });

  // Defensive: ensure canvas matches container after the layout settles.
  // On mobile the drawer-close animation can run while the map is initializing.
  requestAnimationFrame(() => mlMap && mlMap.resize());

  renderMapSidebar();
}

function renderMapMarkers() {
  mlMarkers.forEach(m => m.remove());
  mlMarkers = [];
  const props  = loadProps();
  const bounds = [];

  props.forEach(p => {
    const ll = parseLatLng(p);
    if (!ll) return;
    bounds.push([ll.lng, ll.lat]);

    const statusColor = p.status === 'rented' ? '#059669' : p.status === 'vacant' ? '#dc2626' : '#6b7280';
    const statusBg    = p.status === 'rented' ? '#d1fae5' : p.status === 'vacant' ? '#fee2e2' : '#f3f4f6';

    const popup = new maplibregl.Popup({ offset: [0, -46], closeButton: true, maxWidth: '250px' })
      .setHTML(`
        <div style="font-family:Inter,sans-serif;padding:4px 2px;">
          <div style="font-size:14px;font-weight:700;margin-bottom:4px;">${h(p.name)}</div>
          ${p.location ? `<div style="font-size:12px;color:#777;margin-bottom:8px;">📍 ${h(p.location)}</div>` : ''}
          ${p.status ? `<span style="background:${statusBg};color:${statusColor};padding:2px 9px;border-radius:8px;font-size:11px;font-weight:700;display:inline-block;margin-bottom:6px;">${p.status}</span>` : ''}
          ${p.tenantName ? `<div style="font-size:12px;margin-top:4px;">👤 ${h(p.tenantName)}</div>` : ''}
          ${p.annualRent ? `<div style="font-size:13px;font-weight:700;color:#c9a84c;margin-top:4px;">AED ${num(p.annualRent)}/yr</div>` : ''}
          ${p.leaseEnd   ? `<div style="font-size:11px;color:#999;margin-top:4px;">Lease ends ${fmtDate(p.leaseEnd)}</div>` : ''}
          <button onclick="showTab('${p.type==='warehouse'?'warehouses':p.type==='office'?'offices':'residential'}')" style="margin-top:10px;width:100%;background:#111;color:#fff;border:none;padding:7px 0;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">View Property →</button>
        </div>`);

    const marker = new maplibregl.Marker({ element: makePinEl(p), anchor: 'bottom' })
      .setLngLat([ll.lng, ll.lat])
      .setPopup(popup)
      .addTo(mlMap);

    mlMarkers.push(marker);
  });

  if (bounds.length > 1) {
    mlMap.fitBounds(
      [
        [Math.min(...bounds.map(b=>b[0])), Math.min(...bounds.map(b=>b[1]))],
        [Math.max(...bounds.map(b=>b[0])), Math.max(...bounds.map(b=>b[1]))],
      ],
      { padding: 60, maxZoom: 15 }
    );
  } else if (bounds.length === 1) {
    mlMap.flyTo({ center: bounds[0], zoom: 15 });
  }
}

function renderMapSidebar() {
  const props   = loadProps();
  const list    = $('mapPropertyList');
  const hint    = $('mapNoPinsHint');
  const hasPins = props.some(p => parseLatLng(p));

  if (!props.length) {
    list.innerHTML = '<div style="padding:20px 16px;color:var(--text-3);font-size:13px;text-align:center;">No properties added yet.</div>';
    hint.style.display = 'none';
    return;
  }
  hint.style.display = hasPins ? 'none' : 'block';

  list.innerHTML = props.map(p => {
    const ll    = parseLatLng(p);
    const isWH  = p.type === 'warehouse';
    const color = ll ? (isWH ? '#c9a84c' : '#111') : '#ddd';
    const sub   = p.location ? h(p.location) : ll ? '📍 Pinned' : '⚠️ No coordinates — edit to add';
    const statusDot = p.status === 'rented' ? '#059669' : p.status === 'vacant' ? '#dc2626' : 'transparent';
    return `
      <div class="map-prop-item${ll ? '' : ' map-prop-no-pin'}"
           onclick="${ll ? `flyToPin(${ll.lat},${ll.lng})` : `openEditModal('${p.id}')`}">
        <div style="position:relative;flex-shrink:0;">
          <span class="legend-dot" style="background:${color};width:12px;height:12px;display:block;"></span>
          ${p.status ? `<span style="position:absolute;bottom:-2px;right:-2px;width:6px;height:6px;border-radius:50%;background:${statusDot};border:1px solid #fff;"></span>` : ''}
        </div>
        <div class="map-prop-info">
          <div class="map-prop-name">${h(p.name)}</div>
          <div class="map-prop-loc">${sub}</div>
        </div>
        ${ll ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" style="flex-shrink:0;"><polyline points="9 18 15 12 9 6"/></svg>` : ''}
      </div>`;
  }).join('');
}

function flyToPin(lat, lng) {
  if (!mlMap) return;
  mlMap.flyTo({ center: [lng, lat], zoom: 16, duration: 1200 });
  setTimeout(() => {
    mlMarkers.forEach(m => {
      const c = m.getLngLat();
      if (Math.abs(c.lat - lat) < 0.0002 && Math.abs(c.lng - lng) < 0.0002) m.togglePopup();
    });
  }, 1300);
}

// ─── Agents & Tasks ───────────────────────────────
const AGENTS_KEY = 'asg_agents';
const TASKS_KEY  = 'asg_tasks';

// ── Agent role definitions ──────────────────────────
// Each role controls what the agent sees in their dashboard's Inventory
// tab plus a hint shown when adding/editing the agent.
const AGENT_ROLES = {
  sales: {
    label:    'Sales Agent',
    icon:     '🏷️',
    color:    '#0d9488',
    inventoryFilter: p => p.status === 'vacant',
    hint:     'Sees only vacant properties (the inventory available to lease/sell). Best for agents whose job is to find tenants/buyers.',
    defaultPerms: { viewFinancials: false, viewTenant: false, updateStatus: true, addNotes: true },
  },
  leasing: {
    label:    'Leasing Manager',
    icon:     '📋',
    color:    '#7c3aed',
    inventoryFilter: p => p.status === 'rented',
    hint:     'Sees rented properties for renewal, payment tracking, and tenant management. Hides vacant inventory.',
    defaultPerms: { viewFinancials: true,  viewTenant: true,  updateStatus: true, addNotes: true },
  },
  property_management: {
    label:    'Property Management Manager',
    icon:     '🏢',
    color:    '#b45309',
    inventoryFilter: p => p.ownership === 'management',
    hint:     'Sees only properties managed on behalf of external owners. Full access to owner details, management fees, tenant info, and disputes for that managed portfolio.',
    defaultPerms: { viewFinancials: true,  viewTenant: true,  updateStatus: true, addNotes: true },
  },
  general: {
    label:    'General Agent',
    icon:     '👤',
    color:    '#1c2b4a',
    inventoryFilter: () => true,
    hint:     'Full access to all properties (vacant and rented). Use for senior staff or all-rounder agents.',
    defaultPerms: { viewFinancials: false, viewTenant: true,  updateStatus: true, addNotes: true },
  },
  admin_assistant: {
    label:    'Admin Assistant',
    icon:     '📂',
    color:    '#475569',
    inventoryFilter: () => true,
    hint:     'Read-only support staff with full visibility but no status-change rights.',
    defaultPerms: { viewFinancials: false, viewTenant: true,  updateStatus: false, addNotes: true },
  },
};
function agentRoleMeta(role) { return AGENT_ROLES[role] || AGENT_ROLES.general; }

function loadAgents()  { return _api.users.load().filter(u => u.role !== 'admin'); }

// Task assignees: agents PLUS admins (so an admin can give a task to
// another admin). Returned objects always have a normalized .role for
// chip display: agents keep their sub-role, admins get role='admin'.
function loadTaskAssignees() {
  return _api.users.load().map(u => ({
    ...u,
    role: u.role === 'admin' ? 'admin' : (u.agentRole || u.role || ''),
  }));
}

// Custom saveAgents: the generic factory would diff against the FULL users
// cache (which includes admin) and try to DELETE admin every time we mutate
// agents. Scope the diff to the agent subset, and translate the frontend's
// `role` field (sub-role like 'sales') to the backend's `agentRole`.
function saveAgents(arr) {
  const before = new Map(loadAgents().map(x => [String(x.id), x]));
  const after  = new Map(arr.map(x => [String(x.id), x]));

  (async () => {
    // Deletes (only numeric backend IDs)
    for (const [id] of before) {
      if (!after.has(id) && /^\d+$/.test(id)) {
        try { await fetch(`/api/users/${id}`, { method: 'DELETE', credentials: 'same-origin' }); }
        catch (e) { console.warn('saveAgents delete failed:', e.message); }
      }
    }
    // Creates / updates
    for (const [id, item] of after) {
      const payload = {
        username:     item.username,
        password:     item.password,
        name:         item.name,
        role:         'agent',
        agentRole:    item.role,
        email:        item.email,
        phone:        item.phone,
        permissions:  item.permissions,
        isTeamLeader: item.isTeamLeader,
        teamLeaderId: item.teamLeaderId,
      };
      if (!before.has(id)) {
        try {
          const r = await fetch('/api/users', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            console.warn('saveAgents create failed:', err.error || r.status);
            if (typeof showToast === 'function') showToast(`Agent create failed: ${err.error || 'HTTP ' + r.status}`, 'error');
          }
        } catch (e) { console.warn('saveAgents create error:', e.message); }
      } else if (/^\d+$/.test(id)) {
        // Don't send password on update unless it changed
        if (!item.password) delete payload.password;
        try {
          await fetch(`/api/users/${id}`, {
            method: 'PATCH', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        } catch (e) { console.warn('saveAgents update error:', e.message); }
      }
    }
    await _api.users.fetch();   // re-sync the full users cache (includes admin)
  })();
}
function loadTasks()   { return _api.tasks.load(); }
function saveTasks(t)  { _api.tasks.save(t); }

const TASK_TYPE_META = {
  'find-tenant':  { icon: '🔍', label: 'Find Tenant' },
  'follow-up':    { icon: '📞', label: 'Follow Up' },
  'site-visit':   { icon: '🏗️', label: 'Site Visit' },
  'maintenance':  { icon: '🔧', label: 'Maintenance' },
  'documents':    { icon: '📄', label: 'Documents' },
  'negotiation':  { icon: '🤝', label: 'Negotiation' },
  'other':        { icon: '📌', label: 'Other' }
};

const TASK_STATUS_META = {
  'pending':     { label: 'Pending',     cls: 'ts-pending' },
  'in-progress': { label: 'In Progress', cls: 'ts-inprogress' },
  'done':        { label: 'Done',        cls: 'ts-done' },
  'cancelled':   { label: 'Cancelled',  cls: 'ts-cancelled' }
};

const PRIORITY_META = {
  'high':   { label: 'High',   cls: 'tp-high' },
  'medium': { label: 'Medium', cls: 'tp-medium' },
  'low':    { label: 'Low',    cls: 'tp-low' }
};

// ── Agent Modal ────────────────────────────────────
function openAgentModal(id) {
  const agents = loadAgents();
  const ag = id ? agents.find(a => a.id === id) : null;
  $('agentModalTitle').textContent = ag ? 'Edit Agent' : 'Add Agent';
  $('agentId').value       = ag ? ag.id : '';
  $('agentName').value     = ag ? ag.name     : '';
  // Role: legacy free-text agents may have arbitrary strings; map them to 'general' so the dropdown still works
  const roleVal = ag ? (ag.role || '') : 'sales';   // default new agents to "sales" since that's the most common case
  $('agentRole').value     = AGENT_ROLES[roleVal] ? roleVal : 'general';
  $('agentPhone').value    = ag ? (ag.phone   || '') : '';
  $('agentEmail').value    = ag ? (ag.email   || '') : '';
  $('agentUsername').value = ag ? ag.username : '';
  $('agentPassword').value = ag ? ag.password : '';
  const p = ag ? (ag.permissions || agentRoleMeta($('agentRole').value).defaultPerms) : agentRoleMeta($('agentRole').value).defaultPerms;
  $('permViewFinancials').checked = p.viewFinancials || false;
  $('permViewTenant').checked     = p.viewTenant !== false;
  $('permUpdateStatus').checked   = p.updateStatus !== false;
  $('permAddNotes').checked       = p.addNotes !== false;

  // Team hierarchy fields
  const isLeaderEl = $('agentIsLeader');
  if (isLeaderEl) isLeaderEl.checked = !!(ag && ag.isTeamLeader);
  populateReportsToDropdown(ag ? ag.id : '');
  const reportsTo = $('agentReportsTo');
  if (reportsTo) reportsTo.value = (ag && ag.teamLeaderId) || '';
  onTeamLeaderToggle();

  updateAgentRoleHint();
  // Re-bind role change to live-update hint and (for new agents) prefill perms
  const sel = $('agentRole');
  if (sel && !sel._asgBound) {
    sel.addEventListener('change', () => {
      updateAgentRoleHint();
      // Only auto-update permissions when adding a new agent, never on edit (user might have customised)
      if (!$('agentId').value) {
        const dp = agentRoleMeta(sel.value).defaultPerms;
        $('permViewFinancials').checked = dp.viewFinancials || false;
        $('permViewTenant').checked     = dp.viewTenant !== false;
        $('permUpdateStatus').checked   = dp.updateStatus !== false;
        $('permAddNotes').checked       = dp.addNotes !== false;
      }
    });
    sel._asgBound = true;
  }
  $('agentModalOverlay').classList.add('active');
  setTimeout(() => $('agentName').focus(), 100);
}

function updateAgentRoleHint() {
  const meta = agentRoleMeta($('agentRole').value);
  const hint = $('agentRoleHint');
  if (hint) hint.textContent = meta.hint || '';
}

// Team-leader helpers
function populateReportsToDropdown(excludeId) {
  const sel = document.getElementById('agentReportsTo');
  if (!sel) return;
  const leaders = loadAgents().filter(a => a.active !== false && a.isTeamLeader && a.id !== excludeId);
  sel.innerHTML = '<option value="">— Independent (no team leader) —</option>' +
    leaders.map(l => `<option value="${l.id}">${h(l.name)}</option>`).join('');
}
function onTeamLeaderToggle() {
  const isLeader = !!(document.getElementById('agentIsLeader') && document.getElementById('agentIsLeader').checked);
  const reportsToGroup = document.getElementById('agentReportsToGroup');
  if (reportsToGroup) reportsToGroup.style.display = isLeader ? 'none' : '';
  // A team leader can't also report to another leader (no nested hierarchy)
  if (isLeader) {
    const sel = document.getElementById('agentReportsTo');
    if (sel) sel.value = '';
  }
}

function closeAgentModal() { $('agentModalOverlay').classList.remove('active'); }

function saveAgent() {
  const name     = $('agentName').value.trim();
  const username = $('agentUsername').value.trim();
  const password = $('agentPassword').value;
  if (!name)                { showToast('Name is required', 'error'); return; }
  if (!username)            { showToast('Username is required', 'error'); return; }
  if (password.length < 6)  { showToast('Password must be at least 6 characters', 'error'); return; }

  const agents = loadAgents();
  const id = $('agentId').value;

  // Check username uniqueness
  const adminCreds = getCredentials();
  if (username === adminCreds.user) { showToast('Username already taken by admin', 'error'); return; }
  const conflict = agents.find(a => a.username === username && a.id !== id);
  if (conflict) { showToast('Username already taken by another agent', 'error'); return; }

  const isTeamLeader = !!($('agentIsLeader') && $('agentIsLeader').checked);
  const teamLeaderId = isTeamLeader ? '' : (($('agentReportsTo') && $('agentReportsTo').value) || '');

  const agentObj = {
    id:       id || ('agent_' + uid()),
    name, username, password,
    role:     $('agentRole').value.trim(),
    phone:    $('agentPhone').value.trim(),
    email:    $('agentEmail').value.trim(),
    active:   true,
    isTeamLeader,
    teamLeaderId,
    createdAt: id ? (agents.find(a=>a.id===id)||{}).createdAt : new Date().toISOString(),
    permissions: {
      viewFinancials: $('permViewFinancials').checked,
      viewTenant:     $('permViewTenant').checked,
      updateStatus:   $('permUpdateStatus').checked,
      addNotes:       $('permAddNotes').checked
    }
  };

  if (id) {
    const idx = agents.findIndex(a => a.id === id);
    if (idx > -1) agents[idx] = agentObj; else agents.push(agentObj);
  } else {
    agents.push(agentObj);
  }
  saveAgents(agents);
  closeAgentModal();
  showToast(id ? 'Agent updated' : 'Agent added', 'success');
  renderTeamTab();
}

function toggleAgentActive(id) {
  const agents = loadAgents();
  const ag = agents.find(a => a.id === id);
  if (!ag) return;
  ag.active = !ag.active;
  saveAgents(agents);
  renderTeamTab();
  showToast(ag.active ? 'Agent activated' : 'Agent deactivated', 'success');
}

function deleteAgent(id) {
  if (!confirm('Delete this agent? Their tasks will remain but will be unassigned.')) return;
  const agents = loadAgents().filter(a => a.id !== id);
  saveAgents(agents);
  // unassign tasks
  const tasks = loadTasks().map(t => t.agentId === id ? { ...t, agentId: '' } : t);
  saveTasks(tasks);
  renderTeamTab();
  showToast('Agent deleted', 'success');
}

// ── Task Modal ─────────────────────────────────────
function openTaskModal(id) {
  const assignees = loadTaskAssignees().filter(a => a.active);
  const props  = loadProps();
  const tasks  = loadTasks();
  const task   = id ? tasks.find(t => t.id === id) : null;

  $('taskModalTitle').textContent = task ? 'Edit Task' : 'Assign Task';
  $('taskId').value = task ? task.id : '';

  // Populate assignee dropdown — agents + admins (admins are flagged
  // with a 👑 prefix so it's clear who's who).
  $('taskAgent').innerHTML = '<option value="">— Select assignee —</option>' +
    assignees.map(a => {
      const label = a.role === 'admin' ? `👑 ${h(a.name)} (Admin)` : h(a.name);
      const selected = task && String(task.agentId) === String(a.id) ? ' selected' : '';
      return `<option value="${a.id}"${selected}>${label}</option>`;
    }).join('');

  // Populate property dropdown
  $('taskProp').innerHTML = '<option value="">— No specific property —</option>' +
    props.map(p => `<option value="${p.id}"${task && task.propId === p.id ? ' selected' : ''}>${h(p.name)}</option>`).join('');

  if (task) {
    $('taskType').value     = task.type     || 'find-tenant';
    $('taskTitle').value    = task.title    || '';
    $('taskPriority').value = task.priority || 'medium';
    $('taskDeadline').value = task.deadline || '';
    $('taskDesc').value     = task.description || '';
    // Show read-only status (agent controls this)
    const sm = TASK_STATUS_META[task.status] || TASK_STATUS_META['pending'];
    $('taskStatusDisplay').innerHTML = `<span class="task-status-badge ${sm.cls}" style="display:inline-block;">${sm.label}</span><span style="font-size:11px;color:var(--text-3);display:block;margin-top:4px;">🔒 Only the agent can update this</span>`;
  } else {
    $('taskType').value     = 'find-tenant';
    $('taskTitle').value    = '';
    $('taskPriority').value = 'medium';
    $('taskDeadline').value = '';
    $('taskDesc').value     = '';
    $('taskStatusDisplay').innerHTML = `<span class="task-status-badge ts-pending" style="display:inline-block;">Pending</span><span style="font-size:11px;color:var(--text-3);display:block;margin-top:4px;">🔒 Agent updates this when they start</span>`;
  }

  $('taskModalOverlay').classList.add('active');
  setTimeout(() => $('taskTitle').focus(), 100);
}
function closeTaskModal() { $('taskModalOverlay').classList.remove('active'); }

function saveTask() {
  const agentId = $('taskAgent').value;
  const title   = $('taskTitle').value.trim();
  if (!agentId) { showToast('Please select an agent', 'error'); return; }
  if (!title)   { showToast('Task title is required', 'error'); return; }

  const tasks  = loadTasks();
  const id     = $('taskId').value;
  const existing = id ? tasks.find(t => t.id === id) : null;

  const taskObj = {
    id:          id || ('task_' + uid()),
    agentId,
    propId:      $('taskProp').value,
    type:        $('taskType').value,
    title,
    priority:    $('taskPriority').value,
    deadline:    $('taskDeadline').value,
    // Status is ONLY changed by the agent — preserve existing status on edit
    status:      existing ? existing.status : 'pending',
    description: $('taskDesc').value.trim(),
    notes:       existing ? existing.notes : [],
    createdAt:   existing ? existing.createdAt : new Date().toISOString(),
    updatedAt:   new Date().toISOString()
  };

  if (id) {
    const idx = tasks.findIndex(t => t.id === id);
    if (idx > -1) tasks[idx] = taskObj; else tasks.push(taskObj);
  } else {
    tasks.push(taskObj);
  }
  saveTasks(tasks);
  closeTaskModal();
  showToast(id ? 'Task updated' : 'Task assigned', 'success');
  renderTeamTab();
  updateTaskBadge();
}

function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  saveTasks(loadTasks().filter(t => t.id !== id));
  renderTeamTab();
  updateTaskBadge();
  showToast('Task deleted', 'success');
}

function updateTaskStatus(id, status) {
  const tasks = loadTasks();
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  t.status = status;
  t.updatedAt = new Date().toISOString();
  saveTasks(tasks);
  // re-render whichever view is showing
  if (isAgentUser()) { showAgentTab(currentAgentTab); updateAgentBadges(); }
  else renderTeamTab();
  updateTaskBadge();
}

function updateTaskBadge() {
  const pending = loadTasks().filter(t => t.status === 'pending' || t.status === 'in-progress').length;
  const el = $('navCountTasks');
  if (el) { el.textContent = pending || ''; el.style.display = pending ? '' : 'none'; }
  if (typeof updateMyTasksBadge === 'function') updateMyTasksBadge();
}

// ── Task Notes ─────────────────────────────────────
let notesTaskId = null;
function openTaskNotes(taskId) {
  notesTaskId = taskId;
  const task = loadTasks().find(t => t.id === taskId);
  if (!task) return;
  $('taskNotesPropName').textContent = task.title;
  $('taskNotesTaskId').value = taskId;
  $('taskNoteInput').value = '';
  renderNotesList(task.notes || []);
  $('taskNotesOverlay').classList.add('active');
}
function closeTaskNotes() { $('taskNotesOverlay').classList.remove('active'); notesTaskId = null; }

function renderNotesList(notes) {
  if (!notes.length) {
    $('taskNotesList').innerHTML = `<p style="color:var(--text-3);font-size:13px;text-align:center;padding:8px 0;">No notes yet.</p>`;
    return;
  }
  $('taskNotesList').innerHTML = notes.slice().reverse().map(n => `
    <div class="task-note-item">
      <div class="task-note-text">${h(n.text)}</div>
      <div class="task-note-date">${formatDate(n.date)}</div>
    </div>`).join('');
}

function submitTaskNote() {
  const text = $('taskNoteInput').value.trim();
  if (!text) return;
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === notesTaskId);
  if (!task) return;
  if (!task.notes) task.notes = [];
  task.notes.push({ text, date: new Date().toISOString() });
  task.updatedAt = new Date().toISOString();
  saveTasks(tasks);
  $('taskNoteInput').value = '';
  renderNotesList(task.notes);
  showToast('Note added', 'success');
  if (isAgentUser()) { showAgentTab(currentAgentTab); updateAgentBadges(); }
  else renderTeamTab();
}

// ── Team Tab Render (admin) ────────────────────────
function renderTeamTab() {
  const agents  = loadAgents();
  const allTasks = loadTasks();
  const props   = loadProps();

  // Update filter dropdown — include admins as filter options too so a
  // task assigned to an admin can be isolated.
  const agentFilter = $('taskFilterAgent');
  if (agentFilter) {
    const cur = agentFilter.value;
    const filterList = loadTaskAssignees();
    agentFilter.innerHTML = '<option value="">All Assignees</option>' +
      filterList.map(a => {
        const label = a.role === 'admin' ? `👑 ${h(a.name)} (Admin)` : h(a.name);
        return `<option value="${a.id}"${String(cur)===String(a.id)?' selected':''}>${label}</option>`;
      }).join('');
  }

  // ── Agents list ──
  const agentsList = $('agentsList');
  if (!agents.length) {
    agentsList.innerHTML = `<div class="team-empty"><div class="empty-icon">👥</div><p>No agents yet. Add your first team member above.</p></div>`;
  } else {
    agentsList.innerHTML = agents.map(ag => {
      const agTasks = allTasks.filter(t => t.agentId === ag.id);
      const done    = agTasks.filter(t => t.status === 'done').length;
      const active  = agTasks.filter(t => t.status === 'pending' || t.status === 'in-progress').length;
      return `
        <div class="agent-card${ag.active ? '' : ' agent-inactive'}">
          <div class="agent-card-avatar">${ag.name.charAt(0).toUpperCase()}</div>
          <div class="agent-card-body">
            <div class="agent-card-name">${h(ag.name)} ${ag.isTeamLeader ? '<span class="chip" style="background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;">⭐ Team Leader</span>' : ''} ${ag.active ? '' : '<span class="chip" style="background:#fee2e2;color:#dc2626;font-size:10px;">Inactive</span>'}</div>
            <div class="agent-card-role">${(()=>{const m=agentRoleMeta(ag.role); return m.icon+' '+h(m.label);})()} ${ag.phone ? '· '+h(ag.phone) : ''}${(() => {
              if (ag.teamLeaderId) {
                const leader = loadAgents().find(x => x.id === ag.teamLeaderId);
                return leader ? ` · <span style="color:var(--text-3);">reports to ${h(leader.name)}</span>` : '';
              }
              return '';
            })()}</div>
            <div class="agent-card-stats">
              <span class="agent-stat"><strong>${active}</strong> active tasks</span>
              <span class="agent-stat"><strong>${done}</strong> done</span>
              <span class="agent-stat" style="color:var(--text-3);">@${h(ag.username)}</span>
            </div>
          </div>
          <div class="agent-card-actions">
            <button class="btn-icon-sm" onclick="openAgentModal('${ag.id}')" title="Edit">✏️</button>
            <button class="btn-icon-sm" onclick="toggleAgentActive('${ag.id}')" title="${ag.active?'Deactivate':'Activate'}">${ag.active?'🔒':'🔓'}</button>
            <button class="btn-icon-sm btn-danger-sm" onclick="deleteAgent('${ag.id}')" title="Delete">🗑️</button>
          </div>
        </div>`;
    }).join('');
  }

  // ── Tasks list ──
  const agentF  = ($('taskFilterAgent')  || {}).value || '';
  const statusF = ($('taskFilterStatus') || {}).value || '';
  let tasks = allTasks;
  if (agentF)  tasks = tasks.filter(t => t.agentId === agentF);
  if (statusF) tasks = tasks.filter(t => t.status  === statusF);

  const tasksList = $('tasksList');
  if (!tasks.length) {
    tasksList.innerHTML = `<div class="team-empty"><div class="empty-icon">📋</div><p>No tasks yet. Use "Assign Task" to create the first one.</p></div>`;
  } else {
    // Group by agent
    const grouped = {};
    tasks.forEach(t => {
      const key = t.agentId || '__unassigned__';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(t);
    });

    // Use the wider assignees list so tasks assigned to other admins
    // resolve to a name (and not "Unassigned").
    const assigneeLookup = loadTaskAssignees();
    tasksList.innerHTML = Object.entries(grouped).map(([agId, agTasks]) => {
      const ag = assigneeLookup.find(a => String(a.id) === String(agId));
      const agName = ag ? ag.name : 'Unassigned';

      const tasksHTML = agTasks.sort((a,b) => {
        const ord = { 'in-progress':0, pending:1, done:2, cancelled:3 };
        return (ord[a.status]||9) - (ord[b.status]||9);
      }).map(t => {
        const prop    = t.propId ? props.find(p => p.id === t.propId) : null;
        const tm      = TASK_TYPE_META[t.type] || TASK_TYPE_META['other'];
        const sm      = TASK_STATUS_META[t.status] || TASK_STATUS_META['pending'];
        const pm      = PRIORITY_META[t.priority] || PRIORITY_META['medium'];
        const overdue = t.deadline && t.status !== 'done' && t.status !== 'cancelled' && new Date(t.deadline) < new Date();
        const lastNote = t.notes && t.notes.length ? t.notes[t.notes.length - 1] : null;
        const progressBar = t.status === 'done' ? 100
                          : t.status === 'in-progress' ? 55
                          : t.status === 'cancelled' ? 0 : 10;
        return `
          <div class="task-card${t.status === 'done' ? ' task-done' : ''}${overdue ? ' task-overdue' : ''}">
            <div class="task-card-top">
              <div class="task-type-badge">${tm.icon} ${tm.label}</div>
              <div style="display:flex;gap:6px;align-items:center;">
                <span class="task-priority ${pm.cls}">${pm.label}</span>
                <span class="task-status-badge ${sm.cls}">${sm.label}</span>
              </div>
            </div>
            <div class="task-card-title">${isTaskUnread(t.id) ? '<span class="unread-dot" title="Unread reply"></span>' : ''}${h(t.title)}</div>
            ${prop ? `<div class="task-card-prop">🏗️ ${h(prop.name)}${prop.location?' · '+h(prop.location):''}</div>` : ''}
            ${t.description ? `<div class="task-card-desc">${h(t.description)}</div>` : ''}

            <!-- Progress bar (read-only for admin) -->
            <div class="task-progress-wrap">
              <div class="task-progress-bar">
                <div class="task-progress-fill ${t.status === 'done' ? 'prog-done' : t.status === 'in-progress' ? 'prog-active' : t.status === 'cancelled' ? 'prog-cancelled' : 'prog-pending'}"
                     style="width:${progressBar}%"></div>
              </div>
              <span class="task-progress-label">${progressBar}%</span>
            </div>

            ${lastNote ? `
            <div class="task-last-note">
              <span class="task-last-note-icon">${lastNote.authorType === 'admin' ? '👑' : '💬'}</span>
              <div>
                <div class="task-last-note-text">${h(lastNote.text)}</div>
                <div class="task-last-note-date">${formatDate(lastNote.date)} — ${h(lastNote.authorName || (lastNote.authorType === 'admin' ? 'Admin' : (ag ? ag.name : agName)))}</div>
              </div>
            </div>` : ''}

            <div class="task-card-meta">
              ${t.deadline ? `<span class="${overdue?'task-overdue-tag':'task-deadline'}">📅 ${overdue?'Overdue — ':''}${t.deadline}</span>` : ''}
              ${t.notes && t.notes.length ? `<span class="task-note-count">💬 ${t.notes.length} update${t.notes.length>1?'s':''}</span>` : '<span class="task-note-count" style="color:#bbb;">No updates yet</span>'}
            </div>
            <div class="task-card-actions">
              <button class="btn-sm btn-ghost" onclick="openTaskNotes('${t.id}')">💬 Reply (${t.notesCount != null ? t.notesCount : (t.notes ? t.notes.length : 0)})</button>
              <button class="btn-sm btn-ghost" onclick="openTaskModal('${t.id}')">✏️ Edit Task</button>
              <div class="task-readonly-badge">🔒 Status set by assignee</div>
              ${(() => {
                // Only the task creator (or the primary 'admin' user) can delete.
                const sess = getSession();
                const myId = String(sess?.userId || '');
                const isPrimary = sess?.name === 'Administrator' || myId === '1';
                const canDel = isPrimary || String(t.createdById || '') === myId;
                return canDel ? `<button class="btn-sm btn-danger" onclick="deleteTask('${t.id}')">🗑️</button>` : '';
              })()}
            </div>
          </div>`;
      }).join('');

      return `
        <div class="task-agent-group">
          <div class="task-agent-label">
            <div class="task-agent-avatar">${agName.charAt(0)}</div>
            ${h(agName)}
            <span style="font-size:12px;color:var(--text-3);font-weight:400;">${agTasks.length} task${agTasks.length>1?'s':''}</span>
          </div>
          ${tasksHTML}
        </div>`;
    }).join('');
  }

  updateTaskBadge();
}

// ── Agent Add Property ─────────────────────────────
function openAgentPropModal() {
  ['apName','apLocation','apClientName','apClientPhone','apNotes'].forEach(id => { const el=$(id); if(el) el.value=''; });
  const sEl=$('apSize'); if(sEl) sEl.value='';
  const rEl=$('apRent'); if(rEl) rEl.value='';
  $('apType').value = 'warehouse';
  $('agentPropModal').classList.add('active');
  setTimeout(() => $('apName').focus(), 100);
}
function closeAgentPropModal() { $('agentPropModal').classList.remove('active'); }

function saveAgentProperty() {
  const session = getSession();
  if (!session || session.type !== 'agent') return;
  const name = $('apName').value.trim();
  const clientName = $('apClientName').value.trim();
  if (!name)       { showToast('Property name is required', 'error'); return; }
  if (!clientName) { showToast('Client / owner name is required', 'error'); return; }

  const props = loadProps();
  const newProp = {
    id:               'prop_' + uid(),
    name,
    type:             $('apType').value,
    location:         $('apLocation').value.trim(),
    size:             $('apSize').value ? Number($('apSize').value) : '',
    annualRent:       $('apRent').value ? Number($('apRent').value) : '',
    status:           'vacant',
    ownership:        'sole',
    tenantName:       '',
    description:      $('apNotes').value.trim(),
    // Agent sourcing metadata
    addedByAgent:     session.agentId,
    addedByAgentName: session.name,
    clientName,
    clientPhone:      $('apClientPhone').value.trim(),
    addedAt:          new Date().toISOString(),
    files:            {},
    media:            []
  };
  props.push(newProp);
  persistProps(props);
  closeAgentPropModal();
  showToast('Property submitted — visible to admin', 'success');
  if (isAgentUser()) { showAgentTab(currentAgentTab); updateAgentBadges(); }
}

// ── Agent Dashboard Render ─────────────────────────
function renderAgentDashboard() {
  const session = getSession();
  if (!session || session.type !== 'agent') return;
  const { agentId, name, perms } = session;

  const allProps  = loadProps();
  const myTasks   = loadTasks().filter(t => t.agentId === agentId);
  const ag        = loadAgents().find(a => a.id === agentId) || {};

  const activeTasks = myTasks.filter(t => t.status === 'pending' || t.status === 'in-progress');
  const doneTasks   = myTasks.filter(t => t.status === 'done');
  const myAddedProps = allProps.filter(p => p.addedByAgent === agentId);

  // Wins = done tasks of type find-tenant or negotiation
  const wins = doneTasks.filter(t => t.type === 'find-tenant' || t.type === 'negotiation');

  // ── Welcome ──
  $('agentWelcome').innerHTML = `
    <div class="agent-welcome-inner">
      <div class="agent-welcome-avatar">${name.charAt(0).toUpperCase()}</div>
      <div style="flex:1;">
        <div class="agent-welcome-name">Welcome back, ${h(name)}</div>
        <div class="agent-welcome-role">${(()=>{const m=agentRoleMeta(ag.role); return m.icon+' '+h(m.label);})()}</div>
      </div>
      ${wins.length ? `<div class="agent-wins-chip">🏆 ${wins.length} Client Win${wins.length>1?'s':''}</div>` : ''}
    </div>`;

  // ── Stats bar ──
  $('agentStats').innerHTML = `
    <div class="agent-stat-card">
      <div class="agent-stat-num" style="color:#2563eb;">${activeTasks.length}</div>
      <div class="agent-stat-label">Active Tasks</div>
    </div>
    <div class="agent-stat-card">
      <div class="agent-stat-num" style="color:var(--success);">${doneTasks.length}</div>
      <div class="agent-stat-label">Completed</div>
    </div>
    <div class="agent-stat-card">
      <div class="agent-stat-num" style="color:var(--gold);">${wins.length}</div>
      <div class="agent-stat-label">Clients Won</div>
    </div>
    <div class="agent-stat-card">
      <div class="agent-stat-num" style="color:#8b5cf6;">${myAddedProps.length}</div>
      <div class="agent-stat-label">Properties Sourced</div>
    </div>`;

  // ── Client Wins ──
  const winsSection = $('agentWins');
  const winsList    = $('agentWinsList');
  if (wins.length) {
    winsSection.style.display = '';
    $('agentWinsCount').textContent = wins.length;
    winsList.innerHTML = wins.map(t => {
      const prop = t.propId ? allProps.find(p => p.id === t.propId) : null;
      const lastNote = t.notes && t.notes.length ? t.notes[t.notes.length - 1] : null;
      return `
        <div class="agent-win-card">
          <div class="agent-win-trophy">🏆</div>
          <div class="agent-win-body">
            <div class="agent-win-title">${h(t.title)}</div>
            ${prop ? `<div class="agent-win-prop">📍 ${h(prop.name)}${prop.location?' — '+h(prop.location):''}</div>` : ''}
            ${lastNote ? `<div class="agent-win-note">"${h(lastNote.text)}"</div>` : ''}
            <div class="agent-win-date">✅ Completed ${t.updatedAt ? formatDate(t.updatedAt) : ''}</div>
          </div>
        </div>`;
    }).join('');
  } else {
    winsSection.style.display = 'none';
  }

  // ── Tasks (legacy section — now also rendered by renderAgentTasksTab) ──
  const container = $('agentTasksList');
  if (!container) return;   // guard: tasks tab may not be in view
  if (!myTasks.length) {
    container.innerHTML = `<div class="team-empty"><div class="empty-icon">🎯</div><p>No tasks assigned yet. Check back soon.</p></div>`;
    return;
  }

  const order = { 'in-progress':0, pending:1, done:2, cancelled:3 };
  const sortedTasks = [...myTasks].sort((a,b) => (order[a.status]||9) - (order[b.status]||9));

  container.innerHTML = sortedTasks.map(t => {
    const prop = t.propId ? allProps.find(p => p.id === t.propId) : null;
    const tm   = TASK_TYPE_META[t.type] || TASK_TYPE_META['other'];
    const sm   = TASK_STATUS_META[t.status] || TASK_STATUS_META['pending'];
    const pm   = PRIORITY_META[t.priority]  || PRIORITY_META['medium'];
    const overdue = t.deadline && t.status !== 'done' && t.status !== 'cancelled' && new Date(t.deadline) < new Date();
    const notesCount = t.notes ? t.notes.length : 0;
    const lastNote   = notesCount ? t.notes[notesCount - 1] : null;

    return `
      <div class="agent-task-card${t.status==='done'?' agent-task-done':''}${overdue?' task-overdue':''}">
        <div class="task-card-top">
          <div class="task-type-badge">${tm.icon} ${tm.label}</div>
          <div style="display:flex;gap:6px;">
            <span class="task-priority ${pm.cls}">${pm.label}</span>
            <span class="task-status-badge ${sm.cls}">${sm.label}</span>
          </div>
        </div>
        <div class="task-card-title">${h(t.title)}</div>
        ${t.description ? `<div class="task-card-desc">${h(t.description)}</div>` : ''}
        ${prop ? `
          <div class="agent-task-prop-pill">
            🏗️ ${h(prop.name)}${prop.location?' · '+h(prop.location):''}
            ${prop.status==='vacant'?'<span style="color:var(--danger);font-size:11px;margin-left:6px;">● Vacant</span>':'<span style="color:var(--success);font-size:11px;margin-left:6px;">● Rented</span>'}
          </div>` : ''}
        <div class="task-card-meta">
          ${t.deadline ? `<span class="${overdue?'task-overdue-tag':'task-deadline'}">📅 ${overdue?'Overdue — ':''}${t.deadline}</span>` : ''}
          ${notesCount ? `<span class="task-note-count">💬 ${notesCount} update${notesCount>1?'s':''}</span>` : ''}
        </div>
        ${lastNote ? `<div class="task-last-note"><span class="task-last-note-icon">💬</span><div class="task-last-note-text">${h(lastNote.text)}</div></div>` : ''}
        <div class="task-card-actions">
          ${perms.addNotes !== false ? `<button class="btn-sm btn-ghost" onclick="openTaskNotes('${t.id}')">💬 Add Update (${notesCount})</button>` : ''}
          ${perms.updateStatus !== false && t.status !== 'done' && t.status !== 'cancelled' ? `
            ${t.status !== 'in-progress' ? `<button class="btn-sm btn-primary" onclick="updateTaskStatus('${t.id}','in-progress')">▶ Start</button>` : `<button class="btn-sm btn-ghost" disabled>⏳ In Progress</button>`}
            <button class="btn-sm btn-success" onclick="if(confirm('Mark this task as done?')) updateTaskStatus('${t.id}','done')">✓ Mark Done</button>
          ` : t.status === 'done' ? `<span style="color:var(--success);font-size:13px;font-weight:600;">✅ Completed</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

// Helper: format date nicely
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) +
         ' ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}

// ─── Calendar ─────────────────────────────────────
const CAL_KEY = 'asg_calendar';
let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth();   // 0-indexed
let selectedCalDate = null;             // 'YYYY-MM-DD'

function loadCalendarEvents()       { return _api.calendar.load(); }
function persistCalendarEvents(evs) { _api.calendar.save(evs); }

function isoDate(y, m, d) {
  return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function collectAllEvents() {
  const props = loadProps();
  const custom = loadCalendarEvents();
  const map = {};   // 'YYYY-MM-DD' → [{type, label, color, sub}]

  function add(dateStr, ev) {
    if (!dateStr) return;
    const d = dateStr.slice(0,10);
    if (!map[d]) map[d] = [];
    map[d].push(ev);
  }

  props.forEach(p => {
    const name = p.name || 'Property';

    // Cheques
    if (p.cheques && p.cheques.length) {
      p.cheques.forEach((c, i) => {
        if (!c.date) return;
        const st = (c.status || 'pending').toLowerCase();
        const colors = { pending:'#f59e0b', received:'#059669', bounced:'#dc2626' };
        add(c.date, {
          type: `cheque-${st}`,
          label: `Cheque ${i+1} – ${name}`,
          sub: c.amount ? `AED ${Number(c.amount).toLocaleString()}` : '',
          color: colors[st] || '#f59e0b',
          propId: p.id
        });
      });
    }

    // Lease dates
    if (p.leaseStart) add(p.leaseStart, { type:'lease-start', label:`Lease Start – ${name}`, sub:'', color:'#3b82f6', propId:p.id });
    if (p.leaseEnd)   add(p.leaseEnd,   { type:'lease-end',   label:`Lease End – ${name}`,   sub:'', color:'#ef4444', propId:p.id });

    // Reminders
    if (p.reminder) add(p.reminder, { type:'reminder', label:`Reminder – ${name}`, sub:'', color:'#8b5cf6', propId:p.id });
  });

  // Custom events
  custom.forEach(ev => {
    add(ev.date, {
      id: ev.id,
      type: `custom-${ev.eventType || 'other'}`,
      label: ev.title,
      sub: ev.note || (ev.time ? ev.time : ''),
      color: '#c9a84c',
      deletable: true
    });
  });

  return map;
}

function renderCalendar() {
  const now    = new Date();
  const today  = isoDate(now.getFullYear(), now.getMonth(), now.getDate());
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  document.getElementById('calMonthLabel').textContent = `${months[calMonth]} ${calYear}`;

  const evMap = collectAllEvents();
  const grid  = document.getElementById('calGrid');

  // First weekday of the month (Mon=0 … Sun=6)
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const startOffset = (firstDay + 6) % 7;  // shift Sun(0)→6, Mon(1)→0
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  let html = '';

  // Empty leading cells
  for (let i = 0; i < startOffset; i++) html += `<div class="cal-cell cal-empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = isoDate(calYear, calMonth, d);
    const isToday = dateStr === today;
    const evs     = evMap[dateStr] || [];
    const MAX_SHOW = 3;

    const pillsHTML = evs.slice(0, MAX_SHOW).map(ev =>
      `<div class="cal-ev cal-ev-${ev.type.split('-')[0] === 'cheque' ? ev.type : ev.type.startsWith('custom') ? 'custom' : ev.type}"
            title="${h(ev.label)}"
            style="border-left-color:${ev.color};">
        ${h(ev.label.length > 22 ? ev.label.slice(0,22)+'…' : ev.label)}
      </div>`
    ).join('');

    const moreHTML = evs.length > MAX_SHOW
      ? `<div class="cal-more">+${evs.length - MAX_SHOW} more</div>` : '';

    html += `
      <div class="cal-cell${isToday ? ' cal-today' : ''}" onclick="openCalDay('${dateStr}')">
        <div class="cal-day-num${isToday ? ' cal-day-today' : ''}">${d}</div>
        ${pillsHTML}${moreHTML}
      </div>`;
  }

  grid.innerHTML = html;
}

function calShift(dir) {
  calMonth += dir;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  if (calMonth < 0)  { calMonth = 11; calYear--; }
  renderCalendar();
}

function calGoToday() {
  const now = new Date();
  calYear  = now.getFullYear();
  calMonth = now.getMonth();
  renderCalendar();
}

const CAL_TYPE_ICONS = {
  transfer:   '💸',
  inspection: '🔍',
  meeting:    '🤝',
  legal:      '⚖️',
  deadline:   '⏰',
  other:      '📌'
};

function openCalDay(dateStr) {
  selectedCalDate = dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  document.getElementById('calDayTitle').textContent = `${months[m-1]} ${d}, ${y}`;

  const evMap = collectAllEvents();
  const evs   = evMap[dateStr] || [];
  const container = document.getElementById('calDayEvents');

  if (!evs.length) {
    container.innerHTML = `<p style="color:var(--text-3);font-size:14px;text-align:center;padding:12px 0;">No events scheduled for this day.</p>`;
  } else {
    container.innerHTML = evs.map(ev => {
      const icon = ev.type.startsWith('cheque') ? '💳'
                 : ev.type === 'lease-start' ? '🟢'
                 : ev.type === 'lease-end'   ? '🔴'
                 : ev.type === 'reminder'    ? '🔔'
                 : CAL_TYPE_ICONS[ev.type.replace('custom-','')] || '📌';
      const delBtn = ev.deletable
        ? `<button class="cal-ev-del" onclick="deleteCalendarEvent('${ev.id}','${dateStr}')" title="Delete">
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
           </button>` : '';
      return `
        <div class="cal-day-ev" style="border-left:3px solid ${ev.color};">
          <span class="cal-day-ev-icon">${icon}</span>
          <div class="cal-day-ev-body">
            <div class="cal-day-ev-label">${h(ev.label)}</div>
            ${ev.sub ? `<div class="cal-day-ev-sub">${h(ev.sub)}</div>` : ''}
          </div>
          ${delBtn}
        </div>`;
    }).join('');
  }

  // Reset add form
  document.getElementById('calNewTitle').value = '';
  document.getElementById('calNewType').value  = 'transfer';
  document.getElementById('calNewTime').value  = '';
  document.getElementById('calNewNote').value  = '';

  document.getElementById('calDayModal').classList.add('active');
}

function closeCalDay() {
  document.getElementById('calDayModal').classList.remove('active');
  selectedCalDate = null;
}

function addCalendarEvent() {
  if (!selectedCalDate) return;
  const title = document.getElementById('calNewTitle').value.trim();
  if (!title) { showToast('Please enter an event title', 'error'); return; }

  const evs = loadCalendarEvents();
  evs.push({
    id: 'ev_' + Date.now(),
    date: selectedCalDate,
    title,
    eventType: document.getElementById('calNewType').value,
    time: document.getElementById('calNewTime').value,
    note: document.getElementById('calNewNote').value.trim()
  });
  persistCalendarEvents(evs);
  showToast('Event added', 'success');
  openCalDay(selectedCalDate);  // re-render event list
  renderCalendar();
}

function deleteCalendarEvent(id, dateStr) {
  if (!confirm('Delete this event?')) return;
  const evs = loadCalendarEvents().filter(e => e.id !== id);
  persistCalendarEvents(evs);
  showToast('Event deleted', 'success');
  openCalDay(dateStr);
  renderCalendar();
}

// ─── API Integrations ─────────────────────────────
const API_SETTINGS_KEY = 'asg_api_settings';
let metaSyncTimer = null;

function loadApiSettings_data() {
  try { return JSON.parse(localStorage.getItem(API_SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function persistApiSettings(s) { localStorage.setItem(API_SETTINGS_KEY, JSON.stringify(s)); }

function openApiSettings() {
  const s      = loadApiSettings_data();
  const meta   = s.meta    || {};
  const google = s.google  || {};
  const hs     = s.hubspot || {};

  // Meta
  $('metaToken').value           = meta.accessToken    || '';
  $('metaFormIds').value         = (meta.formIds || []).join('\n');
  $('metaDefaultPropType').value = meta.defaultPropType || 'warehouse';
  $('metaSyncInterval').value    = meta.syncInterval    || '0';
  const metaBadge = $('metaConnectedBadge');
  if (metaBadge) metaBadge.style.display = meta.accessToken ? '' : 'none';
  if (meta.lastSync) {
    const el = $('metaLastSync');
    if (el) el.textContent = `Last synced: ${formatDate(meta.lastSync)} · ${meta.lastImported||0} leads imported`;
  }

  // Google
  $('googleSheetId').value = google.sheetId || '';
  $('googleApiKey').value  = google.apiKey  || '';

  // HubSpot
  $('hubspotToken').value       = hs.accessToken   || '';
  $('hubspotSyncDir').value     = hs.syncDirection || 'push';
  $('hubspotPipelineId').value  = hs.pipelineId    || '';
  const createDealsEl = $('hubspotCreateDeals');
  if (createDealsEl) createDealsEl.checked = hs.createDeals !== false;
  const syncStagesEl  = $('hubspotSyncStages');
  if (syncStagesEl)  syncStagesEl.checked  = hs.syncStages  !== false;
  const hsBadge = $('hubspotConnectedBadge');
  if (hsBadge) hsBadge.style.display = hs.accessToken ? '' : 'none';
  const hsLastSync = $('hubspotLastSync');
  if (hsLastSync && hs.lastPush) {
    const parts = [];
    if (hs.lastPush) parts.push(`Last push: ${formatDate(hs.lastPush)} · ${hs.lastPushCount||0} sent`);
    if (hs.lastPull) parts.push(`Last pull: ${formatDate(hs.lastPull)} · ${hs.lastPullCount||0} imported`);
    hsLastSync.textContent = parts.join(' · ');
  }

  // Webhook
  $('webhookVerifyToken').value = s.webhookVerifyToken || '';

  clearTestResult();
  switchApiTab('meta');
  $('apiSettingsOverlay').classList.add('active');
}
function closeApiSettings() { $('apiSettingsOverlay').classList.remove('active'); }

function switchApiTab(tab) {
  ['meta','google','hubspot','webhook'].forEach(t => {
    const content = $(`apiTab-${t}`);
    const pill    = $(`apiPill-${t}`);
    if (content) content.style.display = t === tab ? '' : 'none';
    if (pill)    pill.classList.toggle('active', t === tab);
  });
}

function clearTestResult() {
  ['metaTestResult','googleTestResult','hubspotTestResult','hubspotSyncResult'].forEach(id => {
    const el = $(id);
    if (el) { el.textContent = ''; el.className = 'api-test-result'; }
  });
}

function saveApiSettings_() {
  const s = loadApiSettings_data();

  const rawFormIds = $('metaFormIds').value;
  const formIds = rawFormIds
    .split(/[\n,]+/)
    .map(f => f.trim())
    .filter(Boolean);

  s.meta = {
    accessToken:     $('metaToken').value.trim(),
    formIds,
    defaultPropType: $('metaDefaultPropType').value,
    syncInterval:    $('metaSyncInterval').value,
    lastSync:        s.meta?.lastSync || '',
    lastImported:    s.meta?.lastImported || 0
  };
  s.google = {
    sheetId: $('googleSheetId').value.trim(),
    apiKey:  $('googleApiKey').value.trim()
  };

  // HubSpot
  const createDealsEl = $('hubspotCreateDeals');
  const syncStagesEl  = $('hubspotSyncStages');
  s.hubspot = {
    accessToken:   $('hubspotToken').value.trim(),
    syncDirection: $('hubspotSyncDir').value,
    pipelineId:    $('hubspotPipelineId').value.trim(),
    createDeals:   createDealsEl ? createDealsEl.checked : true,
    syncStages:    syncStagesEl  ? syncStagesEl.checked  : true,
    lastPush:      s.hubspot?.lastPush      || '',
    lastPushCount: s.hubspot?.lastPushCount || 0,
    lastPull:      s.hubspot?.lastPull      || '',
    lastPullCount: s.hubspot?.lastPullCount || 0
  };

  s.webhookVerifyToken = $('webhookVerifyToken').value.trim();

  persistApiSettings(s);
  setupMetaAutoSync();
  updateApiStatusUI();
  closeApiSettings();
  showToast('API settings saved', 'success');
}

function generateVerifyToken() {
  const token = 'ASG_' + Math.random().toString(36).slice(2,10).toUpperCase();
  $('webhookVerifyToken').value = token;
}

// ── Meta Ads Sync ──────────────────────────────────
async function testMetaConnection() {
  const token = $('metaToken').value.trim();
  const rawIds = $('metaFormIds').value.trim();
  const result = $('metaTestResult');
  if (!token) { result.textContent = '❌ Please enter an access token first'; result.className='api-test-result api-test-error'; return; }

  result.textContent = '⏳ Testing connection…';
  result.className   = 'api-test-result api-test-loading';

  try {
    // Verify token by calling /me endpoint
    const res  = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${token}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    // Test first form ID if provided
    const formIds = rawIds.split(/[\n,]+/).map(f=>f.trim()).filter(Boolean);
    let formTest = '';
    if (formIds.length) {
      const fRes  = await fetch(`https://graph.facebook.com/v19.0/${formIds[0]}?fields=name,status&access_token=${token}`);
      const fData = await fRes.json();
      if (fData.error) throw new Error(`Form ${formIds[0]}: ${fData.error.message}`);
      formTest = ` · Form: "${fData.name || formIds[0]}"`;
    }

    result.textContent = `✅ Connected as ${data.name || data.id}${formTest}`;
    result.className   = 'api-test-result api-test-success';
    const badge = $('metaConnectedBadge');
    if (badge) badge.style.display = '';
  } catch (e) {
    result.textContent = `❌ ${e.message}`;
    result.className   = 'api-test-result api-test-error';
  }
}

async function syncMetaLeads() {
  const s     = loadApiSettings_data();
  const meta  = s.meta || {};
  const token = ($('metaToken') || {}).value?.trim() || meta.accessToken;
  const rawIds = ($('metaFormIds') || {}).value || (meta.formIds||[]).join('\n');
  const formIds = rawIds.split(/[\n,]+/).map(f=>f.trim()).filter(Boolean);
  const defaultPropType = ($('metaDefaultPropType')||{}).value || meta.defaultPropType || 'warehouse';

  if (!token)            { showToast('No access token configured', 'error'); return; }
  if (!formIds.length)   { showToast('No form IDs configured', 'error'); return; }

  const syncBtn = $('syncNowBtn');
  if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = '⏳ Syncing…'; }
  showToast('Syncing from Meta Ads…', 'success');

  let totalImported = 0;
  let totalSkipped  = 0;
  const existingLeads = loadLeads();
  // Build dedup set from phone + metaLeadId
  const existingPhones  = new Set(existingLeads.map(l => normalisePhone(l.phone)));
  const existingMetaIds = new Set(existingLeads.map(l => l.metaLeadId).filter(Boolean));
  const newLeads = [];

  for (const formId of formIds) {
    try {
      const url = `https://graph.facebook.com/v19.0/${formId}/leads?` +
                  `access_token=${token}` +
                  `&fields=created_time,field_data,ad_id,ad_name,adset_name,campaign_name` +
                  `&limit=100`;
      const res  = await fetch(url);
      const data = await res.json();

      if (data.error) { showToast(`Meta Error (form ${formId}): ${data.error.message}`, 'error'); continue; }

      for (const ml of (data.data || [])) {
        if (existingMetaIds.has(ml.id)) { totalSkipped++; continue; }

        // Parse field_data into a flat map
        const fields = {};
        (ml.field_data || []).forEach(f => {
          fields[f.name.toLowerCase().replace(/[^a-z0-9]/g,'_')] = (f.values||[])[0] || '';
        });

        const phone = fields.phone_number || fields.phone || fields.mobile || '';
        const normPhone = normalisePhone(phone);
        if (normPhone && existingPhones.has(normPhone)) { totalSkipped++; continue; }

        const firstName = fields.first_name || '';
        const lastName  = fields.last_name  || '';
        const fullName  = fields.full_name  || (`${firstName} ${lastName}`).trim() || 'Unknown';
        const budget    = fields.budget || fields.annual_rent || fields.rent_budget || '';

        const leadObj = {
          id:          'lead_' + uid(),
          name:        fullName,
          phone:       phone || '—',
          email:       fields.email || fields.email_address || '',
          company:     fields.company || fields.company_name || fields.business_name || '',
          source:      'meta-ads',
          propType:    defaultPropType,
          budget,
          requirements: [
            ml.ad_name      ? `Ad: ${ml.ad_name}`           : '',
            ml.campaign_name? `Campaign: ${ml.campaign_name}`: '',
            ml.adset_name   ? `Ad Set: ${ml.adset_name}`    : '',
            fields.message  ? `Message: ${fields.message}`  : '',
            fields.notes    ? fields.notes                   : ''
          ].filter(Boolean).join(' · '),
          stage:       'new',
          assignedTo:  '',
          activities:  [],
          metaLeadId:  ml.id,
          metaFormId:  formId,
          createdAt:   ml.created_time || new Date().toISOString(),
          updatedAt:   new Date().toISOString()
        };

        newLeads.push(leadObj);
        if (normPhone) existingPhones.add(normPhone);
        existingMetaIds.add(ml.id);
        totalImported++;
      }
    } catch (e) {
      showToast(`Sync error (form ${formId}): ${e.message}`, 'error');
    }
  }

  if (newLeads.length) {
    saveLeads([...newLeads, ...existingLeads]);
  }

  // Update last sync metadata
  s.meta = { ...meta, accessToken: token, formIds, defaultPropType,
              lastSync: new Date().toISOString(), lastImported: (meta.lastImported||0) + totalImported };
  persistApiSettings(s);

  if (syncBtn) { syncBtn.disabled = false; syncBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> Sync Now'; }

  showToast(`✅ ${totalImported} new lead${totalImported!==1?'s':''} imported${totalSkipped?' · '+totalSkipped+' duplicates skipped':''}`, 'success');
  updateApiStatusUI();
  renderLeadsPipeline();

  // Update result in modal if open
  const res = $('metaTestResult');
  if (res) {
    res.textContent = `✅ Imported ${totalImported} new lead${totalImported!==1?'s':''}${totalSkipped?' · '+totalSkipped+' already existed':''}`;
    res.className   = 'api-test-result api-test-success';
  }
}

function normalisePhone(p) {
  return (p||'').replace(/[\s\-\(\)\+]/g,'');
}

// ── Google Sheets Sync ─────────────────────────────
async function syncGoogleLeads() {
  const sheetId = $('googleSheetId').value.trim();
  const apiKey  = $('googleApiKey').value.trim();
  const result  = $('googleTestResult');

  if (!sheetId || !apiKey) {
    result.textContent = '❌ Please enter both Sheet ID and API Key';
    result.className = 'api-test-result api-test-error';
    return;
  }

  result.textContent = '⏳ Fetching from Google Sheets…';
  result.className   = 'api-test-result api-test-loading';

  try {
    // Read sheet data using Sheets API v4
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1?key=${apiKey}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    const rows  = data.values || [];
    if (rows.length < 2) { result.textContent = '⚠️ Sheet is empty or has no data rows'; result.className='api-test-result api-test-error'; return; }

    // First row = headers
    const headers = rows[0].map(h => h.toLowerCase().trim());
    const findCol = (...names) => {
      for (const n of names) { const i = headers.findIndex(h => h.includes(n)); if (i > -1) return i; }
      return -1;
    };
    const nameCol    = findCol('name','full name');
    const phoneCol   = findCol('phone','mobile','number');
    const emailCol   = findCol('email');
    const companyCol = findCol('company','business');

    if (nameCol === -1 && phoneCol === -1) throw new Error('Could not find Name or Phone column in sheet');

    const existingLeads = loadLeads();
    const existingPhones = new Set(existingLeads.map(l => normalisePhone(l.phone)));
    const newLeads = [];

    for (let i = 1; i < rows.length; i++) {
      const row   = rows[i];
      const phone = phoneCol > -1 ? (row[phoneCol]||'').trim() : '';
      const normP = normalisePhone(phone);
      if (normP && existingPhones.has(normP)) continue;

      const name = nameCol > -1 ? (row[nameCol]||'').trim() : 'Unknown';
      if (!name && !phone) continue;

      newLeads.push({
        id: 'lead_' + uid(),
        name: name || 'Unknown',
        phone, email: emailCol>-1?(row[emailCol]||''):'',
        company: companyCol>-1?(row[companyCol]||''):'',
        source: 'google', propType: 'warehouse', budget: '',
        requirements: `Imported from Google Sheet row ${i+1}`,
        stage: 'new', assignedTo: '', activities: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      if (normP) existingPhones.add(normP);
    }

    if (newLeads.length) saveLeads([...newLeads, ...existingLeads]);
    result.textContent = `✅ Imported ${newLeads.length} new lead${newLeads.length!==1?'s':''}`;
    result.className   = 'api-test-result api-test-success';
    renderLeadsPipeline();
    showToast(`${newLeads.length} leads imported from Google Sheets`, 'success');
  } catch(e) {
    result.textContent = `❌ ${e.message}`;
    result.className   = 'api-test-result api-test-error';
  }
}

// ── Sync All APIs ──────────────────────────────────
async function syncAllApis() {
  const s = loadApiSettings_data();
  if (s.meta?.accessToken && s.meta?.formIds?.length) await syncMetaLeads();
  if (s.google?.sheetId && s.google?.apiKey) await syncGoogleLeads();
}

// ═══════════════════════════════════════════════════
// ── HubSpot CRM Integration ─────────────────────────
// ═══════════════════════════════════════════════════
const HS_BASE = 'https://api.hubapi.com';

// ASG lead stage → HubSpot deal stage
const HS_STAGE_MAP = {
  new:         'appointmentscheduled',
  contacted:   'qualifiedtobuy',
  meeting:     'presentationscheduled',
  qualified:   'decisionmakerboughtin',
  proposal:    'contractsent',
  negotiation: 'contractsent',
  won:         'closedwon',
  lost:        'closedlost'
};

// ASG source → HubSpot lead source enum
const HS_SOURCE_MAP = {
  'meta-ads':  'SOCIAL_MEDIA',
  'instagram': 'SOCIAL_MEDIA',
  'google':    'PAID_SEARCH',
  'referral':  'OTHER',
  'walk-in':   'OTHER',
  'website':   'ORGANIC_SEARCH',
  'other':     'OTHER'
};

// Generic fetch wrapper for HubSpot API
async function hsRequest(method, path, body) {
  const s = loadApiSettings_data();
  const token = (s.hubspot || {}).accessToken;
  if (!token) throw new Error('No HubSpot token — please save your settings first');

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json'
    }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res  = await fetch(HS_BASE + path, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data.message || (data.errors && data.errors[0] && data.errors[0].message) || `HubSpot API error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Map an ASG lead → HubSpot contact properties object
function mapLeadToHSContact(lead) {
  const parts     = (lead.name || '').trim().split(/\s+/);
  const firstname = parts[0] || '';
  const lastname  = parts.slice(1).join(' ') || '';

  const props = { firstname, lastname };
  if (lead.phone)        props.phone           = lead.phone;
  if (lead.email)        props.email           = lead.email;
  if (lead.company)      props.company         = lead.company;
  if (lead.requirements) props.message         = lead.requirements;
  if (lead.budget)       props.annualrevenue   = String(lead.budget);
  if (lead.source && HS_SOURCE_MAP[lead.source])
    props.hs_lead_source = HS_SOURCE_MAP[lead.source];
  // Use the "website" field to store our internal ID for dedup (no custom property needed)
  props.website = `asg-lead:${lead.id}`;
  return props;
}

// Map a HubSpot contact → ASG lead object
function mapHSContactToLead(contact) {
  const p = contact.properties || {};
  const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim()
             || p.email || 'HubSpot Contact';
  return {
    id:                'lead_' + uid(),
    name,
    phone:             p.phone || p.mobilephone || '',
    email:             p.email || '',
    company:           p.company || '',
    source:            'hubspot',
    propType:          'warehouse',
    budget:            p.annualrevenue || '',
    requirements:      p.message || '',
    stage:             'new',
    assignedTo:        '',
    activities:        [],
    hubspotContactId:  contact.id,
    createdAt:         new Date().toISOString(),
    updatedAt:         new Date().toISOString()
  };
}

// ── Test HubSpot Connection ────────────────────────
async function testHubSpotConnection() {
  const token  = $('hubspotToken').value.trim();
  const result = $('hubspotTestResult');
  if (!result) return;
  if (!token) {
    result.textContent = '❌ Please enter your Private App access token first';
    result.className   = 'api-test-result api-test-error';
    return;
  }

  result.textContent = '⏳ Testing connection…';
  result.className   = 'api-test-result api-test-loading';

  try {
    const res  = await fetch(`${HS_BASE}/crm/v3/objects/contacts?limit=1&properties=email`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (res.status === 401) throw new Error('Invalid token — check your Private App access token');
    if (res.status === 403) throw new Error('Insufficient scopes — make sure you enabled contacts & deals scopes');
    const data = await res.json();
    if (data.status === 'error') throw new Error(data.message);

    result.textContent = `✅ Connected! Found ${data.total || 0} contact${data.total !== 1 ? 's' : ''} in your HubSpot CRM`;
    result.className   = 'api-test-result api-test-success';

    const badge = $('hubspotConnectedBadge');
    if (badge) badge.style.display = '';
  } catch(e) {
    if (e.message.includes('Failed to fetch') || e.name === 'TypeError') {
      result.innerHTML = '⚠️ CORS blocked on local file — save settings &amp; host on Netlify/Vercel to use live. ' +
        'The token is still saved and will work when deployed.';
      result.className = 'api-test-result api-test-loading';
    } else {
      result.textContent = '❌ ' + e.message;
      result.className   = 'api-test-result api-test-error';
    }
  }
}

// ── Push ASG Leads → HubSpot ───────────────────────
async function pushLeadsToHubSpot() {
  const s      = loadApiSettings_data();
  const hs     = s.hubspot || {};
  const result = $('hubspotSyncResult');
  if (!result) return;

  if (!hs.accessToken) {
    result.textContent = '❌ No access token — save settings first';
    result.className   = 'api-test-result api-test-error';
    return;
  }

  result.textContent = '⏳ Pushing leads to HubSpot…';
  result.className   = 'api-test-result api-test-loading';

  const leads        = loadLeads();
  const updatedLeads = leads.map(l => ({ ...l }));  // shallow clone each
  let created = 0, updated = 0, errors = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    try {
      const contactProps = mapLeadToHSContact(lead);
      let contactId = lead.hubspotContactId || null;

      if (contactId) {
        // Update existing contact
        await hsRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: contactProps });
        updated++;
      } else {
        // Search by email first to avoid duplicate contacts
        let found = null;
        if (lead.email) {
          try {
            const srch = await hsRequest('POST', '/crm/v3/objects/contacts/search', {
              filterGroups: [{ filters: [{ propertyName:'email', operator:'EQ', value:lead.email }] }],
              limit: 1, properties: ['email']
            });
            if (srch.results && srch.results.length) found = srch.results[0];
          } catch {}
        }
        // If not found by email, try phone
        if (!found && lead.phone) {
          try {
            const srch = await hsRequest('POST', '/crm/v3/objects/contacts/search', {
              filterGroups: [{ filters: [{ propertyName:'phone', operator:'EQ', value:lead.phone }] }],
              limit: 1, properties: ['phone']
            });
            if (srch.results && srch.results.length) found = srch.results[0];
          } catch {}
        }

        if (found) {
          contactId = found.id;
          await hsRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: contactProps });
          updated++;
        } else {
          const newContact = await hsRequest('POST', '/crm/v3/objects/contacts', { properties: contactProps });
          contactId = newContact.id;
          created++;
        }
        updatedLeads[i].hubspotContactId = contactId;
      }

      // Optionally create / update a Deal linked to this contact
      if (hs.createDeals !== false) {
        const dealStage = (hs.syncStages !== false)
          ? (HS_STAGE_MAP[lead.stage] || 'appointmentscheduled')
          : 'appointmentscheduled';

        const dealProps = {
          dealname:  `${lead.name} — ${lead.propType || 'Property'}`,
          pipeline:  hs.pipelineId || 'default',
          dealstage: dealStage
        };
        if (lead.budget) dealProps.amount = String(lead.budget);

        if (lead.hubspotDealId) {
          // Update existing deal stage
          try {
            await hsRequest('PATCH', `/crm/v3/objects/deals/${lead.hubspotDealId}`, { properties: dealProps });
          } catch {}
        } else {
          // Create new deal and associate with contact in one call
          try {
            const newDeal = await hsRequest('POST', '/crm/v3/objects/deals', {
              properties:   dealProps,
              associations: [{
                to:    { id: contactId },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
              }]
            });
            updatedLeads[i].hubspotDealId = newDeal.id;
          } catch {}
        }
      }
    } catch(e) {
      console.warn('[HubSpot] push error for lead', lead.id, e.message);
      errors++;
    }
  }

  // Persist the updated hubspotContactId / hubspotDealId back to localStorage
  saveLeads(updatedLeads);

  // Update settings with last push metadata
  const fresh = loadApiSettings_data();
  fresh.hubspot = fresh.hubspot || {};
  fresh.hubspot.lastPush      = new Date().toISOString();
  fresh.hubspot.lastPushCount = created + updated;
  persistApiSettings(fresh);
  updateApiStatusUI();

  const summary = `✅ Pushed ${created + updated} lead${created + updated !== 1 ? 's' : ''} to HubSpot — `
                + `${created} new contact${created !== 1 ? 's' : ''}, ${updated} updated`
                + (errors ? ` · ⚠️ ${errors} error${errors > 1 ? 's' : ''}` : '');
  result.textContent = summary;
  result.className   = 'api-test-result api-test-success';
  showToast(`HubSpot: ${created} created, ${updated} updated`, 'success');
}

// ── Pull HubSpot Contacts → ASG Leads ─────────────
async function pullLeadsFromHubSpot() {
  const s      = loadApiSettings_data();
  const hs     = s.hubspot || {};
  const result = $('hubspotSyncResult');
  if (!result) return;

  if (!hs.accessToken) {
    result.textContent = '❌ No access token — save settings first';
    result.className   = 'api-test-result api-test-error';
    return;
  }

  result.textContent = '⏳ Pulling contacts from HubSpot…';
  result.className   = 'api-test-result api-test-loading';

  try {
    const props = 'firstname,lastname,email,phone,mobilephone,company,message,annualrevenue,hs_lead_source,website';
    const data  = await hsRequest('GET', `/crm/v3/objects/contacts?limit=100&properties=${props}`);
    const contacts = data.results || [];

    const existing      = loadLeads();
    const existingHsIds = new Set(existing.map(l => l.hubspotContactId).filter(Boolean));
    const existingEmails = new Set(existing.map(l => (l.email||'').toLowerCase()).filter(Boolean));
    const existingPhones = new Set(existing.map(l => normalisePhone(l.phone)).filter(Boolean));

    let imported = 0;
    const newLeads = [];

    for (const contact of contacts) {
      // Skip contacts we already know about
      if (existingHsIds.has(contact.id)) continue;

      const p     = contact.properties || {};
      const email = (p.email || '').toLowerCase();
      const phone = normalisePhone(p.phone || p.mobilephone || '');

      // Skip contacts that were exported from ASG (contain our ID tag)
      if (p.website && p.website.startsWith('asg-lead:')) continue;

      if (email && existingEmails.has(email)) continue;
      if (phone && existingPhones.has(phone))  continue;

      newLeads.push(mapHSContactToLead(contact));
      imported++;
    }

    if (newLeads.length) {
      saveLeads([...newLeads, ...existing]);
      renderLeadsPipeline();
    }

    // Update settings
    const fresh = loadApiSettings_data();
    fresh.hubspot = fresh.hubspot || {};
    fresh.hubspot.lastPull      = new Date().toISOString();
    fresh.hubspot.lastPullCount = imported;
    persistApiSettings(fresh);
    updateApiStatusUI();

    result.textContent = `✅ Pulled ${imported} new contact${imported !== 1 ? 's' : ''} from HubSpot`
                       + (imported < contacts.length ? ` (${contacts.length - imported} already existed)` : '');
    result.className   = 'api-test-result api-test-success';
    if (imported) showToast(`Imported ${imported} HubSpot contact${imported !== 1 ? 's' : ''}`, 'success');
  } catch(e) {
    if (e.message.includes('Failed to fetch') || e.name === 'TypeError') {
      result.innerHTML = '⚠️ CORS blocked on local file — this works once you host on Netlify/Vercel.';
      result.className = 'api-test-result api-test-loading';
    } else {
      result.textContent = '❌ ' + e.message;
      result.className   = 'api-test-result api-test-error';
    }
  }
}

// ── One-click two-way HubSpot sync ────────────────
async function syncHubSpot() {
  const s   = loadApiSettings_data();
  const dir = (s.hubspot || {}).syncDirection || 'push';
  if (dir === 'push' || dir === 'both') await pushLeadsToHubSpot();
  if (dir === 'pull' || dir === 'both') await pullLeadsFromHubSpot();
}

// ── Auto Sync Timer ────────────────────────────────
function setupMetaAutoSync() {
  if (metaSyncTimer) { clearInterval(metaSyncTimer); metaSyncTimer = null; }
  const s        = loadApiSettings_data();
  const interval = parseInt((s.meta||{}).syncInterval || '0');
  if (interval > 0 && s.meta?.accessToken && s.meta?.formIds?.length) {
    metaSyncTimer = setInterval(syncAllApis, interval * 60 * 1000);
  }
}

// ── API Status UI ──────────────────────────────────
function updateApiStatusUI() {
  const s       = loadApiSettings_data();
  const hasMeta = !!(s.meta?.accessToken && s.meta?.formIds?.length);
  const hasGoog = !!(s.google?.sheetId   && s.google?.apiKey);
  const hasHS   = !!(s.hubspot?.accessToken);
  const hasAny  = hasMeta || hasGoog || hasHS;

  const dot     = $('apiStatusDot');
  const syncBtn = $('syncNowBtn');
  const bar     = $('apiSyncBar');

  if (dot) {
    dot.style.background = hasAny ? '#22c55e' : '#e5e7eb';
    dot.title = hasAny
      ? `Connected: ${[hasMeta&&'Meta',hasGoog&&'Google',hasHS&&'HubSpot'].filter(Boolean).join(', ')}`
      : 'No API connected';
  }
  if (syncBtn) syncBtn.style.display = hasAny ? '' : 'none';

  if (bar && hasAny) {
    const parts = [];
    if (hasMeta) {
      const lastSync = s.meta.lastSync ? `Last sync: ${formatDate(s.meta.lastSync)}` : 'Not yet synced';
      const intLabel = s.meta.syncInterval > 0 ? ` · Auto-sync every ${s.meta.syncInterval}m` : '';
      parts.push(`📱 Meta Ads · ${lastSync}${intLabel} · ${s.meta.lastImported||0} imported`);
    }
    if (hasGoog) parts.push(`🔍 Google Sheets connected`);
    if (hasHS) {
      const hs = s.hubspot;
      const pushInfo = hs.lastPush ? `Last push: ${formatDate(hs.lastPush)} · ${hs.lastPushCount||0} sent` : 'Not yet synced';
      parts.push(`🟠 HubSpot CRM · ${pushInfo}`);
    }
    bar.style.display = '';
    bar.innerHTML = parts.map(p => `<span class="api-sync-pill">${p}</span>`).join('');
  } else if (bar) {
    bar.style.display = 'none';
  }

  // Update HubSpot connected badge if modal is open
  const hsBadge = $('hubspotConnectedBadge');
  if (hsBadge) hsBadge.style.display = hasHS ? '' : 'none';
}

// ─── Leads Pipeline ───────────────────────────────
const LEADS_KEY   = 'asg_leads';
const PENDING_KEY = 'asg_pending_props';

function loadLeads()         { return _api.leads.load(); }
function saveLeads(l)        { _api.leads.save(l); }
function loadPendingProps()  { return _api.pending.load(); }
function savePendingProps(p) { _api.pending.save(p); }

const LEAD_STAGES = {
  new:         { label:'New',            icon:'🆕', cls:'ls-new' },
  contacted:   { label:'Contacted',      icon:'📞', cls:'ls-contacted' },
  meeting:     { label:'Meeting',        icon:'🤝', cls:'ls-meeting' },
  qualified:   { label:'Qualified',      icon:'✅', cls:'ls-qualified' },
  proposal:    { label:'Proposal Sent',  icon:'📄', cls:'ls-proposal' },
  negotiation: { label:'Negotiation',    icon:'💬', cls:'ls-negotiation' },
  won:         { label:'Won',            icon:'🏆', cls:'ls-won' },
  lost:        { label:'Lost',           icon:'❌', cls:'ls-lost' }
};

const LEAD_SOURCES = {
  'meta-ads':  '📱 Meta Ads',
  'instagram': '📸 Instagram',
  'google':    '🔍 Google',
  'referral':  '🤝 Referral',
  'walk-in':   '🚶 Walk-in',
  'website':   '🌐 Website',
  'other':     '📌 Other'
};

const ACT_TYPES = {
  call:     { icon:'📞', label:'Called' },
  meeting:  { icon:'🤝', label:'Meeting' },
  email:    { icon:'📧', label:'Email' },
  note:     { icon:'📝', label:'Note' },
  proposal: { icon:'📄', label:'Proposal Sent' }
};

// ── Admin Lead Modal ───────────────────────────────
function openLeadModal(id) {
  const agents = loadAgents().filter(a => a.active);
  const leads  = loadLeads();
  const lead   = id ? leads.find(l => l.id === id) : null;

  $('leadModalTitle').textContent = lead ? 'Edit Lead' : 'Add Lead';
  $('leadId').value = lead ? lead.id : '';

  $('leadAssignTo').innerHTML = '<option value="">— Unassigned —</option>' +
    agents.map(a => `<option value="${a.id}"${lead && lead.assignedTo === a.id ? ' selected' : ''}>${h(a.name)}</option>`).join('');

  if (lead) {
    $('leadName').value         = lead.name       || '';
    $('leadPhone').value        = lead.phone      || '';
    $('leadEmail').value        = lead.email      || '';
    $('leadCompany').value      = lead.company    || '';
    $('leadSource').value       = lead.source     || 'meta-ads';
    $('leadPropType').value     = lead.propType   || 'warehouse';
    $('leadBudget').value       = lead.budget     || '';
    $('leadRequirements').value = lead.requirements || '';
  } else {
    ['leadName','leadPhone','leadEmail','leadCompany','leadBudget','leadRequirements'].forEach(id => { const el=$(id); if(el) el.value=''; });
    $('leadSource').value   = 'meta-ads';
    $('leadPropType').value = 'warehouse';
  }
  $('leadModalOverlay').classList.add('active');
  setTimeout(() => $('leadName').focus(), 100);
}
function closeLeadModal() { $('leadModalOverlay').classList.remove('active'); }

function saveLead() {
  const name  = $('leadName').value.trim();
  const phone = $('leadPhone').value.trim();
  if (!name)  { showToast('Name is required', 'error'); return; }
  if (!phone) { showToast('Phone is required', 'error'); return; }

  const leads = loadLeads();
  const id    = $('leadId').value;
  const existing = id ? leads.find(l => l.id === id) : null;
  const assignedTo = $('leadAssignTo').value;

  const leadObj = {
    id:           id || ('lead_' + uid()),
    name, phone,
    email:        $('leadEmail').value.trim(),
    company:      $('leadCompany').value.trim(),
    source:       $('leadSource').value,
    propType:     $('leadPropType').value,
    budget:       $('leadBudget').value,
    requirements: $('leadRequirements').value.trim(),
    stage:        existing ? existing.stage : 'new',
    assignedTo,
    assignedAt:   assignedTo !== (existing?.assignedTo) ? new Date().toISOString() : (existing?.assignedAt || ''),
    activities:   existing ? existing.activities : [],
    createdAt:    existing ? existing.createdAt : new Date().toISOString(),
    updatedAt:    new Date().toISOString()
  };

  if (id) { const idx = leads.findIndex(l => l.id === id); if (idx > -1) leads[idx] = leadObj; else leads.push(leadObj); }
  else leads.unshift(leadObj);

  saveLeads(leads);
  closeLeadModal();
  showToast(id ? 'Lead updated' : 'Lead added', 'success');
  renderLeadsPipeline();
}

function deleteLead(id) {
  if (!confirm('Delete this lead?')) return;
  saveLeads(loadLeads().filter(l => l.id !== id));
  renderLeadsPipeline();
  showToast('Lead deleted', 'success');
}

function assignLeadToAgent(leadId, agentId) {
  const leads = loadLeads();
  const lead  = leads.find(l => l.id === leadId);
  if (!lead) return;
  lead.assignedTo = agentId;
  lead.assignedAt = new Date().toISOString();
  lead.updatedAt  = new Date().toISOString();
  saveLeads(leads);
  renderLeadsPipeline();
  showToast('Lead assigned', 'success');
}

// ── Lead Detail Modal ──────────────────────────────
let currentLeadId = null;
function openLeadDetail(id) {
  currentLeadId = id;
  const lead   = loadLeads().find(l => l.id === id);
  if (!lead) return;
  const agents = loadAgents();
  const ag     = lead.assignedTo ? agents.find(a => a.id === lead.assignedTo) : null;
  const stage  = LEAD_STAGES[lead.stage] || LEAD_STAGES['new'];
  const sess   = getSession();
  const isAgentViewing = sess && sess.type === 'agent';

  $('leadDetailId').value   = id;
  $('leadDetailName').textContent = lead.name;
  $('leadDetailSub').textContent  = `${LEAD_SOURCES[lead.source]||'Unknown'} · ${stage.icon} ${stage.label}${ag ? ' · Assigned to '+ag.name : ''}`;

  // Lead info summary
  $('leadDetailInfo').innerHTML = `
    <div class="lead-detail-grid">
      <div class="lead-detail-item"><span class="lead-detail-lbl">Phone</span><span class="lead-detail-val">${h(lead.phone)}</span></div>
      ${lead.email   ? `<div class="lead-detail-item"><span class="lead-detail-lbl">Email</span><span class="lead-detail-val">${h(lead.email)}</span></div>` : ''}
      ${lead.company ? `<div class="lead-detail-item"><span class="lead-detail-lbl">Company</span><span class="lead-detail-val">${h(lead.company)}</span></div>` : ''}
      <div class="lead-detail-item"><span class="lead-detail-lbl">Interested In</span><span class="lead-detail-val">${lead.propType || '—'}</span></div>
      ${lead.budget  ? `<div class="lead-detail-item"><span class="lead-detail-lbl">Budget</span><span class="lead-detail-val">AED ${Number(lead.budget).toLocaleString()}</span></div>` : ''}
      <div class="lead-detail-item"><span class="lead-detail-lbl">Stage</span><span class="lead-detail-val"><span class="lead-stage-badge ${stage.cls}">${stage.icon} ${stage.label}</span></span></div>
      ${ag ? `<div class="lead-detail-item"><span class="lead-detail-lbl">Assigned To</span><span class="lead-detail-val">${h(ag.name)}</span></div>` : ''}
    </div>
    ${lead.requirements ? `<div style="margin-top:10px;font-size:13px;color:var(--text-2);background:var(--bg);padding:10px 12px;border-radius:8px;border:1px solid var(--border);">${h(lead.requirements)}</div>` : ''}`;

  // Activity log
  renderActivityLog(lead.activities || []);

  // Show add-activity form for agents
  $('leadAddActivityForm').style.display = isAgentViewing ? '' : 'none';
  $('leadAddActBtn').style.display       = isAgentViewing ? '' : 'none';

  // Admin actions
  const adminDiv = $('leadDetailAdminActions');
  if (!isAgentViewing) {
    adminDiv.innerHTML = `
      <button class="btn-sm btn-ghost" onclick="openLeadModal('${id}');closeLeadDetail()">✏️ Edit</button>
      <button class="btn-sm btn-danger" onclick="deleteLead('${id}');closeLeadDetail()">🗑️ Delete</button>`;
  } else {
    adminDiv.innerHTML = '';
  }

  $('leadDetailOverlay').classList.add('active');
}
function closeLeadDetail() { $('leadDetailOverlay').classList.remove('active'); currentLeadId = null; }

function renderActivityLog(activities) {
  const log = $('leadActivityLog');
  if (!activities.length) {
    log.innerHTML = `<p style="color:var(--text-3);font-size:13px;text-align:center;padding:10px;">No activity logged yet.</p>`;
    return;
  }
  log.innerHTML = [...activities].reverse().map(a => {
    const at = ACT_TYPES[a.type] || { icon:'📝', label:'Note' };
    const potential = a.potential
      ? `<span class="act-potential act-pot-${a.potential}">${a.potential==='high'?'🔥':'⚡'} ${a.potential.charAt(0).toUpperCase()+a.potential.slice(1)} potential</span>` : '';
    const stageChange = a.stageChanged
      ? `<span class="act-stage-change">→ Stage: ${(LEAD_STAGES[a.stageChanged]||{icon:'',label:a.stageChanged}).icon} ${(LEAD_STAGES[a.stageChanged]||{label:a.stageChanged}).label}</span>` : '';
    return `
      <div class="act-item">
        <div class="act-icon">${at.icon}</div>
        <div class="act-body">
          <div class="act-header">
            <span class="act-type">${at.label}</span>
            ${potential}${stageChange}
            <span class="act-date">${formatDate(a.date)}</span>
          </div>
          <div class="act-by">by ${h(a.byAgentName || 'Unknown')}</div>
          <div class="act-note">${h(a.note)}</div>
        </div>
      </div>`;
  }).join('');
}

function submitLeadActivity() {
  const note = $('actNote').value.trim();
  if (!note) { showToast('Please write a note about this activity', 'error'); return; }
  const sess = getSession();
  if (!sess || sess.type !== 'agent') return;

  const leads    = loadLeads();
  const lead     = leads.find(l => l.id === currentLeadId);
  if (!lead) return;

  const newStage = $('actStage').value;
  const act = {
    id:          'act_' + uid(),
    type:        $('actType').value,
    potential:   $('actPotential').value,
    stageChanged: newStage || '',
    note,
    date:        new Date().toISOString(),
    byAgentId:   sess.agentId,
    byAgentName: sess.name
  };

  if (!lead.activities) lead.activities = [];
  lead.activities.push(act);
  if (newStage) lead.stage = newStage;
  lead.updatedAt = new Date().toISOString();
  saveLeads(leads);

  $('actNote').value     = '';
  $('actStage').value    = '';
  $('actPotential').value = '';
  renderActivityLog(lead.activities);
  renderAgentLeads();
  showToast('Activity logged', 'success');
}

// ── Admin Lead Pipeline Render ─────────────────────
function renderLeadsPipeline() {
  const agents  = loadAgents();
  const allLeads = loadLeads();

  // Update agent filter
  const agF = $('leadFilterAgent');
  if (agF) {
    const cur = agF.value;
    agF.innerHTML = '<option value="">All Agents</option>' +
      agents.map(a => `<option value="${a.id}"${cur===a.id?' selected':''}>${h(a.name)}</option>`).join('') +
      '<option value="__unassigned__">Unassigned</option>';
  }

  let leads = allLeads;
  const agentF  = (agF || {}).value || '';
  const stageF  = ($('leadFilterStage')  || {}).value || '';
  const sourceF = ($('leadFilterSource') || {}).value || '';
  if (agentF === '__unassigned__') leads = leads.filter(l => !l.assignedTo);
  else if (agentF) leads = leads.filter(l => l.assignedTo === agentF);
  if (stageF)  leads = leads.filter(l => l.stage  === stageF);
  if (sourceF) leads = leads.filter(l => l.source === sourceF);

  // Stage bar
  const stageBar = $('pipelineStageBar');
  if (stageBar) {
    const stageOrder = ['new','contacted','meeting','qualified','proposal','negotiation','won','lost'];
    stageBar.innerHTML = stageOrder.map(s => {
      const cnt = allLeads.filter(l => l.stage === s).length;
      const meta = LEAD_STAGES[s];
      return cnt ? `<div class="pipeline-stage-pill ${meta.cls}" onclick="$('leadFilterStage').value='${s}';renderLeadsPipeline()">
        ${meta.icon} ${meta.label} <strong>${cnt}</strong>
      </div>` : '';
    }).join('');
  }

  const table = $('leadsTable');
  if (!leads.length) {
    table.innerHTML = `<div class="team-empty"><div class="empty-icon">👥</div><p>No leads found. Add your first lead above.</p></div>`;
    return;
  }

  // Sort: won/lost last, then by updatedAt
  const sorted = [...leads].sort((a,b) => {
    const aLast = (a.stage==='won'||a.stage==='lost') ? 1 : 0;
    const bLast = (b.stage==='won'||b.stage==='lost') ? 1 : 0;
    if (aLast !== bLast) return aLast - bLast;
    return new Date(b.updatedAt||b.createdAt) - new Date(a.updatedAt||a.createdAt);
  });

  table.innerHTML = sorted.map(lead => {
    const ag    = lead.assignedTo ? agents.find(a => a.id === lead.assignedTo) : null;
    const stage = LEAD_STAGES[lead.stage] || LEAD_STAGES['new'];
    const lastAct = lead.activities && lead.activities.length ? lead.activities[lead.activities.length-1] : null;
    const actCount = lead.activities ? lead.activities.length : 0;

    // Last potential from activities
    const potentials = (lead.activities||[]).filter(a => a.potential).map(a => a.potential);
    const lastPot = potentials.length ? potentials[potentials.length-1] : null;

    return `
      <div class="lead-card${lead.stage==='won'?' lead-won':lead.stage==='lost'?' lead-lost':''}" onclick="openLeadDetail('${lead.id}')">
        <div class="lead-card-top">
          <div class="lead-card-left">
            <div class="lead-avatar">${lead.name.charAt(0).toUpperCase()}</div>
            <div>
              <div class="lead-name">${h(lead.name)} ${lead.company?'<span class="lead-co">'+h(lead.company)+'</span>':''}</div>
              <div class="lead-meta">${LEAD_SOURCES[lead.source]||'Unknown'} · ${lead.propType||'Any'} · ${lead.phone}</div>
            </div>
          </div>
          <div class="lead-card-right">
            <span class="lead-stage-badge ${stage.cls}">${stage.icon} ${stage.label}</span>
            ${lastPot ? `<span class="act-potential act-pot-${lastPot}">${lastPot==='high'?'🔥 High':lastPot==='medium'?'⚡ Med':'❄️ Low'}</span>` : ''}
          </div>
        </div>
        ${lastAct ? `<div class="lead-last-act"><span>${(ACT_TYPES[lastAct.type]||{icon:'📝'}).icon}</span> <em>${h(lastAct.note.length>80?lastAct.note.slice(0,80)+'…':lastAct.note)}</em> <span class="lead-act-date">${formatDate(lastAct.date)}</span></div>` : '<div class="lead-last-act" style="color:var(--text-3);">No activity yet</div>'}
        <div class="lead-card-footer">
          <span>${ag ? '👤 '+h(ag.name) : '<span style="color:var(--text-3);">⚠️ Unassigned</span>'}</span>
          <span>${actCount} update${actCount!==1?'s':''}</span>
          ${lead.budget ? `<span>💰 AED ${Number(lead.budget).toLocaleString()}</span>` : ''}
          <div class="lead-card-actions" onclick="event.stopPropagation()">
            <select class="task-status-select" style="font-size:11px;" onchange="assignLeadToAgent('${lead.id}',this.value)">
              <option value="">Assign to…</option>
              ${agents.filter(a=>a.active).map(a=>`<option value="${a.id}"${lead.assignedTo===a.id?' selected':''}>${h(a.name)}</option>`).join('')}
            </select>
            <button class="btn-sm btn-ghost" onclick="openLeadModal('${lead.id}')">✏️</button>
            <button class="btn-sm btn-danger" onclick="deleteLead('${lead.id}')">🗑️</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── Pending Property Submissions (admin) ───────────
function renderPendingProps() {
  const pending = loadPendingProps();
  const el = $('pendingPropsList');
  const badge = $('pendingBadge');
  if (!el) return;

  const waitingCount = pending.filter(p => p.status === 'pending').length;
  if (badge) { badge.textContent = waitingCount ? `${waitingCount} awaiting`:''; badge.style.display = waitingCount ? '':'none'; }

  if (!pending.length) {
    el.innerHTML = `<div class="team-empty"><div class="empty-icon">📭</div><p>No submissions from agents yet.</p></div>`;
    return;
  }

  const typeIcon = { warehouse:'🏭', office:'🏢', residential:'🏠' };
  el.innerHTML = [...pending].reverse().map(p => {
    const isP = p.status === 'pending';
    return `
      <div class="pending-prop-card${p.status==='approved'?' pend-approved':p.status==='rejected'?' pend-rejected':''}">
        <div class="pending-prop-icon">${typeIcon[p.type]||'🏗️'}</div>
        <div class="pending-prop-body">
          <div class="pending-prop-name">${h(p.name)}</div>
          <div class="pending-prop-meta">
            ${h(p.addedByAgentName||'Agent')} · ${p.type} ${p.location?'· '+h(p.location):''}
            ${p.annualRent?'· AED '+Number(p.annualRent).toLocaleString():''} / yr
          </div>
          ${p.clientName ? `<div class="pending-prop-client">🤝 Client: ${h(p.clientName)} ${p.clientPhone?'· '+h(p.clientPhone):''}</div>` : ''}
          ${p.description ? `<div class="pending-prop-notes">${h(p.description)}</div>` : ''}
          <div class="pending-prop-date">Submitted ${formatDate(p.submittedAt)}</div>
          ${p.adminNote ? `<div class="pending-prop-admin-note">💬 ${h(p.adminNote)}</div>` : ''}
        </div>
        <div class="pending-prop-actions">
          ${isP ? `
            <button class="btn-sm btn-success" onclick="approvePendingProp('${p.id}')">✓ Approve</button>
            <button class="btn-sm btn-danger"  onclick="rejectPendingProp('${p.id}')">✗ Reject</button>
          ` : `<span class="pend-status-chip pend-${p.status}">${p.status==='approved'?'✓ Approved':'✗ Rejected'}</span>`}
        </div>
      </div>`;
  }).join('');
}

function approvePendingProp(pendingId) {
  const pending = loadPendingProps();
  const item    = pending.find(p => p.id === pendingId);
  if (!item) return;
  item.status = 'approved';

  // Move to main props
  const props = loadProps();
  const newProp = { ...item };
  delete newProp.status;
  delete newProp.submittedAt;
  delete newProp.adminNote;
  newProp.id = 'prop_' + uid();
  props.push(newProp);
  persistProps(props);
  savePendingProps(pending);

  renderPendingProps();
  refresh();
  showToast(`Property "${item.name}" approved and added to dashboard`, 'success');
}

function rejectPendingProp(pendingId) {
  const note = prompt('Reason for rejection (optional):');
  const pending = loadPendingProps();
  const item    = pending.find(p => p.id === pendingId);
  if (!item) return;
  item.status    = 'rejected';
  item.adminNote = note || '';
  savePendingProps(pending);
  renderPendingProps();
  showToast('Submission rejected', 'success');
}

// ── Update renderTeamTab to include new sections ───
const _origRenderTeamTab = renderTeamTab;
renderTeamTab = function() {
  _origRenderTeamTab();
  renderLeadsPipeline();
  renderPendingProps();
};

// ── Update saveAgentProperty to use pending queue ──
saveAgentProperty = function() {
  const session = getSession();
  if (!session || session.type !== 'agent') return;
  const name       = $('apName').value.trim();
  const clientName = $('apClientName').value.trim();
  if (!name)       { showToast('Property name is required', 'error'); return; }
  if (!clientName) { showToast('Client / owner name is required', 'error'); return; }

  const pending = loadPendingProps();
  pending.push({
    id:               'pending_' + uid(),
    name,
    type:             $('apType').value,
    location:         $('apLocation').value.trim(),
    size:             $('apSize').value ? Number($('apSize').value) : '',
    annualRent:       $('apRent').value ? Number($('apRent').value) : '',
    status:           'vacant',
    ownership:        'sole',
    description:      $('apNotes').value.trim(),
    addedByAgent:     session.agentId,
    addedByAgentName: session.name,
    clientName,
    clientPhone:      $('apClientPhone').value.trim(),
    submittedAt:      new Date().toISOString(),
    status:           'pending',   // pending | approved | rejected
    files: {}, media: []
  });
  savePendingProps(pending);
  closeAgentPropModal();
  showToast('Property submitted — awaiting admin approval', 'success');
  renderAgentSubmissions();
  updateAgentBadges();
};

// ─── Agent Tab System ──────────────────────────────
let currentAgentTab = 'overview';
let agentMlMap = null;

const AGENT_TABS = ['overview','inventory','leads','tasks','map','proposals','contracts','submissions'];

function showAgentTab(tab) {
  currentAgentTab = tab;
  AGENT_TABS.forEach(t => {
    const view = $(`agentTab${t.charAt(0).toUpperCase()+t.slice(1)}`);
    if (view) view.style.display = t === tab ? '' : 'none';
    const btn = $(`aTab-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'overview')     renderAgentOverview();
  if (tab === 'inventory')    renderAgentInventory();
  if (tab === 'leads')        renderAgentLeads();
  if (tab === 'tasks')        renderAgentTasksTab();
  if (tab === 'map')          initAgentMap();
  if (tab === 'submissions')  renderAgentSubmissions();
}

function updateAgentBadges() {
  const sess = getSession();
  if (!sess || sess.type !== 'agent') return;
  const { agentId } = sess;

  const props   = loadProps();
  const myTasks = loadTasks().filter(t => t.agentId === agentId && (t.status==='pending'||t.status==='in-progress'));
  const myLeads = loadLeads().filter(l => l.assignedTo === agentId && l.stage !== 'won' && l.stage !== 'lost');
  const mySubs  = loadPendingProps().filter(p => p.addedByAgent === agentId && p.status === 'pending');

  const inv = $('agentInvCount');  if(inv)  { inv.textContent  = props.length || ''; }
  const lc  = $('agentLeadCount'); if(lc)   { lc.textContent   = myLeads.length || ''; }
  const tc  = $('agentTaskCount'); if(tc)   { tc.textContent   = myTasks.length || ''; }
  const sc  = $('agentSubCount');  if(sc)   { sc.textContent   = mySubs.length  || ''; }
}

// ── Agent Overview ─────────────────────────────────
function renderAgentOverview() {
  const sess = getSession();
  if (!sess || sess.type !== 'agent') return;
  const { agentId, name, perms } = sess;
  const ag      = loadAgents().find(a => a.id === agentId) || {};
  const myTasks = loadTasks().filter(t => t.agentId === agentId);
  const myLeads = loadLeads().filter(l => l.assignedTo === agentId);
  const allProps = loadProps();
  const wins    = myTasks.filter(t => t.status==='done' && (t.type==='find-tenant'||t.type==='negotiation'));
  const wonLeads = myLeads.filter(l => l.stage==='won');

  const activeT = myTasks.filter(t => t.status==='pending'||t.status==='in-progress').length;
  const doneT   = myTasks.filter(t => t.status==='done').length;
  const activeL = myLeads.filter(l => l.stage!=='won'&&l.stage!=='lost').length;

  const _roleMeta = agentRoleMeta(ag.role);
  $('agentNavAvatar').textContent = name.charAt(0).toUpperCase();
  $('agentNavName').textContent   = name;
  $('agentNavRole').textContent   = _roleMeta.icon + ' ' + _roleMeta.label;

  $('agentWelcome').innerHTML = `
    <div class="agent-welcome-inner">
      <div class="agent-welcome-avatar">${name.charAt(0).toUpperCase()}</div>
      <div style="flex:1;">
        <div class="agent-welcome-name">Welcome back, ${h(name)}</div>
        <div class="agent-welcome-role">${_roleMeta.icon} ${h(_roleMeta.label)}</div>
      </div>
      ${(wins.length+wonLeads.length) ? `<div class="agent-wins-chip">🏆 ${wins.length+wonLeads.length} Win${wins.length+wonLeads.length>1?'s':''}</div>` : ''}
    </div>`;

  $('agentStats').innerHTML = `
    <div class="agent-stat-card"><div class="agent-stat-num" style="color:#2563eb;">${activeT}</div><div class="agent-stat-label">Active Tasks</div></div>
    <div class="agent-stat-card"><div class="agent-stat-num" style="color:var(--success);">${doneT}</div><div class="agent-stat-label">Tasks Done</div></div>
    <div class="agent-stat-card"><div class="agent-stat-num" style="color:#8b5cf6;">${activeL}</div><div class="agent-stat-label">Active Leads</div></div>
    <div class="agent-stat-card"><div class="agent-stat-num" style="color:var(--gold);">${wonLeads.length+wins.length}</div><div class="agent-stat-label">Total Wins</div></div>`;

  // Wins
  const allWins = [
    ...wonLeads.map(l => ({ type:'lead', title:`Lead Won — ${l.name}`, sub: l.company||'', date: l.updatedAt })),
    ...wins.map(t => ({ type:'task', title: t.title, sub: '', date: t.updatedAt }))
  ].sort((a,b) => new Date(b.date) - new Date(a.date));

  const winsSection = $('agentWins');
  const winsList    = $('agentWinsList');
  if (allWins.length) {
    winsSection.style.display = '';
    $('agentWinsCount').textContent = allWins.length;
    winsList.innerHTML = allWins.map(w => `
      <div class="agent-win-card">
        <div class="agent-win-trophy">🏆</div>
        <div class="agent-win-body">
          <div class="agent-win-title">${h(w.title)}</div>
          ${w.sub ? `<div class="agent-win-prop">${h(w.sub)}</div>` : ''}
          <div class="agent-win-date">✅ ${formatDate(w.date)}</div>
        </div>
      </div>`).join('');
  } else {
    winsSection.style.display = 'none';
  }

  // ── Quick Tasks preview (up to 3 active) ──
  const activeTasks = myTasks.filter(t => t.status === 'pending' || t.status === 'in-progress').slice(0, 3);
  const qtSection = $('agentOverviewQuickTasks');
  const qtList    = $('agentOverviewTasksList');
  if (qtSection && qtList) {
    if (activeTasks.length) {
      qtSection.style.display = '';
      qtList.innerHTML = activeTasks.map(t => {
        const tm = TASK_TYPE_META[t.type] || TASK_TYPE_META['other'];
        const sm = TASK_STATUS_META[t.status] || TASK_STATUS_META['pending'];
        const pm = PRIORITY_META[t.priority] || PRIORITY_META['medium'];
        const overdue = t.deadline && new Date(t.deadline) < new Date();
        return `
          <div class="agent-task-card${overdue?' task-overdue':''}">
            <div class="task-card-top">
              <div class="task-type-badge">${tm.icon} ${tm.label}</div>
              <div style="display:flex;gap:6px;">
                <span class="task-priority ${pm.cls}">${pm.label}</span>
                <span class="task-status-badge ${sm.cls}">${sm.label}</span>
              </div>
            </div>
            <div class="task-card-title">${h(t.title)}</div>
            ${t.deadline ? `<div class="task-card-meta"><span class="${overdue?'task-overdue-tag':'task-deadline'}">📅 ${overdue?'Overdue — ':''}${t.deadline}</span></div>` : ''}
          </div>`;
      }).join('');
    } else {
      qtSection.style.display = 'none';
    }
  }

  // ── Quick Leads preview (up to 3 active) ──
  const allLeadsLocal = loadLeads().filter(l => l.assignedTo === agentId && l.stage !== 'won' && l.stage !== 'lost').slice(0, 3);
  const qlSection = $('agentOverviewQuickLeads');
  const qlList    = $('agentOverviewLeadsList');
  if (qlSection && qlList) {
    if (allLeadsLocal.length) {
      qlSection.style.display = '';
      qlList.innerHTML = allLeadsLocal.map(lead => {
        const stage = LEAD_STAGES[lead.stage] || LEAD_STAGES['new'];
        const actCount = lead.activities ? lead.activities.length : 0;
        const lastAct  = actCount ? lead.activities[actCount-1] : null;
        return `
          <div class="agent-lead-card" onclick="openLeadDetail('${lead.id}')" style="cursor:pointer;">
            <div class="lead-card-top">
              <div class="lead-card-left">
                <div class="lead-avatar">${lead.name.charAt(0).toUpperCase()}</div>
                <div>
                  <div class="lead-name">${h(lead.name)} ${lead.company?'<span class="lead-co">'+h(lead.company)+'</span>':''}</div>
                  <div class="lead-meta">${LEAD_SOURCES[lead.source]||''} · 📱 ${lead.phone}</div>
                </div>
              </div>
              <span class="lead-stage-badge ${stage.cls}">${stage.icon} ${stage.label}</span>
            </div>
            ${lastAct ? `<div class="lead-last-act"><span>${(ACT_TYPES[lastAct.type]||{icon:'📝'}).icon}</span> <em>${h(lastAct.note.length>60?lastAct.note.slice(0,60)+'…':lastAct.note)}</em></div>` : '<div class="lead-last-act" style="color:var(--text-3);">No updates yet — tap to log first contact</div>'}
          </div>`;
      }).join('');
    } else {
      qlSection.style.display = 'none';
    }
  }
}

// ── Agent Inventory ────────────────────────────────
function renderAgentInventory() {
  const allProps = loadProps();
  const sess  = getSession();
  if (!sess || sess.type !== 'agent') return;
  const perms = sess.perms || {};
  const list  = $('agentInventoryList');
  if (!list) return;

  // Filter properties based on this agent's role
  const role = sess.role || 'general';
  const meta = agentRoleMeta(role);
  const props = allProps.filter(meta.inventoryFilter);

  // Banner explaining what the agent is seeing
  const intro = (() => {
    if (role === 'sales') {
      return `<div class="agent-inv-intro agent-inv-intro-sales">
        <div class="aii-icon">🏷️</div>
        <div>
          <div class="aii-title">Sales Inventory · ${props.length} vacant ${props.length === 1 ? 'property' : 'properties'}</div>
          <div class="aii-sub">These are the properties available to lease or sell. Find a tenant or buyer and update the status.</div>
        </div>
      </div>`;
    }
    if (role === 'leasing') {
      return `<div class="agent-inv-intro agent-inv-intro-leasing">
        <div class="aii-icon">📋</div>
        <div>
          <div class="aii-title">Active Leases · ${props.length} rented ${props.length === 1 ? 'property' : 'properties'}</div>
          <div class="aii-sub">Manage existing tenants, track lease renewals, and follow up on payments.</div>
        </div>
      </div>`;
    }
    if (role === 'property_management') {
      const rentedManaged = props.filter(p => p.status === 'rented').length;
      const vacantManaged = props.filter(p => p.status === 'vacant').length;
      return `<div class="agent-inv-intro agent-inv-intro-pm">
        <div class="aii-icon">🏢</div>
        <div>
          <div class="aii-title">Managed Portfolio · ${props.length} propert${props.length===1?'y':'ies'}</div>
          <div class="aii-sub">${rentedManaged} rented · ${vacantManaged} vacant. Properties managed on behalf of external owners — track fees, owner relations, tenant compliance, and renewals.</div>
        </div>
      </div>`;
    }
    return '';
  })();

  if (!allProps.length) {
    list.innerHTML = `<div class="team-empty"><div class="empty-icon">🏗️</div><p>No properties in the portfolio yet.</p></div>`;
    return;
  }
  if (!props.length) {
    const emptyMsg = role === 'sales'
      ? 'No vacant properties right now — everything in the portfolio is currently rented. Great work!'
      : role === 'leasing'
        ? 'No properties are currently rented out.'
        : role === 'property_management'
          ? 'No properties under management yet. Add a property with Ownership = "Management Only" to see it here.'
          : 'No properties match your filter.';
    list.innerHTML = `${intro}<div class="team-empty"><div class="empty-icon">${role==='sales'?'✅':'🏗️'}</div><p>${emptyMsg}</p></div>`;
    return;
  }

  const typeIcon = { warehouse:'🏭', office:'🏢', residential:'🏠' };
  list.innerHTML = intro + props.map(p => {
    const statusColor = p.status==='vacant' ? 'var(--danger)' : 'var(--success)';
    return `
      <div class="inv-prop-card">
        <div class="inv-prop-header">
          <span class="inv-prop-type-icon">${typeIcon[p.type]||'🏗️'}</span>
          <div style="flex:1;min-width:0;">
            <div class="inv-prop-name">${h(p.name)}</div>
            ${p.location?`<div class="inv-prop-loc">📍 ${h(p.location)}</div>`:''}
          </div>
          <span class="chip" style="background:${p.status==='vacant'?'var(--danger-bg)':'var(--success-bg)'};color:${statusColor};flex-shrink:0;">
            ${p.status==='vacant'?'🔴 Vacant':'🟢 Rented'}
          </span>
        </div>
        <div class="inv-prop-details">
          ${p.size     ? `<span>📐 ${Number(p.size).toLocaleString()} sq ft</span>` : ''}
          ${p.compound ==='yes' ? `<span>🏠 Compound</span>` : ''}
          ${p.mezzanine==='yes' ? `<span>🏗️ Mezzanine</span>` : ''}
          ${perms.viewFinancials!==false && p.annualRent ? `<span>💰 AED ${Number(p.annualRent).toLocaleString()}/yr</span>` : ''}
          ${perms.viewTenant!==false && p.tenantName ? `<span>👤 ${h(p.tenantName)}</span>` : ''}
          ${perms.viewTenant!==false && p.leaseStart ? `<span>📅 ${p.leaseStart} → ${p.leaseEnd||'?'}</span>` : ''}
        </div>
        ${p.description ? `<div class="inv-prop-desc">${h(p.description)}</div>` : ''}
        ${p.status==='vacant'?`<div class="inv-prop-vacant-cta">🔍 This property is vacant — find a tenant!</div>`:''}
        ${p.media && p.media.length ? `<div class="inv-prop-media-note">📷 ${p.media.length} media file${p.media.length>1?'s':''} available</div>` : ''}
      </div>`;
  }).join('');
}

// ── Agent Leads ────────────────────────────────────
function renderAgentLeads() {
  const sess = getSession();
  if (!sess || sess.type !== 'agent') return;
  const { agentId } = sess;
  const myLeads = loadLeads().filter(l => l.assignedTo === agentId);
  const container = $('agentLeadsContent');
  if (!container) return;

  const active = myLeads.filter(l => l.stage !== 'won' && l.stage !== 'lost').length;

  let html = `<div class="agent-tab-header">
    <h2 class="agent-tab-title">👥 My Leads</h2>
    <p class="agent-tab-sub">Leads assigned to you — log every call, meeting &amp; note so the admin can track your progress</p>
  </div>`;

  if (!myLeads.length) {
    html += `<div class="team-empty"><div class="empty-icon">👥</div><p>No leads assigned yet. Your manager will push leads to you.</p></div>`;
    container.innerHTML = html;
    return;
  }

  const order = { new:0,contacted:1,meeting:2,qualified:3,proposal:4,negotiation:5,won:6,lost:7 };
  const sorted = [...myLeads].sort((a,b) => (order[a.stage]||0)-(order[b.stage]||0));

  html += sorted.map(lead => {
    const stage   = LEAD_STAGES[lead.stage] || LEAD_STAGES['new'];
    const actCount = lead.activities ? lead.activities.length : 0;
    const lastAct  = actCount ? lead.activities[actCount-1] : null;
    const potentials = (lead.activities||[]).filter(a=>a.potential).map(a=>a.potential);
    const lastPot = potentials.length ? potentials[potentials.length-1] : null;

    return `
      <div class="agent-lead-card${lead.stage==='won'?' lead-won':lead.stage==='lost'?' lead-lost':''}" onclick="openLeadDetail('${lead.id}')">
        <div class="lead-card-top">
          <div class="lead-card-left">
            <div class="lead-avatar">${lead.name.charAt(0).toUpperCase()}</div>
            <div>
              <div class="lead-name">${h(lead.name)} ${lead.company?'<span class="lead-co">'+h(lead.company)+'</span>':''}</div>
              <div class="lead-meta">${LEAD_SOURCES[lead.source]||''} · 📱 ${lead.phone}</div>
            </div>
          </div>
          <div class="lead-card-right">
            <span class="lead-stage-badge ${stage.cls}">${stage.icon} ${stage.label}</span>
            ${lastPot ? `<span class="act-potential act-pot-${lastPot}">${lastPot==='high'?'🔥':'⚡'} ${lastPot}</span>` : ''}
          </div>
        </div>
        ${lead.requirements ? `<div class="lead-req">"${h(lead.requirements.length>80?lead.requirements.slice(0,80)+'…':lead.requirements)}"</div>` : ''}
        ${lastAct ? `<div class="lead-last-act"><span>${(ACT_TYPES[lastAct.type]||{icon:'📝'}).icon}</span> <em>${h(lastAct.note.length>70?lastAct.note.slice(0,70)+'…':lastAct.note)}</em></div>` : '<div class="lead-last-act" style="color:var(--text-3);">No updates yet — tap to log first contact</div>'}
        <div class="lead-card-footer">
          <span>${actCount} update${actCount!==1?'s':''}</span>
          ${lead.budget ? `<span>💰 AED ${Number(lead.budget).toLocaleString()}</span>` : ''}
          <span class="lead-tap-hint">Tap to update →</span>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = html;
}

// ── Agent Tasks Tab ────────────────────────────────
function renderAgentTasksTab() {
  const sess = getSession();
  if (!sess || sess.type !== 'agent') return;
  const { agentId, perms = {} } = sess;

  const myTasks  = loadTasks().filter(t => t.agentId === agentId);
  const allProps = loadProps();
  const container = $('agentTasksList');
  if (!container) return;

  if (!myTasks.length) {
    container.innerHTML = `<div class="team-empty"><div class="empty-icon">🎯</div><p>No tasks assigned yet. Check back soon.</p></div>`;
    return;
  }

  const order = { 'in-progress':0, pending:1, done:2, cancelled:3 };
  const sortedTasks = [...myTasks].sort((a,b) => (order[a.status]||9) - (order[b.status]||9));

  container.innerHTML = sortedTasks.map(t => {
    const prop = t.propId ? allProps.find(p => p.id === t.propId) : null;
    const tm   = TASK_TYPE_META[t.type]   || TASK_TYPE_META['other'];
    const sm   = TASK_STATUS_META[t.status] || TASK_STATUS_META['pending'];
    const pm   = PRIORITY_META[t.priority]  || PRIORITY_META['medium'];
    const overdue = t.deadline && t.status !== 'done' && t.status !== 'cancelled' && new Date(t.deadline) < new Date();
    const notesCount = t.notes ? t.notes.length : 0;
    const lastNote   = notesCount ? t.notes[notesCount - 1] : null;

    return `
      <div class="agent-task-card${t.status==='done'?' agent-task-done':''}${overdue?' task-overdue':''}">
        <div class="task-card-top">
          <div class="task-type-badge">${tm.icon} ${tm.label}</div>
          <div style="display:flex;gap:6px;">
            <span class="task-priority ${pm.cls}">${pm.label}</span>
            <span class="task-status-badge ${sm.cls}">${sm.label}</span>
          </div>
        </div>
        <div class="task-card-title">${h(t.title)}</div>
        ${t.description ? `<div class="task-card-desc">${h(t.description)}</div>` : ''}
        ${prop ? `
          <div class="agent-task-prop-pill">
            🏗️ ${h(prop.name)}${prop.location?' · '+h(prop.location):''}
            ${prop.status==='vacant'?'<span style="color:var(--danger);font-size:11px;margin-left:6px;">● Vacant</span>':'<span style="color:var(--success);font-size:11px;margin-left:6px;">● Rented</span>'}
          </div>` : ''}
        <div class="task-card-meta">
          ${t.deadline ? `<span class="${overdue?'task-overdue-tag':'task-deadline'}">📅 ${overdue?'Overdue — ':''}${t.deadline}</span>` : ''}
          ${notesCount ? `<span class="task-note-count">💬 ${notesCount} update${notesCount>1?'s':''}</span>` : ''}
        </div>
        ${lastNote ? `<div class="task-last-note"><span class="task-last-note-icon">💬</span><div class="task-last-note-text">${h(lastNote.text)}</div></div>` : ''}
        <div class="task-card-actions">
          ${perms.addNotes !== false ? `<button class="btn-sm btn-ghost" onclick="openTaskNotes('${t.id}')">💬 Add Update (${notesCount})</button>` : ''}
          ${perms.updateStatus !== false && t.status !== 'done' && t.status !== 'cancelled' ? `
            ${t.status !== 'in-progress' ? `<button class="btn-sm btn-primary" onclick="updateTaskStatus('${t.id}','in-progress')">▶ Start</button>` : `<button class="btn-sm btn-ghost" disabled>⏳ In Progress</button>`}
            <button class="btn-sm btn-success" onclick="if(confirm('Mark this task as done?')) updateTaskStatus('${t.id}','done')">✓ Mark Done</button>
          ` : t.status === 'done' ? `<span style="color:var(--success);font-size:13px;font-weight:600;">✅ Completed</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ── Agent Submissions ──────────────────────────────
function renderAgentSubmissions() {
  const sess = getSession();
  if (!sess || sess.type !== 'agent') return;
  const { agentId } = sess;
  const mySubs = loadPendingProps().filter(p => p.addedByAgent === agentId);
  const container = $('agentSubmissionsContent');
  if (!container) return;

  if (!mySubs.length) {
    container.innerHTML = `<div class="team-empty"><div class="empty-icon">📭</div><p>You haven't submitted any properties yet.</p></div>`;
    return;
  }
  const typeIcon = { warehouse:'🏭', office:'🏢', residential:'🏠' };
  container.innerHTML = [...mySubs].reverse().map(p => {
    const status = p.status || 'pending';
    return `
      <div class="pending-prop-card${status==='approved'?' pend-approved':status==='rejected'?' pend-rejected':''}">
        <div class="pending-prop-icon">${typeIcon[p.type]||'🏗️'}</div>
        <div class="pending-prop-body">
          <div class="pending-prop-name">${h(p.name)}</div>
          <div class="pending-prop-meta">${p.type} ${p.location?'· '+h(p.location):''} ${p.annualRent?'· AED '+Number(p.annualRent).toLocaleString():''}</div>
          ${p.clientName ? `<div class="pending-prop-client">🤝 ${h(p.clientName)} ${p.clientPhone?'· '+h(p.clientPhone):''}</div>` : ''}
          <div class="pending-prop-date">Submitted ${formatDate(p.submittedAt)}</div>
          ${p.adminNote ? `<div class="pending-prop-admin-note">💬 Admin: ${h(p.adminNote)}</div>` : ''}
        </div>
        <div class="pending-prop-actions">
          <span class="pend-status-chip pend-${status}">${status==='pending'?'⏳ Awaiting':status==='approved'?'✓ Approved':'✗ Rejected'}</span>
        </div>
      </div>`;
  }).join('');
}

// ── Agent Map ──────────────────────────────────────
function initAgentMap() {
  const container = $('agentMapContainer');
  if (!container || !window.maplibregl) return;
  if (agentMlMap) { agentMlMap.resize(); return; }

  agentMlMap = new maplibregl.Map({
    container: 'agentMapContainer',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [54.37, 24.47],
    zoom: 10
  });
  agentMlMap.addControl(new maplibregl.NavigationControl(), 'top-right');

  agentMlMap.on('load', () => {
    const props = loadProps();
    props.forEach(p => {
      const ll = parseLatLng(p);
      if (!ll) return;
      const typeIcon = { warehouse:'🏭', office:'🏢', residential:'🏠' };
      const el = document.createElement('div');
      el.className = 'map-pin';
      el.style.cssText = `background:${p.status==='vacant'?'#dc2626':'#059669'};`;
      el.textContent = typeIcon[p.type] || '📍';
      const popup = new maplibregl.Popup({ offset:25 }).setHTML(
        `<strong>${h(p.name)}</strong><br>${p.location?h(p.location)+'<br>':''}${p.status==='vacant'?'🔴 Vacant':'🟢 Rented'}`
      );
      new maplibregl.Marker({ element: el }).setLngLat([ll.lng, ll.lat]).setPopup(popup).addTo(agentMlMap);
    });
  });
}

// ── Agent Contract Builder (DLD EJARI) ────────────
function openAgentContractBuilder() {
  const props = loadProps();
  $('acf_prop').innerHTML = '<option value="">— Select property —</option>' +
    props.map(p => `<option value="${p.id}">${h(p.name)}</option>`).join('');
  $('acf_date').value = new Date().toISOString().split('T')[0];
  // Reset all DLD fields
  const clear = (...ids) => ids.forEach(id => { const el=$(id); if(el) el.value=''; });
  clear('acf_owner_name','acf_lessor_name','acf_lessor_eid','acf_lessor_phone','acf_lessor_email',
        'acf_lessor_license','acf_lessor_authority','acf_tenant_name','acf_tenant_eid',
        'acf_tenant_phone','acf_tenant_email','acf_tenant_license','acf_tenant_authority',
        'acf_plot_no','acf_makani_no','acf_building_name','acf_property_no','acf_dewa_no',
        'acf_property_type','acf_property_area','acf_location',
        'acf_from','acf_to','acf_contract_value','acf_annual_rent','acf_deposit','acf_payment_mode',
        'acf_add1','acf_add2','acf_add3','acf_add4','acf_add5');
  // Default usage: Commercial
  const commercial = $('acf_usage_commercial');
  if (commercial) commercial.checked = true;
  $('agentContractOverlay').classList.add('active');
}

function autofillAgentContract() {
  const propId = $('acf_prop').value;
  if (!propId) return;
  const p = loadProps().find(x => x.id === propId);
  if (!p) return;
  const set = (id, val) => { if (val && $(id)) $(id).value = val; };
  set('acf_location',      p.location);
  set('acf_building_name', p.name);
  set('acf_property_type', p.type ? p.type.charAt(0).toUpperCase()+p.type.slice(1) : '');
  set('acf_property_area', p.size ? (p.size / 10.764).toFixed(1) : '');
  set('acf_annual_rent',   p.annualRent);
  set('acf_contract_value',p.annualRent);
  set('acf_deposit',       p.deposit);
  set('acf_tenant_name',   p.tenantName);
  set('acf_tenant_phone',  p.tenantPhone);
  set('acf_tenant_email',  p.tenantEmail);
  set('acf_from',          p.leaseStart);
  set('acf_to',            p.leaseEnd);
  // Usage radio: try to match property type
  if (p.type) {
    const t = p.type.toLowerCase();
    if (t.includes('apartment') || t.includes('villa') || t.includes('studio') || t.includes('resid')) {
      const r = $('acf_usage_residential'); if(r) r.checked = true;
    } else if (t.includes('industrial') || t.includes('warehouse') || t.includes('factory')) {
      const r = $('acf_usage_industrial'); if(r) r.checked = true;
    } else {
      const r = $('acf_usage_commercial'); if(r) r.checked = true;
    }
  }
}

function downloadAgentContract() {
  const tenantName = ($('acf_tenant_name')||{}).value?.trim();
  if (!tenantName) { showToast('Tenant name is required', 'error'); return; }
  const v  = id => { const el=$(id); return el ? (el.value||'').trim() : ''; };
  const vn = id => Number(v(id)) || 0;
  const usageEl = document.querySelector('input[name="acf_usage"]:checked');
  const html = buildAgentContractHTML({
    date:            v('date'),
    ownerName:       v('owner_name'),
    lessorName:      v('lessor_name'),
    lessorEid:       v('lessor_eid'),
    lessorPhone:     v('lessor_phone'),
    lessorEmail:     v('lessor_email'),
    lessorLicense:   v('lessor_license'),
    lessorAuthority: v('lessor_authority'),
    tenantName:      v('tenant_name'),
    tenantEid:       v('tenant_eid'),
    tenantPhone:     v('tenant_phone'),
    tenantEmail:     v('tenant_email'),
    tenantLicense:   v('tenant_license'),
    tenantAuthority: v('tenant_authority'),
    usage:           usageEl ? usageEl.value : 'Commercial',
    plotNo:          v('plot_no'),
    makaniNo:        v('makani_no'),
    buildingName:    v('building_name'),
    propertyNo:      v('property_no'),
    propType:        v('property_type'),
    area:            v('property_area'),
    location:        v('location'),
    dewaNo:          v('dewa_no'),
    from:            v('from'),
    to:              v('to'),
    contractValue:   vn('contract_value'),
    annualRent:      vn('annual_rent'),
    deposit:         vn('deposit'),
    paymentMode:     v('payment_mode'),
    add1: v('add1'), add2: v('add2'), add3: v('add3'), add4: v('add4'), add5: v('add5')
  });
  const w = window.open('', '_blank');
  if (!w) { showToast('Pop-up blocked — allow pop-ups and try again', 'error'); return; }
  w.document.write(html);
  w.document.close();
  // Wait for all images (logos) to load before triggering print
  w.addEventListener('load', () => {
    const imgs = w.document.images;
    let loaded = 0;
    const total = imgs.length;
    if (total === 0) { setTimeout(() => w.print(), 300); return; }
    const tryPrint = () => { if (++loaded >= total) setTimeout(() => w.print(), 200); };
    Array.from(imgs).forEach(img => {
      if (img.complete) tryPrint();
      else { img.onload = tryPrint; img.onerror = tryPrint; }
    });
  });
}

function buildAgentContractHTML(d) {
  // ── helpers ───────────────────────────────────────
  const he = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const v  = s => he(s||'');
  const fmtDate = s => {
    if (!s) return '';
    try { return new Date(s).toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'}); }
    catch(e){ return s; }
  };
  const fmtAED = n => n ? 'AED ' + Number(n).toLocaleString() : '';

  // ── field renderers ───────────────────────────────
  // Single full-width field row: EN label | value on line | AR label
  const f = (en, ar, val, subEn) => `
  <tr class="f-row">
    <td class="f-en">${en}${subEn?`<br><span class="f-sub">${subEn}</span>`:''}</td>
    <td class="f-val"><div class="f-line">${v(val)}</div></td>
    <td class="f-ar">${ar}</td>
  </tr>`;

  // Two fields side-by-side
  const f2 = (en1,ar1,val1,subEn1, en2,ar2,val2,subEn2) => `
  <tr class="f-row">
    <td class="f-en">${en1}${subEn1?`<br><span class="f-sub">${subEn1}</span>`:''}</td>
    <td class="f-val"><div class="f-line">${v(val1)}</div></td>
    <td class="f-ar f-mid">${ar1}</td>
    <td class="f-en">${en2}${subEn2?`<br><span class="f-sub">${subEn2}</span>`:''}</td>
    <td class="f-val"><div class="f-line">${v(val2)}</div></td>
    <td class="f-ar">${ar2}</td>
  </tr>`;

  // Section header
  const sh = (en,ar) =>
    `<div class="sh"><span class="sh-en">${en}</span><span class="sh-ar">${ar}</span></div>`;

  // Radio circle
  const radio = sel => sel
    ? `<span class="rb rb-on"></span>`
    : `<span class="rb"></span>`;

  // ── Exact official clauses from DLD EJARI PDF ─────
  const CLAUSES = [
    ['The tenant has inspected the premises and agreed to lease the unit on its current condition.',
     'عاين المستأجر الوحدة موضوع الايجار ووافق على إستئجار العقار على حالته الحالية.'],
    ['Tenant undertakes to use the premises for designated purpose, tenant has no rights to transfer or relinquish the tenancy contract either with or without counterpart to any party without landlord written approval. Also, tenant is not allowed to sublease the premises or any part thereof to third party in whole or in part unless it is legally permitted.',
     'يتعهد المستأجر باستعمال المأجور للغرض المخصص له، و لا يجوز للمستأجر تحويل أو التنازل عن عقد الايجار للغير بمقابل أو دون مقابل دون موافقة المالك خطياً، كما لا يجوز للمستأجر تأجير المأجور أو أي جزء منه من الباطن مالم يسمح بذلك قانوناً.'],
    ['The tenant undertakes not to make any amendments, modifications or addendums to the premises subject of the contract without obtaining the landlord written approval. Tenant shall be liable for any damages or failure due to that.',
     'يتعهد المستأجر بعدم إجراء أي تعديلات أو إضافات على العقار موضوع العقد دون موافقة المالك الخطية، و يكون المستأجر مسؤولاً عن أي أضرار أو نقص أو تلف يلحق بالعقار.'],
    ['The tenant shall be responsible for payment of all electricity, water, cooling and gas charges resulting of occupying leased unit unless other condition agreed in written.',
     'يكون المستأجر مسؤولاً عن سداد كافة فواتير الكهرباء و المياه و التبريد و الغاز المترتبة عن اشغاله المأجور مالم يتم الاتفاق على غير ذلك كتابياً.'],
    ['The tenant must pay the rent amount in the manner and dates agreed with the landlord.',
     'يتعهد المستأجر بسداد مبلغ الايجار المتفق عليه في هذا العقد في التواريخ و الطريقة المتفق عليها.'],
    ['The tenant fully undertakes to comply with all the regulations and instructions related to the management of the property and the use of the premises and of common areas such (parking, swimming pools, gymnasium, etc…).',
     'يلتزم المستأجر التقيد التام بالانظمة و التعليمات المتعلقة باستخدام المأجور و المنافع المشتركة (كمواقف السيارات، أحواض السباحة، النادي الصحي، الخ).'],
    ['Tenancy contract parties declare all mentioned email addresses and phone numbers are correct, all formal and legal notifications will be sent to those addresses in case of dispute between parties.',
     'يقر أطراف التعاقد بصحة العناوين و أرقام الهواتف المذكورة أعلاه، و تكون تلك العناوين هي المعتمدة رسمياً للإخطارات و الأعلانات القضائية في حال نشوء أي نزاع بين أطراف العقد.'],
    ['The landlord undertakes to enable the tenant of the full use of the premises including its facilities (swimming pool, gym, parking lot, etc) and do the regular maintenance as intended unless other condition agreed in written, and not to do any act that would detract from the premises benefit.',
     'يتعهد المؤجر بتمكين المستأجر من الانتفاع التام بالعقار للغرض المؤجر لأجله و المرافق الخاصة به (حوض سباحة، نادي صحي، مواقف سيارات، إلخ....) كما يكون مسؤولاً عن أعمال الصيانة مالم يتم الاتفاق على غير ذلك، و عدم التعرض له في منفعة العقار.'],
    ['By signing this agreement from the first party, the "Landlord" hereby confirms and undertakes that he is the current owner of the property or his legal representative under legal power of attorney duly entitled by the competent authorities.',
     'يعتبر توقيع المؤجر على هذا العقد إقراراً منه بأنه المالك الحالي للعقار أو الوكيل القانوني للمالك بموجب وكالة قانونية موثقة وفق الأصول لدى الجهات المختصة.'],
    ['Any disagreement or dispute may arise from execution or interpretation of this contract shall be settled by the Rental Dispute Center.',
     'أي خلاف أو نزاع قد ينشأ عن تنفيذ أو تفسير هذا العقد يعود البت فيه لمركز فض المنازعات الإيجارية.'],
    ['This contract is subject to all provisions of Law No (26) of 2007 regulating the relation between landlords and tenants in the emirate of Dubai as amended, and as it will be changed or amended from time to time, as long with any related legislations and regulations applied in the emirate of Dubai.',
     'يخضع هذا العقد لكافة أحكام القانون رقم ( 26 ) لسنة 2007 بشأن تنظيم العلاقة بين مؤجري و مستأجري العقارات في إمارة دبي، و تعديلاته و أي تغيير أو تعديل يطرأ عليه من وقت لآخر، كما يخضع للتشريعات و اللوائح الأخرى ذات العلاقة النافذة في دبي.'],
    ['Any additional condition will not be considered in case it conflicts with law.',
     'لا يعتد بأي شرط تم إضافته إلى هذا العقد في حال تعارضه مع القانون.'],
    ['In case of discrepancy occurs between Arabic and non Arabic texts with regards to the interpretation of this agreement or the scope of its application, the Arabic text shall prevail.',
     'في حال حدوث أي تعارض أو اختلاف في التفسير بين النص العربي و النص الأجنبي يعتمد النص العربي.'],
    ['The landlord undertakes to register this tenancy contract on EJARI affiliated to Dubai Land Department and provide with all required documents.',
     'يتعهد المؤجر بتسجيل عقد الايجار في نظام إيجاري التابع لدائرة الأراضي و الأملاك و توفير كافة المستندات اللازمة لذلك.']
  ];

  const clauseRows = CLAUSES.map(([en,ar],i)=>`
    <tr class="${i%2?'cl-even':''}">
      <td class="cl-n">${i+1}.</td>
      <td class="cl-e">${he(en)}</td>
      <td class="cl-a">${he(ar)}</td>
    </tr>`).join('');

  // ── Signature block (official: 2 parties only) ────
  const addTermsList = [d.add1,d.add2,d.add3,d.add4,d.add5];
  const sigBlock = `
  <div class="sig-wrap">
    <div class="sh"><span class="sh-en">Signatures</span><span class="sh-ar">التوقيعات</span></div>
    <table class="sig-tbl">
      <tr>
        <td class="sig-box">
          <div class="sig-lbl">Tenant Signature &nbsp; <span class="sig-lbl-ar">توقيع المستأجر</span></div>
          <div class="sig-line"></div>
          <div class="sig-date-row">Date <span class="sig-date-line"></span> <span class="sig-ar-date">التاريخ</span></div>
        </td>
        <td class="sig-box">
          <div class="sig-lbl">Lessor's Signature &nbsp; <span class="sig-lbl-ar">توقيع المؤجر</span></div>
          <div class="sig-line"></div>
          <div class="sig-date-row">Date <span class="sig-date-line"></span> <span class="sig-ar-date">التاريخ</span></div>
        </td>
      </tr>
    </table>
  </div>`;


  // ── reusable header (all 3 pages) ─────────────────
  const GOV_B64 = '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';
  const DLD_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAnYAAAC7CAYAAADovdO6AABOc0lEQVR42u2deXxTdfawn3uzNelGFwoURBZZLKCIIJuCgKOio4KoKCo6LuAy4zbzCuM646gj/tBBHWVE3BUBQXAZQEcRFJClIAiUfSt7d9omTZOb3PePNGmSJm26gAjn8XNtEtIsN7e9T8/5nnMUXdd1BEEQBEEQhN88quwCQRAEQRAEETtBEARBEARBxE4QBEEQBEEQsRMEQRAEQRBE7ARBEARBEETsBEEQBEEQBBE7QRAEQRAEQcROEARBEARBELETBEEQBEEQsRMEQRAEQRBE7ARBEARBEAQRO0EQBEEQBEHEThAEQRAEQRCxEwRBEARBELETBEEQBEEQROwEQRAEQRAEETtBEARBEARBxE4QBEEQBEHEThAEQRAEQRCxEwRBEARBEETsBEEQBEEQBBE7QRAEQRAEETtBEARBEARBxE4QBEEQBEEQsRMEQRAEQRBE7ARBEARBEAQRO0EQBEEQBBE7QRAEQRAEQcROEARBEARBELETBEEQBEEQROwEQRAEQRBE7ARBEARBEAQRO0EQBEEQBEHEThAEQRAEQRCxEwRBEARBELETBEEQBEEQROwEQRAEQRAEETtBEARBEARBxE4QBEEQBEEQsRMEQRAEQRCxEwRBEARBEETsBEEQBEEQBBE7QRAEQRAEQcROEARBEARBxE4QBEEQBEEQsRMEQRAEQRBE7ARBEARBEAQRO0EQBEEQBEHEThAEQRAEQcROEARBEARBELETBEEQBEEQROwEQRAEQRAEETtBEARBEAQRO0EQBEEQBEHEThAEQRAEQRCxEwRBEARBEETsBEEQBEEQROwEQRAEQRAEETtBEARBEARBxE4QBEEQBEEQsRMEQRAEQRBE7ARBEARBEETsBEEQBEEQBBE7QRAEQRAEQcROEARBEARBELETBEEQBEEQsRMEQRAEQRBE7ARBEARBEAQRO0EQBEEQBEHEThAEQRAEQcROEARBEARBELETBEEQBEEQROwEQRAEQRAEETtBEARBEARBxE4QBEEQBEHEThAEQRAEQRCxEwRBEARBEETsBEEQBEEQBBE7QRAEQRAEETtBEARBEARBxE4QBEEQBEEQsRMEQRAEQRBE7ARBEARBEAQRO0EQBEEQBBE7QRAEQRAEQcROEARBEARBELET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';
  const hdrHTML = `
  <div class="hdr">
    <div class="hdr-logo"><img src="data:image/png;base64,${GOV_B64}" style="height:62px;width:auto;" alt="Government of Dubai"></div>
    <div class="hdr-center">
      <div class="hdr-gov-ar">حكومة دبي — دائرة الأراضي والأملاك</div>
      <div class="hdr-gov-en">GOVERNMENT OF DUBAI — DUBAI LAND DEPARTMENT</div>
      <div class="hdr-title-wrap">
        <div class="hdr-ar">عـقـد إيـجـار</div>
        <div class="hdr-en">TENANCY CONTRACT</div>
      </div>
    </div>
    <div class="hdr-logo" style="text-align:right;"><img src="data:image/png;base64,${DLD_B64}" style="height:62px;width:auto;" alt="Land Department"></div>
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Tenancy Contract${d.tenantName?' — '+he(d.tenantName):''}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}
body{font-family:Arial,sans-serif;font-size:9.5pt;color:#111;background:#fff;}
.page{width:210mm;min-height:297mm;margin:0 auto;padding:12mm 13mm;background:#fff;position:relative;}
.page-break{page-break-after:always;break-after:page;}
@media print{
  html,body{width:210mm;margin:0;padding:0;}
  .page{width:210mm;min-height:297mm;margin:0;padding:10mm 11mm;page-break-after:always;break-after:page;}
  .page:last-child{page-break-after:avoid;break-after:avoid;}
  @page{size:A4 portrait;margin:0;}
}

/* ── EJARI Watermark ── */
.page::before{
  content:'إيجاري';
  position:fixed;
  top:50%;left:50%;
  transform:translate(-50%,-50%);
  font-size:110pt;
  font-weight:900;
  color:rgba(180,160,100,0.10);
  white-space:nowrap;
  pointer-events:none;
  z-index:0;
  letter-spacing:8px;
}
.page>*{position:relative;z-index:1;}

/* ── Header ── */
.hdr{display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #bbb;padding-bottom:8px;margin-bottom:7px;}
.hdr-logo{display:flex;align-items:center;}
.hdr-center{flex:1;text-align:center;padding:0 10px;}
.hdr-gov-ar{font-size:10.5pt;font-weight:900;color:#8b1a1a;direction:rtl;}
.hdr-gov-en{font-size:8pt;font-weight:700;color:#8b1a1a;letter-spacing:0.3px;}
.hdr-title-wrap{display:inline-block;border:1.5px solid #555;padding:3px 22px;margin:4px 0;}
.hdr-ar{font-size:15pt;font-weight:900;letter-spacing:4px;}
.hdr-en{font-size:9.5pt;font-weight:700;letter-spacing:2px;}

/* ── Date row ── */
.date-row{display:flex;align-items:flex-end;gap:8px;margin-bottom:6px;font-size:8.5pt;}
.date-val{border-bottom:1px solid #999;min-width:160px;font-weight:700;font-size:9.5pt;padding-bottom:1px;}

/* ── Section header ── */
.sh{background:#1c2b4a !important;color:#fff !important;padding:4px 8px;display:flex;justify-content:space-between;align-items:center;margin-bottom:0;}
.sh-en{font-size:9pt;font-weight:700;color:#fff !important;}
.sh-ar{font-size:9pt;font-weight:700;direction:rtl;color:#fff !important;}

/* ── Field table ── */
.sec{border:1px solid #c5c5c5;margin-bottom:5px;}
.ft{width:100%;border-collapse:collapse;}
.f-row td{border-bottom:1px solid #e8e8e8;vertical-align:bottom;padding:5px 7px 3px;}
.f-row:last-child td{border-bottom:none;}
.f-en{font-size:7.5pt;font-weight:700;color:#1c2b4a;white-space:nowrap;width:1%;padding-right:4px;}
.f-sub{font-size:6pt;color:#999;font-weight:400;font-style:italic;}
.f-val{width:auto;}
.f-line{border-bottom:1px solid #999;min-height:13px;font-size:9.5pt;color:#111;padding-bottom:1px;}
.f-ar{font-size:7.5pt;color:#888;direction:rtl;white-space:nowrap;width:1%;padding-left:4px;text-align:right;}
.f-mid{border-right:1px solid #d0d0d0;padding-right:10px;}

/* ── Usage ── */
.usage-row{padding:5px 7px;border-bottom:1px solid #e8e8e8;}
.usage-hdr{display:flex;justify-content:space-between;margin-bottom:3px;}
.usage-opts{display:flex;gap:22px;}
.uopt{display:flex;align-items:center;gap:5px;font-size:9pt;}
.rb{display:inline-block;width:11px;height:11px;border:1.5px solid #444;border-radius:50%;flex-shrink:0;}
.rb.rb-on{background:#1c2b4a !important;border-color:#1c2b4a !important;}

/* ── Clauses ── */
.cls-hdr{background:#1c2b4a !important;color:#fff !important;padding:4px 8px;display:flex;justify-content:space-between;font-size:9pt;font-weight:700;}
.cls-hdr span:last-child{font-weight:400;font-size:7.5pt;}
.cls-tbl{width:100%;border-collapse:collapse;font-size:8pt;}
.cls-tbl tr{page-break-inside:avoid;break-inside:avoid;}
.cls-tbl td{vertical-align:top;padding:3px 5px;border:1px solid #ddd;line-height:1.4;}
.cl-n{width:18px;font-weight:700;color:#1c2b4a;text-align:center;white-space:nowrap;background:#f0f3f8 !important;}
.cl-e{width:52%;}
.cl-a{direction:rtl;text-align:right;color:#333;}
.cl-even td{background:#f8f9fb !important;}
.cl-even .cl-n{background:#e8edf5 !important;}

/* ── Know Your Rights ── */
.rights{border:1px solid #c9a84c;padding:6px 9px;margin-bottom:4px;}
.rights-row{display:flex;justify-content:space-between;font-size:8pt;margin-bottom:3px;line-height:1.5;}
.rights-row span:last-child{direction:rtl;text-align:right;color:#555;}

/* ── Attachments ── */
.att-hdr{display:flex;justify-content:space-between;font-size:9pt;font-weight:700;margin-bottom:3px;margin-top:6px;}
.att-hdr span:last-child{direction:rtl;color:#555;font-weight:400;}
.att-item{display:flex;justify-content:space-between;font-size:8.5pt;margin-bottom:2px;}
.att-item span:last-child{direction:rtl;color:#555;}

/* ── Additional Terms ── */
.add-hdr{display:flex;justify-content:space-between;font-size:9pt;font-weight:700;margin-top:6px;margin-bottom:3px;}
.add-hdr span:last-child{direction:rtl;color:#555;font-weight:400;}
.add-item{display:flex;gap:6px;font-size:9pt;margin-bottom:4px;}
.add-n{font-weight:700;min-width:14px;}
.add-line{flex:1;border-bottom:1px solid #aaa;min-height:14px;font-size:9pt;padding-bottom:1px;}
.add-note{font-size:7.5pt;color:#666;margin-top:4px;display:flex;justify-content:space-between;}
.add-note span:last-child{direction:rtl;color:#888;}

/* ── Signatures ── */
.sig-wrap{border:1px solid #c5c5c5;margin-top:6px;page-break-inside:avoid;break-inside:avoid;page-break-before:avoid;break-before:avoid;}
.sig-tbl{width:100%;border-collapse:collapse;}
.sig-box{width:50%;padding:8px 10px;border-right:1px solid #c5c5c5;vertical-align:top;}
.sig-box:last-child{border-right:none;}
.sig-lbl{font-size:8.5pt;font-weight:700;color:#1c2b4a;margin-bottom:4px;}
.sig-lbl-ar{direction:rtl;color:#555;font-weight:400;}
.sig-line{border-bottom:1.5px solid #555;height:32px;margin:4px 0;}
.sig-date-row{display:flex;align-items:flex-end;gap:4px;font-size:8pt;color:#666;margin-top:3px;}
.sig-date-line{border-bottom:1px dotted #aaa;flex:1;height:12px;}
.sig-ar-date{direction:rtl;white-space:nowrap;}

/* ── Footer ── */
.doc-footer{border-top:1px solid #ccc;padding-top:4px;margin-top:auto;display:flex;justify-content:space-between;font-size:7pt;color:#999;}
.doc-footer span:last-child{direction:rtl;}
</style>
</head>
<body>

<!-- ═══════════════════════════════════════════════ -->
<!--  PAGE 1 — Parties · Property · Contract        -->
<!-- ═══════════════════════════════════════════════ -->
<div class="page page-break">

  <!-- Header -->
  ${hdrHTML}

  <!-- Date -->
  <div class="date-row">
    <span>التاريخ</span>
    <span class="date-val">${v(fmtDate(d.date))}</span>
    <span style="margin-left:4px;">Date</span>
  </div>

  <!-- Owner / Lessor -->
  <div class="sec">
    ${sh('Owner / Lessor Information','معلومات المالك / المؤجر')}
    <table class="ft">
      ${f("Owner's Name",'اسم المالك',d.ownerName)}
      ${f("Lessor's Name",'اسم المؤجر',d.lessorName||d.ownerName)}
      ${f("Lessor's Emirates ID",'الهوية الإماراتية للمؤجر',d.lessorEid)}
      ${f2("License No.",'رقم الرخصة',d.lessorLicense,'Incase of a Company','Licensing Authority','سلطة الترخيص',d.lessorAuthority,'Incase of a Company')}
      ${f("Lessor's Email",'البريد الإلكتروني للمؤجر',d.lessorEmail)}
      ${f("Lessor's Phone",'رقم هاتف المؤجر',d.lessorPhone)}
    </table>
  </div>

  <!-- Tenant -->
  <div class="sec">
    ${sh('Tenant Information','معلومات المستأجر')}
    <table class="ft">
      ${f("Tenant's Name",'اسم المستأجر',d.tenantName)}
      ${f("Tenant's Emirates ID",'الهوية الإماراتية للمستأجر',d.tenantEid)}
      ${f2("License No.",'رقم الرخصة',d.tenantLicense,'Incase of a Company','Licensing Authority','سلطة الترخيص',d.tenantAuthority,'Incase of a Company')}
      ${f("Tenant's Email",'البريد الإلكتروني للمستأجر',d.tenantEmail)}
      ${f("Tenant's Phone",'رقم هاتف المستأجر',d.tenantPhone)}
    </table>
  </div>

  <!-- Property -->
  <div class="sec">
    ${sh('Property Information','معلومات العقار')}
    <div class="usage-row">
      <div class="usage-hdr">
        <span class="f-en">Property Usage</span>
        <span class="f-ar">استخدام العقار</span>
      </div>
      <div class="usage-opts">
        <div class="uopt">${radio(d.usage==='Industrial')} Industrial &nbsp;صناعي</div>
        <div class="uopt">${radio(d.usage==='Commercial')} Commercial &nbsp;تجاري</div>
        <div class="uopt">${radio(d.usage==='Residential')} Residential &nbsp;سكني</div>
      </div>
    </div>
    <table class="ft">
      ${f2('Plot No.','رقم الأرض',d.plotNo,'','Makani No.','رقم مكاني',d.makaniNo,'')}
      ${f2('Building Name','اسم المبنى',d.buildingName,'','Property No.','رقم العقار',d.propertyNo,'')}
      ${f2('Property Type','نوع الوحدة',d.propType,'','Property Area (s.m)','مساحة العقار (متر.مربع)',d.area?d.area+' m²':'','')}
      ${f2('Location','الموقع',d.location,'','Premises No. (DEWA)','رقم المبنى (ديوا)',d.dewaNo,'')}
    </table>
  </div>

  <!-- Contract -->
  <div class="sec">
    ${sh('Contract Information','معلومات العقد')}
    <table class="ft">
      <tr class="f-row">
        <td class="f-en">Contract Period</td>
        <td class="f-val" colspan="4">
          <div style="display:flex;align-items:flex-end;gap:8px;">
            <span style="font-size:7.5pt;color:#1c2b4a;">From من</span>
            <div class="f-line" style="min-width:100px;">${v(fmtDate(d.from))}</div>
            <span style="font-size:7.5pt;color:#1c2b4a;">To إلى</span>
            <div class="f-line" style="min-width:100px;">${v(fmtDate(d.to))}</div>
          </div>
        </td>
        <td class="f-ar">فترة العقد</td>
      </tr>
      ${f2('Annual Rent','الايجار السنوي',fmtAED(d.annualRent),'','Contract Value','قيمة العقد',fmtAED(d.contractValue||d.annualRent),'')}
      ${f2('Security Deposit Amount','مبلغ التأمين',fmtAED(d.deposit),'','Mode of Payment','طريقة الدفع',d.paymentMode,'')}
    </table>
  </div>

  ${sigBlock}

  <div class="doc-footer">
    <span>support@dubailand.gov.ae</span>
    <span>دائرة الأراضي والأملاك — Real Estate Regulatory Agency (RERA)</span>
  </div>
</div>

<!-- ═══════════════════════════════════════════════ -->
<!--  PAGE 2 — Terms and Conditions (14 clauses)    -->
<!-- ═══════════════════════════════════════════════ -->
<div class="page page-break">
  ${hdrHTML}
  <div class="sh"><span class="sh-en">Terms and Conditions</span><span class="sh-ar">الأحكام و الشروط</span></div>
  <table class="cls-tbl">
    <colgroup><col style="width:20px"><col style="width:52%"><col></colgroup>
    ${clauseRows}
  </table>

  ${sigBlock}

  <div class="doc-footer">
    <span>support@dubailand.gov.ae</span>
    <span>دائرة الأراضي والأملاك — Real Estate Regulatory Agency (RERA)</span>
  </div>
</div>

<!-- ═══════════════════════════════════════════════ -->
<!--  PAGE 3 — Rights · Attachments · Add. Terms    -->
<!-- ═══════════════════════════════════════════════ -->
<div class="page">
  ${hdrHTML}

  <!-- Know Your Rights -->
  <div class="sh"><span class="sh-en">Know your Rights</span><span class="sh-ar">اعرف حقوقك</span></div>
  <div class="rights">
    <div class="rights-row">
      <span>You may visit Rental Dispute Center website through www.rdc.gov.ae in case of any rental dispute between parties.</span>
      <span>يمكنكم زيارة مركز فض المنازعات الإيجارية من خلال www.rdc.gov.ae في حال نشوء أي نزاع إيجاري بين الأطراف</span>
    </div>
    <div class="rights-row">
      <span>Law No 26 of 2007 regulating relationship between landlords and tenants</span>
      <span>الإطلاع على قانون رقم 26 لسنة 2007 بشأن تنظيم العلاقة بين المؤجرين والمستأجرين</span>
    </div>
    <div class="rights-row">
      <span>Law No 33 of 2008 amending law 26 of year 2007</span>
      <span>الإطلاع على قانون رقم 33 لسنة 2008 الخاص بتعديل بعض أحكام قانون 26 لعام 2007</span>
    </div>
    <div class="rights-row">
      <span>Law No 43 of 2013 determining rent increases for properties</span>
      <span>الإطلاع على قانون رقم 43 لسنة 2013 بشأن تحديد زيادة بدل الإيجار</span>
    </div>
  </div>

  <!-- Attachments for Ejari Registration -->
  <div class="sh"><span class="sh-en">Attachments for Ejari Registration</span><span class="sh-ar">مرفقات التسجيل في إيجاري</span></div>
  <div class="att-item">
    <span>1. Original unified tenancy contract</span>
    <span>نسخة أصلية عن عقد الايجار الموحد .١</span>
  </div>
  <div class="att-item">
    <span>2. Original emirates ID of applicant</span>
    <span>الهوية الإماراتية الأصلية لمقدم الطلب .٢</span>
  </div>

  <!-- Additional Terms -->
  <div class="sh"><span class="sh-en">Additional Terms</span><span class="sh-ar">شروط إضافية</span></div>
  ${addTermsList.map((t,i)=>`
  <div class="add-item">
    <span class="add-n">${i+1}.</span>
    <div class="add-line">${v(t)}</div>
    <span style="font-size:7pt;color:#888;padding-left:8px;direction:rtl;">.${['١','٢','٣','٤','٥'][i]}</span>
  </div>`).join('')}

  <div class="add-note">
    <span>Note : You may add addendum to this tenancy contract in case you have additional terms while it needs to be signed by all parties.</span>
    <span>ملاحظة: يمكن إضافة ملحق إلى هذا العقد في حال وجود أي شروط إضافية، على أن يوقع من أطراف التعاقد.</span>
  </div>

  ${sigBlock}

  <div class="doc-footer">
    <span>support@dubailand.gov.ae</span>
    <span>دائرة الأراضي والأملاك — Real Estate Regulatory Agency (RERA)</span>
  </div>
</div>

</body></html>`;
}

// ═══════════════════════════════════════════════════
// EXCEL AUTO-SYNC (live file watcher)
// Connect once → dashboard polls the file every few seconds
// → any change in the file is reflected on the dashboard.
// Uses File System Access API (Chrome/Edge). Falls back
// to manual upload in browsers that don't support it.
// ═══════════════════════════════════════════════════
const XLSYNC_DB     = 'asg_xlsync_v1';
const XLSYNC_STORE  = 'handles';
const XLSYNC_KEY    = 'master_handle';
const XLSYNC_POLL   = 4000;   // ms
let _xlsyncTimer    = null;
let _xlsyncLastMod  = 0;
let _xlsyncFileName = '';

// ── tiny IDB wrapper for storing FileSystemFileHandle ──
function _xlIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(XLSYNC_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(XLSYNC_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
async function _xlIdbPut(key, val) {
  const db = await _xlIdb();
  return new Promise((res, rej) => {
    const tx = db.transaction(XLSYNC_STORE, 'readwrite');
    tx.objectStore(XLSYNC_STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function _xlIdbGet(key) {
  const db = await _xlIdb();
  return new Promise((res, rej) => {
    const tx = db.transaction(XLSYNC_STORE, 'readonly');
    const r = tx.objectStore(XLSYNC_STORE).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function _xlIdbDelete(key) {
  const db = await _xlIdb();
  return new Promise((res, rej) => {
    const tx = db.transaction(XLSYNC_STORE, 'readwrite');
    tx.objectStore(XLSYNC_STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

const xlsyncSupported = () => typeof window.showOpenFilePicker === 'function';

// ── UI: open the modal ──
function openExcelSyncModal() {
  try {
    const ov = document.getElementById('excelSyncOverlay');
    if (!ov) {
      console.error('[xlsync] excelSyncOverlay element not found in DOM');
      if (typeof showToast === 'function') showToast('Excel sync UI failed to load — try refreshing (Cmd+Shift+R)', 'error');
      return;
    }
    ov.style.display = 'flex';
    renderXlsyncModal().catch(err => {
      console.error('[xlsync] renderXlsyncModal error:', err);
      const body = document.getElementById('excelSyncBody');
      if (body) body.innerHTML = `<div style="padding:20px;color:#b91c1c;background:#fee2e2;border-radius:8px;">
        <strong>Error opening Excel sync:</strong><br>${err.message || err}
        <br><br><button class="xlsync-btn xlsync-btn-ghost" onclick="closeExcelSyncModal()">Close</button>
      </div>`;
    });
  } catch (e) {
    console.error('[xlsync] openExcelSyncModal error:', e);
    alert('Excel sync error: ' + (e.message || e));
  }
}
function closeExcelSyncModal() {
  const ov = document.getElementById('excelSyncOverlay');
  if (ov) ov.style.display = 'none';
}

async function renderXlsyncModal() {
  const body = document.getElementById('excelSyncBody');
  if (!body) return;

  const supported = xlsyncSupported();
  const handle = supported ? await _xlIdbGet(XLSYNC_KEY).catch(() => null) : null;
  let perm = 'prompt';
  if (handle) {
    try { perm = await handle.queryPermission({ mode: 'read' }); } catch { perm = 'prompt'; }
  }

  if (!supported) {
    body.innerHTML = `
      <div class="xlsync-not-supported">
        <strong>Live auto-sync requires Chrome or Edge.</strong> Safari & Firefox don't yet support the File System Access API.
        You can still use one-click manual sync below — pick the Excel file each time you've made changes.
      </div>
      <div class="xlsync-step">
        <h4><span class="step-num">1</span>Open the master Excel sheet</h4>
        <p>The template lives at <code>~/Desktop/ASG Properties Master.xlsx</code>. Edit it, save, then come back here.</p>
      </div>
      <div class="xlsync-step">
        <h4><span class="step-num">2</span>Sync now</h4>
        <p>Pick the file — the dashboard will replace its contents with the rows from the spreadsheet.</p>
        <div class="xlsync-actions">
          <button class="xlsync-btn xlsync-btn-primary" onclick="xlsyncManualPick()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Choose Excel File &amp; Sync
          </button>
        </div>
      </div>`;
    return;
  }

  if (!handle || perm === 'denied') {
    body.innerHTML = `
      <div class="xlsync-step">
        <h4><span class="step-num">1</span>Open the master Excel sheet</h4>
        <p>The template is on your Desktop: <code>ASG Properties Master.xlsx</code>. Edit rows, save the file (Cmd+S), and the dashboard updates within seconds.</p>
      </div>
      <div class="xlsync-step">
        <h4><span class="step-num">2</span>Connect the file (one-time)</h4>
        <p>Click below and pick <code>ASG Properties Master.xlsx</code>. After granting permission, the dashboard will watch the file and auto-sync any changes you save.</p>
        <div class="xlsync-actions">
          <button class="xlsync-btn xlsync-btn-primary" onclick="xlsyncConnect()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            Connect Excel File
          </button>
        </div>
      </div>`;
    return;
  }

  // Connected
  const lastSync = localStorage.getItem('asg_xlsync_lastsync') || '';
  const lastSyncRel = lastSync ? _xlsyncRelTime(lastSync) : 'not yet';
  const propCount = loadProps().length;
  const twoWay = xlsyncIsTwoWay();

  body.innerHTML = `
    <div class="xlsync-status">
      <div class="xlsync-status-icon">${twoWay ? '⇄' : '✓'}</div>
      <div class="xlsync-status-info">
        <div class="xlsync-status-title">Connected: ${h(_xlsyncFileName || handle.name || 'Excel file')}</div>
        <div class="xlsync-status-detail">
          ${propCount} properties · last sync ${lastSyncRel} ·
          ${twoWay
            ? `<strong style="color:#0d9488">Two-way sync ON</strong> (Excel ⇄ Dashboard)`
            : `<span>One-way: Excel → Dashboard</span>`}
        </div>
      </div>
    </div>

    <div class="xlsync-toggle-row">
      <div class="xlsync-toggle-info">
        <div class="xlsync-toggle-title">Two-way sync (Excel ⇄ Dashboard)</div>
        <div class="xlsync-toggle-sub">
          When ON, anything you change in the dashboard is written back to Excel within 2 seconds.
          Perfect for trial runs where the office still works off the spreadsheet.
        </div>
      </div>
      <label class="xlsync-switch">
        <input type="checkbox" id="xlsyncTwoWayChk" ${twoWay ? 'checked' : ''} onchange="xlsyncToggleTwoWay(this.checked)">
        <span class="xlsync-slider"></span>
      </label>
    </div>

    <div class="xlsync-step">
      <h4><span class="step-num">✱</span>How it works</h4>
      <p><strong>Excel → Dashboard:</strong> Edit <code>ASG Properties Master.xlsx</code>, save (Cmd+S). Dashboard refreshes within ${XLSYNC_POLL/1000}s.</p>
      ${twoWay ? `
        <p style="margin-top:8px;"><strong>Dashboard → Excel:</strong> Add or edit a property in the dashboard — the change is written back to the spreadsheet automatically (1.5s delay so rapid edits batch).</p>
        <p style="margin-top:8px;font-size:12px;color:#92400e;background:#fef3c7;padding:8px 12px;border-radius:6px;border:1px solid #fcd34d;">
          <strong>⚠ Tip:</strong> Close the spreadsheet in Microsoft Excel before the dashboard writes — Excel may lock the file. The dashboard will retry until the file is free.
        </p>
      ` : `
        <p style="margin-top:8px;">Dashboard changes stay in the dashboard only. Toggle two-way sync above to push them back to Excel as well.</p>
      `}
    </div>

    <div class="xlsync-actions">
      <button class="xlsync-btn xlsync-btn-primary" onclick="xlsyncForceSync()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        Pull from Excel
      </button>
      ${twoWay ? `
        <button class="xlsync-btn xlsync-btn-ghost" onclick="xlsyncWriteFile().then(()=>renderXlsyncModal())">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Push to Excel
        </button>
      ` : ''}
      <button class="xlsync-btn xlsync-btn-ghost" onclick="xlsyncReconnect()">Reconnect different file</button>
      <button class="xlsync-btn xlsync-btn-danger" onclick="xlsyncDisconnect()">Disconnect</button>
    </div>`;
}

async function xlsyncToggleTwoWay(on) {
  if (on) {
    // Need to escalate permission to readwrite
    const handle = await _xlIdbGet(XLSYNC_KEY);
    if (handle) {
      let perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          showToast('Two-way sync needs write permission on the Excel file', 'error');
          document.getElementById('xlsyncTwoWayChk').checked = false;
          return;
        }
      }
    }
  }
  xlsyncSetTwoWay(on);
  showToast(on ? '✓ Two-way sync enabled' : 'Two-way sync disabled', 'success');
  renderXlsyncModal();
  updateXlsyncPill();
}

function _xlsyncRelTime(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 5) return 'just now';
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  return `${Math.floor(d/3600)}h ago`;
}

// ── Connect: ask user to pick the file, store handle ──
async function xlsyncConnect() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Excel Workbook', accept: {
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
        'application/vnd.ms-excel': ['.xls'],
      }}],
      multiple: false,
    });
    await _xlIdbPut(XLSYNC_KEY, handle);
    _xlsyncFileName = handle.name;
    _xlsyncLastMod  = 0; // force first sync
    showToast('Excel connected — syncing…', 'success');
    await xlsyncForceSync();
    xlsyncStartWatcher();
    renderXlsyncModal();
    updateXlsyncPill();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(e);
      showToast('Could not connect Excel file: ' + e.message, 'error');
    }
  }
}

async function xlsyncReconnect() { await xlsyncConnect(); }

async function xlsyncDisconnect() {
  if (!confirm('Disconnect Excel? Properties currently in the dashboard will remain — only the live sync stops.')) return;
  if (_xlsyncTimer) { clearInterval(_xlsyncTimer); _xlsyncTimer = null; }
  await _xlIdbDelete(XLSYNC_KEY);
  _xlsyncFileName = '';
  _xlsyncLastMod = 0;
  localStorage.removeItem('asg_xlsync_lastsync');
  renderXlsyncModal();
  updateXlsyncPill();
  showToast('Excel sync disconnected', 'success');
}

// ── Manual one-shot picker (fallback for browsers without persistent handles) ──
async function xlsyncManualPick() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await xlsyncImportFromFile(file);
    closeExcelSyncModal();
  };
  input.click();
}

// ── Force a sync (read file, parse, merge into props) ──
async function xlsyncForceSync() {
  try {
    const handle = await _xlIdbGet(XLSYNC_KEY);
    if (!handle) { showToast('No Excel file connected', 'error'); return; }
    let perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      perm = await handle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') { showToast('Permission denied', 'error'); return; }
    }
    const file = await handle.getFile();
    _xlsyncFileName = file.name;
    await xlsyncImportFromFile(file);
    _xlsyncLastMod = file.lastModified;
  } catch (e) {
    console.error('xlsyncForceSync', e);
    showToast('Sync failed: ' + e.message, 'error');
  }
}

// ── Read a File object, parse, merge ──
async function xlsyncImportFromFile(file) {
  if (typeof XLSX === 'undefined') {
    showToast('Excel parser still loading — try again in a second', 'error'); return;
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });

  // Find the Properties sheet (or the first non-README sheet)
  let sheetName = wb.SheetNames.find(n => n.toLowerCase() === 'properties')
                 || wb.SheetNames.find(n => n.toLowerCase() !== 'readme')
                 || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });

  // Map each row to a property object
  const fromExcel = rows
    .map((r, i) => xlsyncRowToProp(r, i))
    .filter(p => p && p.name);

  // Set the ingest flag so persistProps doesn't trigger a write-back loop
  window._xlsyncIngesting = true;
  try {
    // Merge: keep manually-added properties (no xlsync flag), replace all xlsync-managed ones
    const existing = loadProps();
    const manual = existing.filter(p => p._source !== 'xlsync');
    const merged = [...manual, ...fromExcel];
    persistProps(merged);
  } finally {
    window._xlsyncIngesting = false;
  }

  localStorage.setItem('asg_xlsync_lastsync', new Date().toISOString());

  if (typeof refresh === 'function') refresh();
  if (typeof renderNavCounts === 'function') renderNavCounts(loadProps());
  showToast(`✓ Synced ${fromExcel.length} propert${fromExcel.length===1?'y':'ies'} from Excel`, 'success');
  updateXlsyncPill();
}

// ═══════════════════════════════════════════════════
// TWO-WAY WRITE-BACK (dashboard → Excel)
// ═══════════════════════════════════════════════════
let _xlsyncWriteTimer   = null;
let _xlsyncWriting      = false;
const XLSYNC_WRITE_KEY  = 'asg_xlsync_twoway';

function xlsyncIsTwoWay()       { return localStorage.getItem(XLSYNC_WRITE_KEY) === '1'; }
function xlsyncSetTwoWay(on)    { localStorage.setItem(XLSYNC_WRITE_KEY, on ? '1' : '0'); }

// Debounced trigger — called every time dashboard mutates props.
// Waits 1.5s of quiet before writing, batching rapid edits.
function xlsyncQueueWrite() {
  if (!xlsyncIsTwoWay()) return;          // off → skip
  if (window._xlsyncIngesting) return;    // we're applying an Excel-driven change
  if (_xlsyncWriteTimer) clearTimeout(_xlsyncWriteTimer);
  _xlsyncWriteTimer = setTimeout(() => {
    _xlsyncWriteTimer = null;
    xlsyncWriteFile().catch(e => {
      console.warn('xlsync write-back failed:', e);
      showToast('Could not write to Excel: ' + (e.message||e), 'error');
    });
  }, 1500);
}

// Convert a property object → flat row dict matching Excel headers
function xlsyncPropToRow(p) {
  const yn = v => v === 'yes' ? 'yes' : v === 'no' ? 'no' : '';
  const num = v => (v == null || v === '') ? '' : v;
  return {
    'Property Name *':  p.name || '',
    'Type *':           p.type || '',
    'Unit Number':      p.unitNo || '',
    'Property Usage':   p.usage ? _fmtUsage(p.usage) : '',
    'Trade License':    p.tradeLicense || '',
    'Status':           p.status || '',
    'Location':         p.location || '',
    'Plot No.':         p.plotNo || '',
    'Size (sq ft)':     num(p.size),
    'Area (sq m)':      num(p.area),
    'Compound':         yn(p.compound),
    'Mezzanine':        yn(p.mezzanine),
    'Ownership':        p.ownership || '',
    'Partner Name':     p.partnerName || '',
    'Our Share (%)':    num(p.ourShare),
    'Property Owner':   p.ownerName || '',
    'Owner Phone':      p.ownerPhone || '',
    'Management Fee':   num(p.mgmtFee),
    'Purchase Price':   num(p.purchasePrice),
    'Purchase Date':    p.purchaseDate || '',
    'Market Value':     num(p.marketValue),
    'Annual Rent':      num(p.annualRent),
    'Tenant Name':      p.tenantName || '',
    'Tenant Phone':     p.tenantPhone || '',
    'Tenant Email':     p.tenantEmail || '',
    'Lease Start':      p.leaseStart || p.contractFrom || '',
    'Lease End':        p.leaseEnd || p.contractTo || '',
    'Reminder Days':    num(p.reminderDays),
    'Map Link':         p.mapLink || '',
    'Coordinates':      p.coords || '',
    'Notes':            p.notes || '',
  };
}

// Read existing Excel, replace data rows, write back. Preserves the
// header styling, README sheet, and any non-Properties sheets.
async function xlsyncWriteFile() {
  if (typeof XLSX === 'undefined') return;
  const handle = await _xlIdbGet(XLSYNC_KEY);
  if (!handle) return;

  // Need read+write permission
  let perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      showToast('Two-way sync needs write permission on the Excel file', 'error');
      return;
    }
  }

  _xlsyncWriting = true;
  updateXlsyncPill();
  try {
    const file = await handle.getFile();
    const buf  = await file.arrayBuffer();
    const wb   = XLSX.read(buf, { type: 'array', cellDates: true });

    let sheetName = wb.SheetNames.find(n => n.toLowerCase() === 'properties')
                   || wb.SheetNames.find(n => n.toLowerCase() !== 'readme')
                   || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];

    // Build new rows from current dashboard properties
    const props = loadProps().filter(p => p.name);    // skip empty rows
    const rows  = props.map(p => xlsyncPropToRow(p));

    // Read existing header order so we don't reshuffle columns
    const headers = XLSX.utils.sheet_to_json(ws, { header: 1 })[0]
                   || Object.keys(rows[0] || {});

    // Wipe all data rows (everything below row 1)
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let R = 1; R <= range.e.r; R++) {
      for (let C = 0; C <= range.e.c; C++) {
        delete ws[XLSX.utils.encode_cell({ r: R, c: C })];
      }
    }

    // Write fresh rows starting at A2
    XLSX.utils.sheet_add_json(ws, rows, {
      origin: 'A2',
      skipHeader: true,
      header: headers,
    });

    // Update sheet range
    ws['!ref'] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: rows.length, c: headers.length - 1 },
    });

    // Serialise + write back to file
    const out  = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const writable = await handle.createWritable();
    await writable.write(out);
    await writable.close();

    // Skip the next watcher tick — the file-mtime change is from us.
    const refreshed = await handle.getFile();
    _xlsyncLastMod = refreshed.lastModified;

    localStorage.setItem('asg_xlsync_lastsync', new Date().toISOString());
    showToast(`⇄ Wrote ${rows.length} rows to Excel`, 'success');
  } finally {
    _xlsyncWriting = false;
    updateXlsyncPill();
  }
}

// ── Row → Property object (column header → field name) ──
function xlsyncRowToProp(r, idx) {
  const get = (...keys) => {
    for (const k of keys) {
      for (const actualKey of Object.keys(r)) {
        if (actualKey.replace(/\s|\*|\(.*?\)/g,'').toLowerCase() === k.replace(/\s|\*|\(.*?\)/g,'').toLowerCase()) {
          const v = r[actualKey];
          if (v !== '' && v != null) return v;
        }
      }
    }
    return '';
  };
  const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[^\d.\-]/g,'')); return isNaN(n) ? null : n; };
  const str = v => v == null ? '' : String(v).trim();
  const yn  = v => { const s = str(v).toLowerCase(); return s === 'yes' || s === 'y' || s === 'true' ? 'yes' : (s === 'no' || s === 'n' || s === 'false' ? 'no' : ''); };
  const dt  = v => {
    if (!v) return '';
    if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0,10);
    const s = str(v);
    const d = new Date(s);
    return isNaN(d) ? s : d.toISOString().slice(0,10);
  };
  const typeMap = t => {
    const s = str(t).toLowerCase();
    if (s.startsWith('w')) return 'warehouse';
    if (s.startsWith('o')) return 'office';
    if (s.startsWith('r')) return 'residential';
    return s;
  };

  const name = str(get('Property Name','PropertyName','Name'));
  if (!name) return null;

  return {
    id: 'xls_' + name.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,40) + '_' + idx,
    _source: 'xlsync',
    name,
    type:          typeMap(get('Type')),
    status:        str(get('Status')).toLowerCase() || null,
    location:      str(get('Location')) || null,
    plotNo:        str(get('Plot No')),
    unitNo:        str(get('Unit Number','Unit No','Unit')) || null,
    tradeLicense:  str(get('Trade License','License No','License Number')) || null,
    usage:         (() => {
      const raw = str(get('Property Usage','Usage')).toLowerCase().trim();
      if (!raw) return null;
      // Normalise common spellings to the dropdown's internal values
      const map = {
        'labour camp':'labour_camp', 'labor camp':'labour_camp',
        'retail shop':'retail_shop',
        'storage use':'storage', 'storage':'storage',
        'warehouse':'warehouse', 'garage':'garage', 'shed':'shed',
        'factory':'factory', 'office':'office', 'workshop':'workshop',
        'showroom':'showroom',
      };
      return map[raw] || raw.replace(/\s+/g,'_');
    })(),
    size:          num(get('Size')),
    area:          num(get('Area')),
    compound:      yn(get('Compound')),
    mezzanine:     yn(get('Mezzanine')),
    ownership:     str(get('Ownership')).toLowerCase() || null,
    partnerName:   str(get('Partner Name','Partner')) || null,
    ourShare:      num(get('Our Share')),
    ownerName:     str(get('Property Owner','Owner Name','Owner')) || null,
    ownerPhone:    str(get('Owner Phone')) || null,
    mgmtFee:       num(get('Management Fee','Mgmt Fee')),
    purchasePrice: num(get('Purchase Price')),
    purchaseDate:  dt(get('Purchase Date')),
    marketValue:   num(get('Market Value')),
    annualRent:    num(get('Annual Rent','Rent')),
    tenantName:    str(get('Tenant Name')) || null,
    tenantPhone:   str(get('Tenant Phone')) || null,
    tenantEmail:   str(get('Tenant Email')) || null,
    leaseStart:    dt(get('Lease Start','Contract From','From')),
    leaseEnd:      dt(get('Lease End','Contract To','To')),
    contractFrom:  dt(get('Lease Start','Contract From','From')),
    contractTo:    dt(get('Lease End','Contract To','To')),
    reminderDays:  num(get('Reminder Days')) || 60,
    mapLink:       str(get('Map Link')) || null,
    coords:        str(get('Coordinates','Coords')) || null,
    notes:         str(get('Notes')) || null,
    createdAt:     new Date().toISOString(),
    updatedAt:     new Date().toISOString(),
  };
}

// ── Watcher: poll the file every XLSYNC_POLL ms ──
async function xlsyncStartWatcher() {
  if (_xlsyncTimer) clearInterval(_xlsyncTimer);
  if (!xlsyncSupported()) return;
  _xlsyncTimer = setInterval(async () => {
    try {
      const handle = await _xlIdbGet(XLSYNC_KEY);
      if (!handle) { clearInterval(_xlsyncTimer); _xlsyncTimer = null; return; }
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') return;   // wait for user gesture
      const file = await handle.getFile();
      if (file.lastModified > _xlsyncLastMod) {
        _xlsyncLastMod = file.lastModified;
        _xlsyncFileName = file.name;
        await xlsyncImportFromFile(file);
      }
    } catch (e) {
      // silent — file might be locked while user is saving
    }
  }, XLSYNC_POLL);
}

// ── Update header pill state ──
function updateXlsyncPill() {
  const pill = document.getElementById('excelSyncPill');
  const lbl  = document.getElementById('excelSyncLabel');
  if (!pill) return;
  _xlIdbGet(XLSYNC_KEY).then(h => {
    if (h) {
      pill.classList.add('active');
      const twoWay = xlsyncIsTwoWay();
      if (_xlsyncWriting) {
        lbl.innerHTML = `<span class="sync-dot"></span> Writing to Excel…`;
      } else if (twoWay) {
        lbl.innerHTML = `<span class="sync-dot"></span> Excel ⇄ synced`;
      } else {
        lbl.innerHTML = `<span class="sync-dot"></span> Excel synced`;
      }
    } else {
      pill.classList.remove('active');
      lbl.textContent = 'Connect Excel';
    }
  }).catch(() => {});
}

// ── Auto-start watcher on boot if a handle is already saved ──
async function xlsyncBoot() {
  updateXlsyncPill();
  if (!xlsyncSupported()) return;
  try {
    const handle = await _xlIdbGet(XLSYNC_KEY);
    if (!handle) return;
    const perm = await handle.queryPermission({ mode: 'read' });
    // Permission may need re-granting after browser restart; watcher will wait silently
    if (perm === 'granted') {
      const file = await handle.getFile();
      _xlsyncLastMod = file.lastModified;
      _xlsyncFileName = file.name;
    }
    xlsyncStartWatcher();
  } catch {}
}

// ═══════════════════════════════════════════════════
// ONE-TIME CLEANUP — remove Excel-imported properties
// ═══════════════════════════════════════════════════
function autoImportPropertiesFromExcel() {
  // Auto-import is disabled. This function now performs a one-time
  // cleanup: it wipes any property that was previously auto-imported
  // (id prefix "imp_") so the user gets a clean slate.
  const CLEAN_FLAG = 'asg_import_cleanup_v1_done';
  if (localStorage.getItem(CLEAN_FLAG)) return;

  const existing = loadProps();
  const kept = existing.filter(p => !(p.id || '').toString().startsWith('imp_'));
  const removed = existing.length - kept.length;

  if (removed > 0) {
    persistProps(kept);
    console.log(`✓ Cleanup: removed ${removed} Excel-imported properties; ${kept.length} manual entries kept.`);
    if (typeof showToast === 'function') {
      showToast(`Removed ${removed} imported properties — clean slate restored`, 'success');
    }
  }

  // Clear stale flags so nothing tries to re-import in the future
  localStorage.removeItem('asg_import_v1_done');
  localStorage.setItem(CLEAN_FLAG, '1');
}

// ═══════════════════════════════════════════════════
// HOME TAB (landing dashboard with tile navigation)
// ═══════════════════════════════════════════════════
function renderHome() {
  const root = document.getElementById('homeView');
  if (!root) return;

  const props      = loadProps();
  const warehouses = props.filter(p => p.type === 'warehouse').length;
  const offices    = props.filter(p => p.type === 'office').length;
  const residential= props.filter(p => p.type === 'residential').length;
  const rented     = props.filter(p => p.status === 'rented').length;
  const vacant     = props.filter(p => p.status === 'vacant').length;
  const totalRent  = props.filter(p => p.status === 'rented').reduce((s,p) => s + ourRentShare(p), 0);

  // Lease alerts
  const today = new Date();
  const leaseAlerts = props.filter(p => {
    if (p.status !== 'rented' || !p.leaseEnd) return false;
    const days = Math.ceil((new Date(p.leaseEnd) - today) / 86400000);
    const threshold = Number(p.reminderDays) || 60;
    return days <= threshold;
  }).length;

  let agentCount = 0, disputeCount = 0, constructionCount = 0;
  let offplanProjectCount = 0, developerCount = 0, secondaryCount = 0, proposalCount = 0;
  try { agentCount         = (loadAgents()                || []).length; } catch {}
  try { disputeCount       = (loadDisputes()              || []).filter(d => d.status !== 'closed').length; } catch {}
  try { constructionCount  = (loadConstructionProjects()  || []).filter(p => p.status !== 'completed').length; } catch {}
  try { offplanProjectCount = (loadProjects()             || []).length; } catch {}
  try { developerCount     = (loadDevelopers()            || []).length; } catch {}
  try { secondaryCount     = (loadSecondary()             || []).filter(x => x.status === 'active').length; } catch {}
  try { proposalCount      = (loadProposals()             || []).length; } catch {}

  // Tile definitions: tab id, label, group, badge count, accent colour, SVG path content
  const tiles = [
    { tab:'warehouses',  label:'Warehouses',       group:'Properties',  count:warehouses,  color:'#1c2b4a',
      svg:'<rect x="1" y="8" width="22" height="13" rx="2"/><path d="M1 8l11-6 11 6"/>' },
    { tab:'offices',     label:'Offices',          group:'Properties',  count:offices,     color:'#1c2b4a',
      svg:'<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="9" y1="7" x2="9" y2="7.01"/><line x1="15" y1="7" x2="15.01" y2="7"/><line x1="9" y1="12" x2="9" y2="12.01"/><line x1="15" y1="12" x2="15.01" y2="12"/>' },
    { tab:'residential', label:'Residential',      group:'Properties',  count:residential, color:'#1c2b4a',
      svg:'<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
    { tab:'offplan',     label:'Off-Plan',         group:'Properties',  count:offplanProjectCount, color:'#c9a84c',
      svg:'<path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9h.01"/><path d="M9 12h.01"/><path d="M9 15h.01"/><path d="M9 18h.01"/>' },
    { tab:'secondary',   label:'Secondary',        group:'Properties',  count:secondaryCount,      color:'#7a5d1e',
      svg:'<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>' },

    { tab:'reminders',   label:'Reminders',        group:'Operations',  count:leaseAlerts, color:'#dc2626',
      svg:'<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>' },
    { tab:'calendar',    label:'Calendar',         group:'Operations',                     color:'#0d9488',
      svg:'<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
    { tab:'contract',    label:'Contracts',        group:'Operations',                     color:'#7c3aed',
      svg:'<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
    { tab:'payment',     label:'Rentals',          group:'Operations',                     color:'#059669',
      svg:'<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>' },
    { tab:'proposals',   label:'Proposals',        group:'Operations',  count:proposalCount,color:'#0891b2',
      svg:'<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },

    { tab:'disputes',    label:'Disputes',         group:'Estate',      count:disputeCount,color:'#dc2626',
      svg:'<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' },
    { tab:'construction',label:'Construction',     group:'Estate',      count:constructionCount,color:'#ea580c',
      svg:'<polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/><line x1="12" y1="22" x2="12" y2="15.5"/><polyline points="22 8.5 12 15.5 2 8.5"/>' },
    { tab:'map',         label:'Map View',         group:'Estate',                         color:'#0369a1',
      svg:'<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>' },

    { tab:'team',        label:'Team',             group:'Management',  count:agentCount,  color:'#0891b2',
      svg:'<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
    { tab:'financials',  label:'Financials',       group:'Management',                     color:'#c9a84c',
      svg:'<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>' },
  ];

  const groups = ['Properties','Operations','Estate','Management'];
  const tilesByGroup = groups.map(g => ({
    name: g,
    items: tiles.filter(t => t.group === g),
  }));

  const auth = (() => { try { return JSON.parse(localStorage.getItem('asg_auth')) || {}; } catch { return {}; } })();
  const username = auth.user || 'Admin';

  root.innerHTML = `
    <div class="home-page">
      <div class="home-hero">
        <div class="home-hero-text">
          <div class="home-greet">${_homeGreeting()}</div>
          <h1 class="home-welcome">Welcome back, <span>${h(username)}</span></h1>
          <p class="home-tagline">Your complete portfolio at a glance — pick a section below to dive in.</p>
          <a href="/api/backup/all"
             style="display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:10px 18px;background:rgba(201,168,76,0.15);border:1px solid var(--gold);border-radius:8px;color:var(--gold);text-decoration:none;font-size:13px;font-weight:600;"
             title="Downloads /var/asg/uploads + the SQLite DB as a single .tar.gz">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download Full Backup
          </a>
        </div>
        <div class="home-hero-stats">
          <div class="home-stat">
            <div class="home-stat-value">${props.length}</div>
            <div class="home-stat-label">Total Properties</div>
          </div>
          <div class="home-stat">
            <div class="home-stat-value home-stat-success">${rented}</div>
            <div class="home-stat-label">Rented</div>
          </div>
          <div class="home-stat">
            <div class="home-stat-value home-stat-warn">${vacant}</div>
            <div class="home-stat-label">Vacant</div>
          </div>
          <div class="home-stat home-stat-wide">
            <div class="home-stat-value home-stat-gold">AED ${totalRent.toLocaleString()}</div>
            <div class="home-stat-label">Annual Rental Income</div>
          </div>
        </div>
      </div>

      ${tilesByGroup.map(grp => `
        <div class="home-group">
          <div class="home-group-label">${grp.name}</div>
          <div class="home-tiles">
            ${grp.items.map(t => `
              <button class="home-tile" onclick="showTab('${t.tab}')">
                <div class="home-tile-icon" style="background:linear-gradient(135deg, ${t.color}, ${_lightenHex(t.color, 18)});">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    ${t.svg}
                  </svg>
                  ${t.count != null && t.count > 0 ? `<span class="home-tile-badge" style="background:${t.color};">${t.count}</span>` : ''}
                </div>
                <div class="home-tile-label">${t.label}</div>
                <div class="home-tile-arrow">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                </div>
              </button>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function _homeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function _lightenHex(hex, amount) {
  const m = hex.replace('#','').match(/.{2}/g);
  if (!m) return hex;
  const [r,g,b] = m.map(x => Math.min(255, parseInt(x,16) + amount));
  return '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('');
}

// ═══════════════════════════════════════════════════
// FINANCIALS TAB (admin only)
// ═══════════════════════════════════════════════════
let _finYear = new Date().getFullYear();
let _finType = 'warehouse';   // warehouse | office | residential | all

function renderFinancials() {
  const props = loadProps();
  const yearsAvail = _finCollectYears(props);
  const root = document.getElementById('finPage');
  if (!root) return;

  // Build year selector options (current ± span)
  const allYears = Array.from(new Set([...yearsAvail, _finYear, new Date().getFullYear()]))
    .sort((a,b)=>b-a);

  const typeOpts = [
    ['warehouse',   'Warehouses'],
    ['office',      'Offices'],
    ['residential', 'Residential'],
    ['all',         'All Properties']
  ];

  root.innerHTML = `
    <div class="fin-header">
      <div>
        <h1 class="fin-title">Financials</h1>
        <p class="fin-sub">Track rental income and management fees across your portfolio</p>
      </div>
      <div class="fin-controls">
        <label class="fin-ctl">
          <span>Type</span>
          <select id="finTypeSel" onchange="_finSetType(this.value)">
            ${typeOpts.map(([v,l])=>`<option value="${v}" ${v===_finType?'selected':''}>${l}</option>`).join('')}
          </select>
        </label>
        <label class="fin-ctl">
          <span>Year</span>
          <select id="finYearSel" onchange="_finSetYear(+this.value)">
            ${allYears.map(y=>`<option value="${y}" ${y===_finYear?'selected':''}>${y}</option>`).join('')}
          </select>
        </label>
      </div>
    </div>
    <div id="finBody"></div>
  `;

  _finRenderBody(props);
}

function _finSetYear(y) { _finYear = y; renderFinancials(); }
function _finSetType(t) { _finType = t; renderFinancials(); }

function _finCollectYears(props) {
  const years = new Set();
  props.forEach(p => {
    [p.contractFrom, p.contractTo, p.leaseStart, p.leaseEnd].forEach(d => {
      if (d) {
        const y = new Date(d).getFullYear();
        if (!isNaN(y)) years.add(y);
      }
    });
  });
  // Always include current year
  years.add(new Date().getFullYear());
  return Array.from(years);
}

// Did this property's lease/contract overlap with the selected year?
function _finActiveInYear(p, year) {
  const start = p.contractFrom || p.leaseStart;
  const end   = p.contractTo   || p.leaseEnd;
  if (!start && !end) return false;
  const ys = new Date(year, 0, 1).getTime();
  const ye = new Date(year, 11, 31, 23, 59, 59).getTime();
  const ps = start ? new Date(start).getTime() : -Infinity;
  const pe = end   ? new Date(end).getTime()   :  Infinity;
  return ps <= ye && pe >= ys;
}

// Months of the year that are covered by the lease (0–12)
function _finMonthsActive(p, year) {
  const start = p.contractFrom || p.leaseStart;
  const end   = p.contractTo   || p.leaseEnd;
  if (!start || !end) return _finActiveInYear(p, year) ? 12 : 0;
  const ys = new Date(year, 0, 1);
  const ye = new Date(year, 11, 31);
  const ps = new Date(start);
  const pe = new Date(end);
  const a = ps > ys ? ps : ys;
  const b = pe < ye ? pe : ye;
  if (a > b) return 0;
  // calculate inclusive months
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1;
  return Math.max(0, Math.min(12, months));
}

function _finRenderBody(props) {
  const body = document.getElementById('finBody');
  if (!body) return;

  // Filter by selected type
  let pool = props;
  if (_finType !== 'all') pool = props.filter(p => p.type === _finType);

  // ── Rental income (annualized, our share, net of deductions) ──
  // Using FULL annual values (no months proration) so the figures match
  // what the home tile shows. Land charges + license fees + service
  // charges are deducted from the gross rent BEFORE applying ownership
  // share.
  const rentRows = pool
    .filter(p => p.status === 'rented' && (p.annualRent||0) > 0)
    .map(p => {
      const months = _finActiveInYear(p, _finYear) ? _finMonthsActive(p, _finYear) : 0;
      const annual = Number(p.annualRent)  || 0;
      const land   = Number(p.landCharges) || 0;
      const lic    = Number(p.licenseFees) || 0;
      const svc    = Number(p.serviceCharges) || 0;
      const dewa   = Number(p.dewaCharges) || 0;
      const ejari  = Number(p.ejariFees)   || 0;
      const cd     = Number(p.civilDefenseCharges) || 0;
      const legal  = Number(p.legalFee)    || 0;
      const ctax   = Number(p.corporateTax) || 0;
      const totalDed = land + lic + svc + dewa + ejari + cd + legal + ctax;
      const net    = Math.max(0, annual - totalDed);
      const sharePct = p.ownership === 'partnership' ? (Number(p.ourShare)||100) : 100;
      const ourIncome = Math.round(net * (sharePct/100));
      return { p, months, annual, land, lic, svc, dewa, ejari, cd, legal, ctax, totalDed, net,
               incomeYr: net, sharePct, ourIncome };
    })
    .sort((a,b) => b.ourIncome - a.ourIncome);

  const rentTotalGross = rentRows.reduce((s,r)=>s+r.annual, 0);
  const rentTotalLand  = rentRows.reduce((s,r)=>s+r.land,   0);
  const rentTotalLic   = rentRows.reduce((s,r)=>s+r.lic,    0);
  const rentTotalSvc   = rentRows.reduce((s,r)=>s+r.svc,    0);
  const rentTotalDewa  = rentRows.reduce((s,r)=>s+r.dewa,   0);
  const rentTotalEjari = rentRows.reduce((s,r)=>s+r.ejari,  0);
  const rentTotalCD    = rentRows.reduce((s,r)=>s+r.cd,     0);
  const rentTotalLegal = rentRows.reduce((s,r)=>s+r.legal,  0);
  const rentTotalCtax  = rentRows.reduce((s,r)=>s+r.ctax,   0);
  const rentTotalNet   = rentRows.reduce((s,r)=>s+r.net,    0);
  const deductionsTotal = rentTotalLand + rentTotalLic + rentTotalSvc
                        + rentTotalDewa + rentTotalEjari + rentTotalCD
                        + rentTotalLegal + rentTotalCtax;
  const rentTotalOurs  = rentRows.reduce((s,r)=>s+r.ourIncome, 0);

  // Security Deposit list (informational, ALL properties with a value)
  const depRows = pool
    .filter(p => Number(p.securityDeposit) > 0)
    .map(p => ({ p, amount: Number(p.securityDeposit) || 0 }))
    .sort((a,b) => b.amount - a.amount);
  const depTotal = depRows.reduce((s,r) => s + r.amount, 0);

  // Cash Receipts (rent paid in cash, not via cheques)
  const cashRows = pool
    .filter(p => Number(p.cashAmount) > 0)
    .map(p => ({ p, amount: Number(p.cashAmount) || 0 }))
    .sort((a,b) => b.amount - a.amount);
  const cashTotal = cashRows.reduce((s,r) => s + r.amount, 0);

  // Brokerage Income (one-off brokerage fees earned per property; ADDS to income)
  const brokerRows = pool
    .filter(p => Number(p.brokerageAmount) > 0)
    .map(p => ({ p, amount: Number(p.brokerageAmount) || 0 }))
    .sort((a,b) => b.amount - a.amount);
  const brokerTotal = brokerRows.reduce((s,r) => s + r.amount, 0);

  // Late + Bounced cheque fees — collected per cheque, summed per property.
  const feesByProp = [];
  let feesTotal = 0;
  for (const p of pool) {
    if (!Array.isArray(p.cheques)) continue;
    const items = p.cheques.filter(c => Number(c.lateFees) > 0);
    if (!items.length) continue;
    const sub = items.reduce((s,c) => s + Number(c.lateFees || 0), 0);
    feesTotal += sub;
    feesByProp.push({ p, items, sub });
  }
  feesByProp.sort((a,b) => b.sub - a.sub);

  // Vacant in year (warehouses we own/partner with that aren't generating)
  const vacantList = pool.filter(p =>
    p.status === 'vacant' && (p.ownership === 'own' || p.ownership === 'partnership')
  );

  // ── Management fee income (managed properties — full annual fee) ──
  const mgmtRows = pool
    .filter(p => p.ownership === 'management' && (p.mgmtFee||0) > 0)
    .map(p => {
      const months = _finActiveInYear(p, _finYear) ? _finMonthsActive(p, _finYear) : 0;
      const annual = Number(p.mgmtFee) || 0;
      return { p, months, annual, feeYr: annual };
    })
    .sort((a,b) => b.feeYr - a.feeYr);

  const mgmtTotal = mgmtRows.reduce((s,r)=>s+r.feeYr, 0);

  // ── Additional charges (maintenance + VAT) ──
  // Raw values exactly as entered on the property card. NOT scaled by
  // ownership share — these are property-level charges, not personal share.
  // VAT uses the explicit field if filled, else computes 5% of annual rent.
  // (Service charges moved to Deductions — see rentRows above.)
  const addRows = pool
    .filter(p => p.status === 'rented'
      && ((Number(p.maintenanceFees)||0) || (Number(p.annualRent)||0)))
    .map(p => {
      const months  = _finActiveInYear(p, _finYear) ? _finMonthsActive(p, _finYear) : 0;
      const vatBase = Number(p.vat) || (Number(p.annualRent)||0) * 0.05;
      const maint   = Math.round(Number(p.maintenanceFees) || 0);
      const vat     = Math.round(vatBase);
      return { p, months, maint, vat, sub: maint + vat };
    })
    .filter(r => r.sub > 0)
    .sort((a,b) => b.sub - a.sub);

  const maintTotalFin= addRows.reduce((s,r)=>s+r.maint,   0);
  const vatTotal     = addRows.reduce((s,r)=>s+r.vat,     0);
  const additionalTotal = maintTotalFin + vatTotal;

  const grandTotal = rentTotalOurs + mgmtTotal + additionalTotal + brokerTotal + feesTotal;
  const typeLabel  = _finType === 'all' ? 'Properties'
                   : _finType === 'warehouse' ? 'Warehouses'
                   : _finType === 'office' ? 'Offices' : 'Residential';

  body.innerHTML = `
    <!-- ── KPI ROW ──────────────────────────────── -->
    <div class="fin-kpis">
      <div class="fin-kpi fin-kpi-primary">
        <div class="fin-kpi-label">Total Income (${_finYear})</div>
        <div class="fin-kpi-value">AED ${grandTotal.toLocaleString()}</div>
        <div class="fin-kpi-sub">Rental + Management fees</div>
      </div>
      <div class="fin-kpi">
        <div class="fin-kpi-label">Rental Income (Net)</div>
        <div class="fin-kpi-value">AED ${rentTotalOurs.toLocaleString()}</div>
        <div class="fin-kpi-sub">${rentRows.length} active rental${rentRows.length===1?'':'s'} · after deductions, our share</div>
      </div>
      ${deductionsTotal ? `
      <div class="fin-kpi">
        <div class="fin-kpi-label">Deductions</div>
        <div class="fin-kpi-value fin-kpi-warn">− AED ${deductionsTotal.toLocaleString()}</div>
        <div class="fin-kpi-sub">Land ${rentTotalLand.toLocaleString()} · License ${rentTotalLic.toLocaleString()} · Service ${rentTotalSvc.toLocaleString()} · DEWA ${rentTotalDewa.toLocaleString()} · Ejari ${rentTotalEjari.toLocaleString()} · CD ${rentTotalCD.toLocaleString()} · Legal ${rentTotalLegal.toLocaleString()} · Tax ${rentTotalCtax.toLocaleString()}</div>
      </div>` : ''}
      <div class="fin-kpi">
        <div class="fin-kpi-label">Management Fees</div>
        <div class="fin-kpi-value">AED ${mgmtTotal.toLocaleString()}</div>
        <div class="fin-kpi-sub">${mgmtRows.length} managed propert${mgmtRows.length===1?'y':'ies'}</div>
      </div>
      <div class="fin-kpi">
        <div class="fin-kpi-label">Maintenance + VAT</div>
        <div class="fin-kpi-value">AED ${additionalTotal.toLocaleString()}</div>
        <div class="fin-kpi-sub">Maint. ${maintTotalFin.toLocaleString()} · VAT ${vatTotal.toLocaleString()}</div>
      </div>
      <div class="fin-kpi">
        <div class="fin-kpi-label">Vacant ${typeLabel}</div>
        <div class="fin-kpi-value fin-kpi-warn">${vacantList.length}</div>
        <div class="fin-kpi-sub">Not generating rent</div>
      </div>
    </div>

    <!-- ── RENTAL INCOME TABLE ──────────────────── -->
    <div class="fin-section">
      <div class="fin-section-hdr">
        <div>
          <h2>Rental Income — ${typeLabel}</h2>
          <span class="fin-section-sub">Income generated per ${typeLabel.toLowerCase().replace(/s$/,'')} for ${_finYear}</span>
        </div>
        <div class="fin-section-total">
          <span class="fin-tot-label">Our Income</span>
          <span class="fin-tot-value">AED ${rentTotalOurs.toLocaleString()}</span>
        </div>
      </div>
      ${rentRows.length === 0 ? `
        <div class="fin-empty">
          <div class="fin-empty-icon">💰</div>
          <div class="fin-empty-title">No rental income for ${_finYear}</div>
          <div class="fin-empty-sub">No rented ${typeLabel.toLowerCase()} have active contracts in this year.</div>
        </div>
      ` : `
        <div class="fin-tbl-wrap">
          <table class="fin-tbl">
            <thead>
              <tr>
                <th style="width:34px">#</th>
                <th>Property</th>
                <th>Tenant</th>
                <th>Ownership</th>
                <th class="ta-r">Annual Rent</th>
                <th class="ta-r">Land Charges</th>
                <th class="ta-r">License Fees</th>
                <th class="ta-r">Service Charges</th>
                <th class="ta-r">Net Rent</th>
                <th class="ta-c">Our Share</th>
                <th class="ta-r">Our Income</th>
                <th>Contract Period</th>
              </tr>
            </thead>
            <tbody>
              ${rentRows.map((r,i)=>{
                const o = r.p.ownership;
                const ownChip = o === 'own'         ? `<span class="fin-chip fin-chip-own">100% Own</span>`
                              : o === 'partnership' ? `<span class="fin-chip fin-chip-part">Partnership</span>`
                              : o === 'management'  ? `<span class="fin-chip fin-chip-mgmt">Managed</span>`
                              : `<span class="fin-chip">—</span>`;
                return `
                <tr onclick="openDetailModal('${r.p.id}')" class="fin-row-click">
                  <td class="fin-num">${i+1}</td>
                  <td><strong>${h(r.p.name)}</strong></td>
                  <td>${h(r.p.tenantName||'—')}</td>
                  <td>${ownChip}</td>
                  <td class="ta-r">AED ${r.annual.toLocaleString()}</td>
                  <td class="ta-r" style="color:${r.land?'var(--danger)':'#9ca3af'};">${r.land?'− AED '+r.land.toLocaleString():'—'}</td>
                  <td class="ta-r" style="color:${r.lic?'var(--danger)':'#9ca3af'};">${r.lic?'− AED '+r.lic.toLocaleString():'—'}</td>
                  <td class="ta-r" style="color:${r.svc?'var(--danger)':'#9ca3af'};">${r.svc?'− AED '+r.svc.toLocaleString():'—'}</td>
                  <td class="ta-r"><strong>AED ${r.net.toLocaleString()}</strong></td>
                  <td class="ta-c">${r.sharePct}%</td>
                  <td class="ta-r fin-our">AED ${r.ourIncome.toLocaleString()}</td>
                  <td class="fin-period">${_finFmtPeriod(r.p)}</td>
                </tr>`;
              }).join('')}
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4" class="ta-r"><strong>TOTAL</strong></td>
                <td class="ta-r"><strong>AED ${rentTotalGross.toLocaleString()}</strong></td>
                <td class="ta-r" style="color:var(--danger);"><strong>${rentTotalLand?'− AED '+rentTotalLand.toLocaleString():'—'}</strong></td>
                <td class="ta-r" style="color:var(--danger);"><strong>${rentTotalLic?'− AED '+rentTotalLic.toLocaleString():'—'}</strong></td>
                <td class="ta-r" style="color:var(--danger);"><strong>${rentTotalSvc?'− AED '+rentTotalSvc.toLocaleString():'—'}</strong></td>
                <td class="ta-r"><strong>AED ${rentTotalNet.toLocaleString()}</strong></td>
                <td></td>
                <td class="ta-r fin-our"><strong>AED ${rentTotalOurs.toLocaleString()}</strong></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      `}
    </div>

    <!-- ── MANAGEMENT FEE INCOME ────────────────── -->
    <div class="fin-section">
      <div class="fin-section-hdr">
        <div>
          <h2>Management Fee Income</h2>
          <span class="fin-section-sub">Fees earned for managing ${typeLabel.toLowerCase()} owned by others — ${_finYear}</span>
        </div>
        <div class="fin-section-total">
          <span class="fin-tot-label">Total Fees</span>
          <span class="fin-tot-value">AED ${mgmtTotal.toLocaleString()}</span>
        </div>
      </div>
      ${mgmtRows.length === 0 ? `
        <div class="fin-empty">
          <div class="fin-empty-icon">📋</div>
          <div class="fin-empty-title">No management fees for ${_finYear}</div>
          <div class="fin-empty-sub">Add a managed property with a Management Fee value to see income here.</div>
        </div>
      ` : `
        <div class="fin-tbl-wrap">
          <table class="fin-tbl">
            <thead>
              <tr>
                <th style="width:34px">#</th>
                <th>Property</th>
                <th>Property Owner</th>
                <th>Tenant</th>
                <th class="ta-r">Annual Mgmt Fee</th>
                <th class="ta-c">Months Active</th>
                <th class="ta-r">Year Income</th>
                <th>Contract Period</th>
              </tr>
            </thead>
            <tbody>
              ${mgmtRows.map((r,i)=>`
                <tr onclick="openDetailModal('${r.p.id}')" class="fin-row-click">
                  <td class="fin-num">${i+1}</td>
                  <td><strong>${h(r.p.name)}</strong></td>
                  <td>${h(r.p.ownerName||'—')}</td>
                  <td>${h(r.p.tenantName||'—')}</td>
                  <td class="ta-r">AED ${r.annual.toLocaleString()}</td>
                  <td class="ta-c">${r.months}/12</td>
                  <td class="ta-r fin-our">AED ${r.feeYr.toLocaleString()}</td>
                  <td class="fin-period">${_finFmtPeriod(r.p)}</td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4" class="ta-r"><strong>TOTAL</strong></td>
                <td class="ta-r"><strong>AED ${mgmtRows.reduce((s,r)=>s+r.annual,0).toLocaleString()}</strong></td>
                <td></td>
                <td class="ta-r fin-our"><strong>AED ${mgmtTotal.toLocaleString()}</strong></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      `}
    </div>

    <!-- ── ADDITIONAL CHARGES TABLE ───────────────── -->
    ${addRows.length ? `
    <div class="fin-section">
      <div class="fin-section-hdr">
        <div>
          <h2>Maintenance &amp; VAT — ${typeLabel}</h2>
          <span class="fin-section-sub">Additional revenue beyond base rent — ${_finYear}</span>
        </div>
        <div class="fin-section-total">
          <span class="fin-tot-label">Total</span>
          <span class="fin-tot-value">AED ${additionalTotal.toLocaleString()}</span>
        </div>
      </div>
      <div class="fin-tbl-wrap">
        <table class="fin-tbl">
          <thead>
            <tr>
              <th style="width:34px">#</th>
              <th>Property</th>
              <th>Tenant</th>
              <th class="ta-c">Months</th>
              <th class="ta-r">Maintenance</th>
              <th class="ta-r">VAT (5%)</th>
              <th class="ta-r">Sub-total</th>
            </tr>
          </thead>
          <tbody>
            ${addRows.map((r,i)=>`
              <tr onclick="openDetailModal('${r.p.id}')" class="fin-row-click">
                <td class="fin-num">${i+1}</td>
                <td><strong>${h(r.p.name)}</strong></td>
                <td>${h(r.p.tenantName||'—')}</td>
                <td class="ta-c">${r.months}/12</td>
                <td class="ta-r">${r.maint ? 'AED '+num(r.maint) : '—'}</td>
                <td class="ta-r">${r.vat   ? 'AED '+num(r.vat)   : '—'}</td>
                <td class="ta-r fin-our"><strong>AED ${num(r.sub)}</strong></td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4" class="ta-r"><strong>TOTAL</strong></td>
              <td class="ta-r"><strong>AED ${num(maintTotalFin)}</strong></td>
              <td class="ta-r"><strong>AED ${num(vatTotal)}</strong></td>
              <td class="ta-r fin-our"><strong>AED ${num(additionalTotal)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>` : ''}

    <!-- ── BROKERAGE INCOME ─────────────────────── -->
    ${brokerRows.length ? `
    <div class="fin-section">
      <div class="fin-section-hdr">
        <div>
          <h2>Brokerage Income — ${typeLabel}</h2>
          <span class="fin-section-sub">One-off brokerage fees per property · adds to total income</span>
        </div>
        <div class="fin-section-total">
          <span class="fin-tot-label">Total</span>
          <span class="fin-tot-value">AED ${brokerTotal.toLocaleString()}</span>
        </div>
      </div>
      <div class="fin-tbl-wrap">
        <table class="fin-tbl">
          <thead><tr><th style="width:34px">#</th><th>Property</th><th class="ta-r">Brokerage</th></tr></thead>
          <tbody>
            ${brokerRows.map((r,i)=>`
              <tr onclick="openDetailModal('${r.p.id}')" class="fin-row-click">
                <td class="fin-num">${i+1}</td>
                <td><strong>${h(r.p.name)}</strong></td>
                <td class="ta-r fin-our"><strong>AED ${num(r.amount)}</strong></td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="2" class="ta-r"><strong>TOTAL</strong></td><td class="ta-r fin-our"><strong>AED ${num(brokerTotal)}</strong></td></tr></tfoot>
        </table>
      </div>
    </div>` : ''}

    <!-- ── LATE / BOUNCED CHEQUE FEES ───────────── -->
    ${feesByProp.length ? `
    <div class="fin-section">
      <div class="fin-section-hdr">
        <div>
          <h2>Late + Bounced Cheque Fees — ${typeLabel}</h2>
          <span class="fin-section-sub">Penalty fees charged on late submissions and bounced cheques · adds to total income</span>
        </div>
        <div class="fin-section-total">
          <span class="fin-tot-label">Total Fees</span>
          <span class="fin-tot-value">AED ${feesTotal.toLocaleString()}</span>
        </div>
      </div>
      <div class="fin-tbl-wrap">
        <table class="fin-tbl">
          <thead><tr><th style="width:34px">#</th><th>Property</th><th>Cheques (status · fee)</th><th class="ta-r">Sub-total</th></tr></thead>
          <tbody>
            ${feesByProp.map((g,i)=>`
              <tr onclick="openDetailModal('${g.p.id}')" class="fin-row-click">
                <td class="fin-num">${i+1}</td>
                <td><strong>${h(g.p.name)}</strong></td>
                <td>${g.items.map(c => `<span style="display:inline-block;margin:1px 6px 1px 0;padding:2px 6px;border-radius:4px;background:${c.status==='bounced'?'#fee2e2':'#fef3c7'};color:${c.status==='bounced'?'#991b1b':'#92400e'};font-size:11px;">${c.status==='bounced'?'❌ #'+(c.n||'?'):'⚠️ #'+(c.n||'?')} · AED ${num(c.lateFees)}</span>`).join('')}</td>
                <td class="ta-r fin-our"><strong>AED ${num(g.sub)}</strong></td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="3" class="ta-r"><strong>TOTAL</strong></td><td class="ta-r fin-our"><strong>AED ${num(feesTotal)}</strong></td></tr></tfoot>
        </table>
      </div>
    </div>` : ''}

    <!-- ── CASH RECEIPTS ─────────────────────────── -->
    ${cashRows.length ? `
    <div class="fin-section">
      <div class="fin-section-hdr">
        <div>
          <h2>Cash Receipts — ${typeLabel}</h2>
          <span class="fin-section-sub">Properties where rent was received in cash (not via cheques)</span>
        </div>
        <div class="fin-section-total">
          <span class="fin-tot-label">Total Cash</span>
          <span class="fin-tot-value">AED ${cashTotal.toLocaleString()}</span>
        </div>
      </div>
      <div class="fin-tbl-wrap">
        <table class="fin-tbl">
          <thead><tr><th style="width:34px">#</th><th>Property</th><th>Tenant</th><th class="ta-r">Cash Amount</th></tr></thead>
          <tbody>
            ${cashRows.map((r,i)=>`
              <tr onclick="openDetailModal('${r.p.id}')" class="fin-row-click">
                <td class="fin-num">${i+1}</td>
                <td><strong>${h(r.p.name)}</strong></td>
                <td>${h(r.p.tenantName||'—')}</td>
                <td class="ta-r"><strong>💵 AED ${num(r.amount)}</strong></td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="3" class="ta-r"><strong>TOTAL</strong></td><td class="ta-r"><strong>AED ${num(cashTotal)}</strong></td></tr></tfoot>
        </table>
      </div>
    </div>` : ''}

    <!-- ── SECURITY DEPOSITS ────────────────────── -->
    ${depRows.length ? `
    <div class="fin-section">
      <div class="fin-section-hdr">
        <div>
          <h2>Security Deposits Held — ${typeLabel}</h2>
          <span class="fin-section-sub">Informational · refundable amounts held against tenancies</span>
        </div>
        <div class="fin-section-total">
          <span class="fin-tot-label">Total Held</span>
          <span class="fin-tot-value">AED ${depTotal.toLocaleString()}</span>
        </div>
      </div>
      <div class="fin-tbl-wrap">
        <table class="fin-tbl">
          <thead><tr><th style="width:34px">#</th><th>Property</th><th>Tenant</th><th class="ta-r">Security Deposit</th></tr></thead>
          <tbody>
            ${depRows.map((r,i)=>`
              <tr onclick="openDetailModal('${r.p.id}')" class="fin-row-click">
                <td class="fin-num">${i+1}</td>
                <td><strong>${h(r.p.name)}</strong></td>
                <td>${h(r.p.tenantName||'—')}</td>
                <td class="ta-r"><strong>AED ${num(r.amount)}</strong></td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3" class="ta-r"><strong>TOTAL</strong></td>
              <td class="ta-r"><strong>AED ${num(depTotal)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>` : ''}

    <!-- ── COMBINED TOTAL ───────────────────────── -->
    <div class="fin-grand">
      <div class="fin-grand-row">
        <span>Rental Income (Our Share, Net of deductions)</span>
        <span>AED ${rentTotalOurs.toLocaleString()}</span>
      </div>
      ${deductionsTotal ? `
      <div class="fin-grand-row" style="color:var(--danger);font-weight:500;">
        <span>&nbsp;&nbsp;↳ Deductions applied (Land + License + Service + DEWA + Ejari + Civil Defense + Legal + Corporate Tax)</span>
        <span>− AED ${deductionsTotal.toLocaleString()}</span>
      </div>` : ''}
      <div class="fin-grand-row">
        <span>Management Fee Income</span>
        <span>AED ${mgmtTotal.toLocaleString()}</span>
      </div>
      ${additionalTotal ? `
      <div class="fin-grand-row">
        <span>Maintenance + VAT</span>
        <span>AED ${additionalTotal.toLocaleString()}</span>
      </div>` : ''}
      ${brokerTotal ? `
      <div class="fin-grand-row" style="color:#059669;">
        <span>Brokerage Income</span>
        <span>+ AED ${brokerTotal.toLocaleString()}</span>
      </div>` : ''}
      ${feesTotal ? `
      <div class="fin-grand-row" style="color:#059669;">
        <span>Late + Bounced Cheque Fees</span>
        <span>+ AED ${feesTotal.toLocaleString()}</span>
      </div>` : ''}
      <div class="fin-grand-row fin-grand-total">
        <span>TOTAL INCOME — ${_finYear}</span>
        <span>AED ${grandTotal.toLocaleString()}</span>
      </div>
    </div>
  `;
}

function _finFmtPeriod(p) {
  const s = p.contractFrom || p.leaseStart;
  const e = p.contractTo   || p.leaseEnd;
  if (!s && !e) return '—';
  const fmt = d => d ? new Date(d).toLocaleDateString('en-GB',{month:'short',year:'2-digit'}) : '—';
  return `${fmt(s)} → ${fmt(e)}`;
}

// ── Boot update for agent ──────────────────────────
// NOTE: This monkey-patch overrides the original boot() at line 322.
// Any boot-time additions (like fetchProperties) MUST be repeated here.
const _origBoot = boot;
boot = async function() {
  const session = getSession();
  if (!session) { location.reload(); return; }
  if (session.type === 'admin') {
    document.getElementById('adminHeader').style.display    = '';
    document.getElementById('appBody').style.display        = '';
    document.getElementById('agentHeader').style.display    = 'none';
    document.getElementById('agentDashboard').style.display = 'none';
    // Switch to home BEFORE awaiting the network so the user doesn't
    // see a flash of the default (warehouses) tab while data loads.
    showTab('home');
    await openIDB();
    await fetchProperties();           // hydrate cache from backend before render
    await fetchAllEntities();          // hydrate every other entity (leads, tasks, leaves, etc.)
    bindUI();
    autoImportPropertiesFromExcel();   // one-time cleanup of legacy import
    xlsyncBoot();                      // resume Excel auto-sync if previously connected
    showTab('home');                   // re-render now that data is loaded
    _refreshTaskSnapshot();            // baseline so first SSE doesn't toast everything
    updateMyTasksBadge();
    renderNotifBadge();                // restore unread count from sessionStorage
    renderNavCounts(loadProps());
    setInterval(() => renderAlerts(loadProps()), 60000);
    renderAlerts(loadProps());
    updateApiStatusUI();
    setupMetaAutoSync();
    startRealtimeSync();
  } else if (session.type === 'agent') {
    document.getElementById('adminHeader').style.display    = 'none';
    document.getElementById('appBody').style.display        = 'none';
    document.getElementById('agentHeader').style.display    = 'none'; // sidebar has profile
    document.getElementById('agentDashboard').style.display = '';
    await fetchProperties();           // agents also need property cache
    await fetchAllEntities();          // and every other entity
    showAgentTab('overview');
    updateAgentBadges();
    startRealtimeSync();
  }
};

// ─── Real-time sync via Server-Sent Events ────────────────
// One EventSource per browser. The backend pushes a small JSON payload
// after every mutation; we refetch the affected entity cache and re-
// render the active tab. EventSource auto-reconnects on transient errors.
let _sse = null;
let _sseRebroadcastTimer = null;
function startRealtimeSync() {
  if (_sse) { try { _sse.close(); } catch(_) {} }
  try {
    _sse = new EventSource('/api/events');
  } catch (e) {
    console.warn('[sse] EventSource not supported:', e);
    return;
  }
  _sse.onopen   = ()  => console.log('[sse] connected');
  _sse.onerror  = (e) => console.warn('[sse] error (auto-reconnect)', e);
  _sse.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); }
    catch (_) { return; }
    if (!evt || !evt.entity) return;
    handleRealtimeEvent(evt);
  };
}

// ─── Smoothing layer ──────────────────────────────────────
// Three problems we fix here:
//   1. Self-broadcast flicker: after the user saves, the server SSE
//      arrives and triggers a redundant re-render. We mute SSE for a
//      short window after any local mutation.
//   2. Modal stomp: an SSE event re-rendering the underlying tab
//      while a modal is open feels jarring. Defer the refresh until
//      the modal closes, and apply only the cache update silently.
//   3. Scroll jump: re-render resets scroll. Save + restore.
let _sseMutedUntil      = 0;
let _sseDeferredEntities = new Set();

function markLocalMutation() { _sseMutedUntil = Date.now() + 1200; }

function _isAnyModalOpen() {
  return !!document.querySelector('.modal-overlay.active');
}

async function handleRealtimeEvent(evt) {
  const entity = evt.entity;
  console.log('[sse] event arrived:', evt, 'mutedUntil=', _sseMutedUntil, 'now=', Date.now(), 'modalOpen=', _isAnyModalOpen());
  // Suppress refresh during/right-after a local save — the save handler
  // already updated the cache + re-rendered.
  if (Date.now() < _sseMutedUntil) {
    console.log('[sse] muted — refreshing cache silently');
    _refreshCacheSilently(entity);
    return;
  }
  // If any modal is open, queue the entity and refresh on close.
  if (_isAnyModalOpen()) {
    console.log('[sse] modal open — deferring');
    _sseDeferredEntities.add(entity);
    _refreshCacheSilently(entity);
    return;
  }
  clearTimeout(_sseRebroadcastTimer);
  _sseRebroadcastTimer = setTimeout(() => _applySseRefresh(entity), 150);
}

async function _applySseRefresh(entity) {
  // Save the user's scroll position so we can restore it after re-render.
  const scrollY = window.scrollY;
  try {
    if (entity === 'properties' || entity === 'cheques' || entity === 'propertyFiles') {
      await fetchProperties();
      rerenderActiveTab();
      renderNavCounts(loadProps());
      renderAlerts(loadProps());
    } else if (_api[entity] && typeof _api[entity].fetch === 'function') {
      await _api[entity].fetch();
      rerenderActiveTab();
    }
    if (entity === 'tasks') {
      checkTaskNotifications();
      updateMyTasksBadge();
    }
  } catch (e) {
    console.warn('[sse] refresh failed', e);
  }
  // Restore scroll on the next frame so layout has settled.
  requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'instant' }));
}

// Refresh just the cache (no re-render). Used when we don't want to
// disturb the visible UI but need fresh data for the next interaction.
async function _refreshCacheSilently(entity) {
  try {
    if (entity === 'properties' || entity === 'cheques' || entity === 'propertyFiles') {
      await fetchProperties();
    } else if (_api[entity] && typeof _api[entity].fetch === 'function') {
      await _api[entity].fetch();
    }
    // For tasks: also re-baseline the snapshot so the user doesn't
    // get notified of their own reply once the mute window ends.
    if (entity === 'tasks') {
      _refreshTaskSnapshot();
      updateMyTasksBadge();
    }
  } catch (_) { /* ignore */ }
}

// Hook called by closeDetailModal / closeAddModal. Flushes any deferred
// refreshes once the user closes the modal.
function flushDeferredSseRefreshes() {
  if (_isAnyModalOpen()) return;          // another modal still open
  if (!_sseDeferredEntities.size) return;
  const entities = Array.from(_sseDeferredEntities);
  _sseDeferredEntities.clear();
  // Pick the most "global" entity to refresh — properties wins
  if (entities.includes('properties') || entities.includes('cheques') || entities.includes('propertyFiles')) {
    _applySseRefresh('properties');
  } else {
    for (const e of entities) _applySseRefresh(e);
  }
}

// Re-render the currently visible tab without changing it.
function rerenderActiveTab() {
  try {
    if (typeof activeTab === 'string' && typeof showTab === 'function') {
      showTab(activeTab);
    }
  } catch (e) { /* ignore */ }
}

// ─── Task Notes via backend API ──────────────────────────
// Replaces the legacy localStorage-style task.notes JSON array. Notes
// now live in the task_notes table on the server.
async function apiListTaskNotes(taskId) {
  try {
    const r = await fetch(`/api/tasks/${taskId}/notes`, { credentials: 'same-origin' });
    if (!r.ok) return [];
    const d = await r.json();
    return d.notes || [];
  } catch (e) { console.warn('[tasks] notes fetch failed', e); return []; }
}

async function apiPostTaskNote(taskId, text) {
  const r = await fetch(`/api/tasks/${taskId}/notes`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || 'HTTP ' + r.status);
  }
  return (await r.json()).note;
}

// Override: load notes from API on open (instead of from task.notes JSON)
const _origOpenTaskNotesV2 = openTaskNotes;
openTaskNotes = async function(taskId) {
  _origOpenTaskNotesV2(taskId);                  // existing UI bootstrap
  try {
    const notes = await apiListTaskNotes(taskId);
    renderNotesList(notes);
  } catch (_) {}
};

// Override: post via API
submitTaskNote = async function() {
  const input = document.getElementById('taskNoteInput');
  const text = (input?.value || '').trim();
  if (!text) return;
  if (!notesTaskId) return;
  if (typeof markLocalMutation === 'function') markLocalMutation();
  try {
    await apiPostTaskNote(notesTaskId, text);
    input.value = '';
    const notes = await apiListTaskNotes(notesTaskId);
    renderNotesList(notes);
    showToast('Update posted', 'success');
  } catch (e) {
    showToast('Post failed: ' + e.message, 'error');
  }
};

// ─── Unread-task tracking (per-tab sessionStorage) ───────
// A simple Set of task IDs that have new replies you haven't opened
// yet. Used to render a red dot beside the task title.
const UNREAD_TASKS_KEY = 'asg_unread_tasks';
function _loadUnreadTasks() {
  try { return new Set(JSON.parse(sessionStorage.getItem(UNREAD_TASKS_KEY)) || []); }
  catch { return new Set(); }
}
function _saveUnreadTasks(set) {
  try { sessionStorage.setItem(UNREAD_TASKS_KEY, JSON.stringify([...set])); } catch (_) {}
}
function markTaskUnread(taskId) {
  const set = _loadUnreadTasks(); set.add(String(taskId)); _saveUnreadTasks(set);
}
function markTaskRead(taskId) {
  const set = _loadUnreadTasks();
  if (set.delete(String(taskId))) {
    _saveUnreadTasks(set);
    // Re-render any visible tab that paints unread dots
    if (typeof activeTab === 'string' && (activeTab === 'mytasks' || activeTab === 'team')) {
      rerenderActiveTab();
    }
  }
}
function isTaskUnread(taskId) { return _loadUnreadTasks().has(String(taskId)); }

// Mark task read when its notes modal opens
const _origOpenTaskNotesV3 = openTaskNotes;
openTaskNotes = async function(taskId) {
  markTaskRead(taskId);
  return _origOpenTaskNotesV3(taskId);
};

// ─── My Tasks tab — split into Assigned-to-me + Tasks-I've-given ───
function renderMyTasks() {
  const session = getSession();
  if (!session) return;
  const myId = String(session.userId || session.agentId || '');
  const allTasks = loadTasks();
  const props = loadProps();
  const sortFn = (a, b) => {
    const ord = { 'in-progress': 0, pending: 1, done: 2, cancelled: 3 };
    return (ord[a.status] || 9) - (ord[b.status] || 9);
  };
  const assignedToMe = allTasks.filter(t => String(t.agentId) === myId).sort(sortFn);
  const givenByMe    = allTasks.filter(t => String(t.createdById) === myId
                                         && String(t.agentId) !== myId).sort(sortFn);
  const container = document.getElementById('myTasksList');
  if (!container) return;
  container.innerHTML = `
    <div class="mytasks-section">
      <h2 class="mytasks-h">📥 Assigned to Me <span class="mytasks-count">${assignedToMe.length}</span></h2>
      ${assignedToMe.length ? assignedToMe.map(t => renderTaskCardForUser(t, props, 'received')).join('') : `<div class="mytasks-empty">No tasks assigned to you yet.</div>`}
    </div>
    <div class="mytasks-section" style="margin-top:24px;">
      <h2 class="mytasks-h">📤 Tasks I've Given <span class="mytasks-count">${givenByMe.length}</span></h2>
      ${givenByMe.length ? givenByMe.map(t => renderTaskCardForUser(t, props, 'given')).join('') : `<div class="mytasks-empty">You haven't assigned any tasks yet. Open the Team tab to assign one.</div>`}
    </div>
  `;
}

function renderTaskCardForUser(t, props, mode) {
  const prop      = t.propId ? props.find(p => String(p.id) === String(t.propId)) : null;
  const tm        = (typeof TASK_TYPE_META    !== 'undefined' && TASK_TYPE_META[t.type])     || { icon: '📌', label: t.type || 'Task' };
  const sm        = (typeof TASK_STATUS_META  !== 'undefined' && TASK_STATUS_META[t.status]) || { cls: 'ts-pending', label: t.status || 'pending' };
  const pm        = (typeof PRIORITY_META     !== 'undefined' && PRIORITY_META[t.priority])  || { cls: 'pri-medium', label: t.priority || 'medium' };
  const overdue   = t.deadline && t.status !== 'done' && t.status !== 'cancelled' && new Date(t.deadline) < new Date();
  const noteCount = t.notesCount != null ? t.notesCount : (Array.isArray(t.notes) ? t.notes.length : 0);
  const unread    = isTaskUnread(t.id);
  const counterParty = mode === 'received'
    ? (t.createdByName ? `Assigned by ${h(t.createdByName)}` : '')
    : (() => {
        const u = loadTaskAssignees().find(a => String(a.id) === String(t.agentId));
        return u ? `Assigned to ${h(u.name)}${u.role === 'admin' ? ' (Admin)' : ''}` : '';
      })();
  // For "received" mode the user can change status; for "given" they can't.
  const statusControl = mode === 'received' ? `
    <select class="task-status-select" onchange="updateTaskStatus('${t.id}', this.value)">
      <option value="pending"${t.status === 'pending' ? ' selected' : ''}>Pending</option>
      <option value="in-progress"${t.status === 'in-progress' ? ' selected' : ''}>In Progress</option>
      <option value="done"${t.status === 'done' ? ' selected' : ''}>Done</option>
      <option value="cancelled"${t.status === 'cancelled' ? ' selected' : ''}>Cancelled</option>
    </select>` : '';
  return `
    <div class="task-card${t.status === 'done' ? ' task-done' : ''}${overdue ? ' task-overdue' : ''}" style="margin-bottom:12px;">
      <div class="task-card-top">
        <div class="task-type-badge">${tm.icon} ${tm.label}</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="task-priority ${pm.cls}">${pm.label}</span>
          <span class="task-status-badge ${sm.cls}">${sm.label}</span>
        </div>
      </div>
      <div class="task-card-title">${unread ? '<span class="unread-dot" title="Unread reply"></span>' : ''}${h(t.title)}</div>
      ${prop ? `<div class="task-card-prop">🏗️ ${h(prop.name)}${prop.location ? ' · ' + h(prop.location) : ''}</div>` : ''}
      ${t.description ? `<div class="task-card-desc">${h(t.description)}</div>` : ''}
      ${counterParty ? `<div style="font-size:12px;color:var(--text-3);margin-top:6px;">${counterParty}</div>` : ''}
      <div class="task-card-meta">
        ${t.deadline ? `<span class="${overdue ? 'task-overdue-tag' : 'task-deadline'}">📅 ${overdue ? 'Overdue — ' : ''}${t.deadline}</span>` : ''}
        <span class="task-note-count">💬 ${noteCount} update${noteCount === 1 ? '' : 's'}</span>
      </div>
      <div class="task-card-actions">
        <button class="btn-sm btn-primary" onclick="openTaskNotes('${t.id}')">💬 ${unread ? 'New reply — Open' : 'Reply'}</button>
        ${statusControl}
      </div>
    </div>`;
}

// Update sidebar nav badge for "My Tasks" with count of pending+in-progress
function updateMyTasksBadge() {
  const session = getSession();
  if (!session) return;
  const myId = String(session.userId || session.agentId || '');
  const count = loadTasks().filter(t => String(t.agentId) === myId
                                     && (t.status === 'pending' || t.status === 'in-progress')).length;
  const el = document.getElementById('navCountMyTasks');
  if (el) el.textContent = count > 0 ? count : '';
}

// ─── Notification toasts on SSE task events ──────────────
// Keeps a snapshot of tasks (id → {agentId, notesCount}) and diffs on
// each SSE refresh. New task assigned to me → toast. Notes count went
// up on a task I created or am assigned to → toast.
let _taskSnapshot = new Map();
function _refreshTaskSnapshot() {
  _taskSnapshot = new Map(loadTasks().map(t => [
    String(t.id),
    { agentId: String(t.agentId || ''), notesCount: t.notesCount || 0, createdById: String(t.createdById || ''), title: t.title }
  ]));
}
function checkTaskNotifications() {
  const session = getSession();
  if (!session) return;
  const myId = String(session.userId || session.agentId || '');
  const cur = loadTasks();
  for (const t of cur) {
    const id = String(t.id);
    const prev = _taskSnapshot.get(id);
    const taskAgent   = String(t.agentId || '');
    const taskCreator = String(t.createdById || '');
    const noteCount   = t.notesCount || 0;
    if (!prev) {
      if (taskAgent === myId && taskCreator !== myId) {
        addNotification({ icon: '📋', text: `New task assigned: ${t.title}`, taskId: id });
      }
    } else {
      if (noteCount > prev.notesCount) {
        const involved = taskAgent === myId || taskCreator === myId;
        if (involved) {
          addNotification({ icon: '💬', text: `New reply on: ${t.title}`, taskId: id });
          markTaskUnread(id);
        }
      }
    }
  }
  _refreshTaskSnapshot();
}

// ─── Notification center ─────────────────────────────────
// Notifications are kept in sessionStorage (per-tab, per-login) and
// rendered into a dropdown anchored to the bell icon in the header.
// Adding a notification also fires a brief toast.
const NOTIF_KEY = 'asg_notifs';
function _loadNotifs() {
  try { return JSON.parse(sessionStorage.getItem(NOTIF_KEY)) || []; }
  catch { return []; }
}
function _saveNotifs(arr) {
  try { sessionStorage.setItem(NOTIF_KEY, JSON.stringify(arr.slice(0, 50))); } catch (_) {}
}
function addNotification({ icon, text, taskId }) {
  const list = _loadNotifs();
  list.unshift({ id: 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                 icon: icon || '🔔', text, taskId, ts: Date.now(), read: false });
  _saveNotifs(list);
  renderNotifBadge();
  if (typeof showToast === 'function') showToast(`${icon || '🔔'} ${text}`, 'info');
  // If the panel is open, refresh its contents
  const panel = document.getElementById('notifPanel');
  if (panel && panel.style.display !== 'none') renderNotifPanel();
}
function clearNotifications() {
  _saveNotifs([]);
  renderNotifBadge();
  renderNotifPanel();
}
function markNotifsRead() {
  const list = _loadNotifs();
  for (const n of list) n.read = true;
  _saveNotifs(list);
  renderNotifBadge();
}
function renderNotifBadge() {
  const list = _loadNotifs();
  const unread = list.filter(n => !n.read).length;
  const el = document.getElementById('notifCount');
  if (!el) return;
  if (unread > 0) {
    el.textContent = unread > 99 ? '99+' : String(unread);
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}
function renderNotifPanel() {
  const list = _loadNotifs();
  const body = document.getElementById('notifList');
  if (!body) return;
  if (!list.length) {
    body.innerHTML = '<div class="notif-empty">No notifications yet.<br>You\'ll see new tasks and replies here.</div>';
    return;
  }
  body.innerHTML = list.map(n => `
    <div class="notif-item${n.read ? '' : ' notif-unread'}" onclick="onNotifClick('${n.id}', ${n.taskId ? `'${n.taskId}'` : 'null'})">
      <div class="notif-icon">${n.icon || '🔔'}</div>
      <div class="notif-body">
        <div class="notif-title">${h(n.text)}</div>
        <div class="notif-time">${formatNotifTime(n.ts)}</div>
      </div>
    </div>
  `).join('');
}
function formatNotifTime(ts) {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000)        return 'just now';
  if (diff < 3_600_000)     return Math.floor(diff / 60_000) + ' min ago';
  if (diff < 86_400_000)    return Math.floor(diff / 3_600_000) + 'h ago';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? '' : 'none';
  if (opening) {
    renderNotifPanel();
    markNotifsRead();
  }
}
function onNotifClick(notifId, taskId) {
  // Mark this one read
  const list = _loadNotifs();
  const item = list.find(n => n.id === notifId);
  if (item) { item.read = true; _saveNotifs(list); renderNotifBadge(); }
  // Navigate to the relevant tab
  if (taskId && taskId !== 'null') {
    document.getElementById('notifPanel').style.display = 'none';
    if (typeof showTab === 'function') showTab('mytasks');
  }
}
// Click outside the bell/panel closes the panel
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notifPanel');
  const btn   = document.getElementById('notifBtn');
  if (!panel || panel.style.display === 'none') return;
  if (panel.contains(e.target) || btn.contains(e.target)) return;
  panel.style.display = 'none';
});

// ═══════════════════════════════════════════════════════
//  TEAM MODULE EXPANSION
//  - Performance metrics + leaderboard
//  - Activity timeline
//  - Schedule / availability
//  - Internal announcements
//  - Agent property view = admin view (minus rent/financial)
//  - Two-way updates module with author labels
// ═══════════════════════════════════════════════════════

// ─── Storage ──────────────────────────────────────────
const ANNOUNCEMENTS_KEY = 'asg_announcements';
const LEAVES_KEY        = 'asg_leaves';

function loadAnnouncements()  { return _api.announcements.load(); }
function saveAnnouncements(a) { _api.announcements.save(a); }
function loadLeaves()         { return _api.leaves.load(); }
function saveLeaves(l)        { _api.leaves.save(l); }

const AVAILABILITY_META = {
  available:  { icon:'🟢', label:'Available',     cls:'av-available' },
  in_meeting: { icon:'🟡', label:'In Meeting',    cls:'av-meeting'   },
  at_viewing: { icon:'🏗️', label:'At Viewing',    cls:'av-viewing'   },
  off_duty:   { icon:'⚪', label:'Off Duty',      cls:'av-off'       },
  on_leave:   { icon:'🌴', label:'On Leave',      cls:'av-leave'     }
};
function availMeta(v) { return AVAILABILITY_META[v] || AVAILABILITY_META.available; }

// ─── One-time data migration ─────────────────────────
(function migrateTeamData() {
  // Ensure every agent has an availability field
  const agents = loadAgents();
  let changed = false;
  agents.forEach(a => { if (!a.availability) { a.availability = 'available'; changed = true; } });
  if (changed) saveAgents(agents);

  // Ensure existing task notes have author info (legacy notes default to admin)
  const tasks = loadTasks();
  let tChanged = false;
  tasks.forEach(t => {
    if (!t.notes) return;
    t.notes.forEach(n => {
      if (!n.authorType) {
        n.authorType = 'admin';
        n.authorName = 'Admin';
        n.authorId   = '';
        tChanged = true;
      }
    });
  });
  if (tChanged) saveTasks(tasks);
})();

// ─── Helpers ─────────────────────────────────────────
function isAdminUser() { const s = getSession(); return s && s.type === 'admin'; }
function getAuthorMeta() {
  const s = getSession();
  if (!s) return { type:'admin', id:'', name:'Admin' };
  if (s.type === 'admin') return { type:'admin', id:'', name:'Admin' };
  return { type:'agent', id: s.agentId, name: s.name };
}
function startOfMonth(d) { const x = new Date(d); x.setDate(1); x.setHours(0,0,0,0); return x; }
function inPeriod(iso, period) {
  if (!iso) return false;
  if (period === 'all') return true;
  const t = new Date(iso); if (isNaN(t)) return false;
  if (period === 'month') return t >= startOfMonth(new Date());
  return true;
}

// ═══════════════════════════════════════════════════════
//  AGENT PROPERTY VIEW — admin layout, rent stripped
// ═══════════════════════════════════════════════════════

function agentCardHTML(p) {
  const typeIcon = p.type === 'warehouse' ? '🏭' : p.type === 'office' ? '🏢' : p.type === 'residential' ? '🏠' : '🏗️';
  const today    = new Date();
  const reminderThreshold = Number(p.reminderDays) || 60;
  let leaseBadge = '';
  if (p.status === 'rented' && p.leaseEnd) {
    const days = Math.ceil((new Date(p.leaseEnd) - today) / 86400000);
    if      (days < 0)                    leaseBadge = `<span class="lease-badge lease-expired">Expired</span>`;
    else if (days <= reminderThreshold)   leaseBadge = `<span class="lease-badge lease-warning">${days}d left</span>`;
    else                                  leaseBadge = `<span class="lease-badge lease-ok">${days}d left</span>`;
  }
  const mapChip = p.mapLink
    ? `<span class="chip chip-map" onclick="event.stopPropagation();window.open('${p.mapLink}','_blank')">🗺 Map</span>`
    : '';
  const mediaStrip = p.media?.length
    ? `<div class="card-media-strip count-${Math.min(p.media.length, 3)}" id="strip-${p.id}">
        ${p.media.slice(0, 3).map((m, i) =>
          isVideo(m.mime)
            ? `<video id="strip-${p.id}-${i}" muted></video>`
            : `<img id="strip-${p.id}-${i}" alt="">`
        ).join('')}
        ${p.media.length > 3 ? `<div class="card-media-more">+${p.media.length - 3}</div>` : ''}
      </div>`
    : '';
  const sess = getSession() || {};
  const perms = sess.perms || {};
  const showTenant = perms.viewTenant !== false;
  const tenantSection = (p.status === 'rented' && p.tenantName && showTenant) ? `
    <hr class="card-divider">
    <div class="card-tenant">
      <div class="tenant-left">
        <div class="tenant-avatar">${p.tenantName.charAt(0).toUpperCase()}</div>
        <div>
          <div class="tenant-name">${h(p.tenantName)}</div>
          <div class="tenant-dates">${fmtDate(p.leaseStart)} → ${fmtDate(p.leaseEnd)}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${leaseBadge}
      </div>
    </div>` : '';
  const vacantBanner = p.status === 'vacant'
    ? `<div style="padding:6px 10px;background:var(--danger-bg);border-radius:6px;font-size:12px;font-weight:600;color:var(--danger);text-align:center;">🔓 Vacant — Available</div>`
    : '';
  return `
    <div class="property-card${p.status === 'vacant' ? ' card-vacant' : ''}" onclick="openDetailModal('${p.id}')">
      <div class="card-header">
        <div class="card-header-top">
          <div>
            <div class="card-type-pill pill-${p.type}">${typeIcon} ${p.type}</div>
            <div class="card-title">${h(p.name)}</div>
            ${p.location ? `<div class="card-location">📍 ${h(p.location)}</div>` : ''}
          </div>
          ${p.status ? `<span class="card-status-badge status-${p.status}">${p.status}</span>` : ''}
        </div>
      </div>
      ${mediaStrip}
      <div class="card-body">
        <div class="card-kpis card-kpis-agent">
          <div class="kpi"><span class="kpi-label">Size</span><span class="kpi-value">${p.size ? num(p.size)+' sq ft' : '—'}</span></div>
          <div class="kpi"><span class="kpi-label">Type</span><span class="kpi-value" style="text-transform:capitalize;">${p.type || '—'}</span></div>
          <div class="kpi"><span class="kpi-label">Status</span><span class="kpi-value" style="text-transform:capitalize;">${p.status || '—'}</span></div>
          <div class="kpi"><span class="kpi-label">Photos</span><span class="kpi-value">${(p.media?.length || 0)} file${(p.media?.length||0)===1?'':'s'}</span></div>
        </div>
        <div class="card-chips">
          ${mapChip}
          ${p.compound  === 'yes' ? `<span class="chip">🏠 Compound</span>` : ''}
          ${p.mezzanine === 'yes' ? `<span class="chip">🏗️ Mezzanine</span>` : ''}
          ${p.usage ? `<span class="chip">${h(_fmtUsage ? _fmtUsage(p.usage) : p.usage)}</span>` : ''}
        </div>
        ${vacantBanner}
        ${tenantSection}
      </div>
    </div>`;
}

// Override openDetailModal so agents see admin layout, but with rent/financial stripped
const _origOpenDetailModal = openDetailModal;
openDetailModal = async function(id) {
  // Admin path unchanged
  if (!isAgentUser()) return _origOpenDetailModal(id);
  // Agent path: delegate then strip
  await _origOpenDetailModal(id);
  applyAgentDetailMode();
};

function applyAgentDetailMode() {
  const body = document.getElementById('detailBody');
  if (!body) return;
  body.classList.add('detail-agent-mode');

  // Remove the Financial Details block by header text match
  body.querySelectorAll('.detail-block').forEach(blk => {
    const head = blk.querySelector('.detail-block-header');
    if (!head) return;
    const txt = head.textContent || '';
    if (txt.includes('Financial Details')) blk.remove();
    if (txt.includes('Cheque Schedule')) blk.remove();
    if (txt.includes('Vacant Property')) {
      // keep block but strip rent rows
      blk.querySelectorAll('.detail-row').forEach(row => {
        const lab = row.querySelector('.dr-label');
        if (!lab) return;
        const t = lab.textContent || '';
        if (t.includes('Asking Rent') || t.includes('Per Month')) row.remove();
      });
      // if block now empty, drop it
      if (!blk.querySelector('.detail-row')) blk.remove();
    }
  });

  // Within Tenant Information block: drop monthly rent row
  body.querySelectorAll('.detail-row').forEach(row => {
    const lab = row.querySelector('.dr-label');
    if (!lab) return;
    const t = (lab.textContent || '').trim();
    if (t === 'Monthly Rent' || t === 'Annual Rent' || t === 'Asking Rent' ||
        t === 'Purchase Price' || t === 'Market Value' || t === 'Rental Yield' ||
        t === 'Management Fee' || t === 'Purchase Date' || t === 'Agreement Date' ||
        t === 'Our Share' || t === 'Partner') {
      row.remove();
    }
  });

  // Hide admin-only footer buttons; keep Close visible
  const delBtn  = document.getElementById('deletePropertyBtn');
  const editBtn = document.getElementById('editFromDetailBtn');
  if (delBtn)  delBtn.style.display  = 'none';
  if (editBtn) editBtn.style.display = 'none';
}

// When admin reopens, ensure the buttons return
const _origCloseDetail = (typeof closeDetailModal === 'function') ? closeDetailModal : null;
function _restoreDetailFooter() {
  const delBtn  = document.getElementById('deletePropertyBtn');
  const editBtn = document.getElementById('editFromDetailBtn');
  if (delBtn)  delBtn.style.display  = '';
  if (editBtn) editBtn.style.display = '';
  const body = document.getElementById('detailBody');
  if (body) body.classList.remove('detail-agent-mode');
}
if (_origCloseDetail) {
  closeDetailModal = function() {
    _restoreDetailFooter();
    return _origCloseDetail();
  };
}

// Replace agent inventory rendering with admin-style cards
const _origRenderAgentInventory = renderAgentInventory;
renderAgentInventory = function() {
  const allProps = loadProps();
  const sess = getSession();
  if (!sess || sess.type !== 'agent') return;
  const list = document.getElementById('agentInventoryList');
  if (!list) return;

  const role = sess.role || 'general';
  const meta = agentRoleMeta(role);
  const props = allProps.filter(meta.inventoryFilter || (() => true));

  // Re-use original intro banner by calling original (which writes intro+empty too) only when empty
  if (!allProps.length) {
    list.innerHTML = `<div class="team-empty"><div class="empty-icon">🏗️</div><p>No properties in the portfolio yet.</p></div>`;
    return;
  }
  if (!props.length) {
    return _origRenderAgentInventory();
  }

  // Build intro
  let intro = '';
  if (role === 'sales') {
    intro = `<div class="agent-inv-intro agent-inv-intro-sales">
      <div class="aii-icon">🏷️</div>
      <div>
        <div class="aii-title">Sales Inventory · ${props.length} vacant ${props.length === 1 ? 'property' : 'properties'}</div>
        <div class="aii-sub">Browse properties available to lease or sell. Click a card to view full details, photos, and documents.</div>
      </div>
    </div>`;
  } else if (role === 'leasing') {
    intro = `<div class="agent-inv-intro agent-inv-intro-leasing">
      <div class="aii-icon">📋</div>
      <div>
        <div class="aii-title">Active Leases · ${props.length} rented</div>
        <div class="aii-sub">Click any property to see full details, photos, and documents.</div>
      </div>
    </div>`;
  } else if (role === 'property_management') {
    intro = `<div class="agent-inv-intro agent-inv-intro-pm">
      <div class="aii-icon">🏢</div>
      <div>
        <div class="aii-title">Managed Portfolio · ${props.length} propert${props.length===1?'y':'ies'}</div>
        <div class="aii-sub">Click any property for full details, photos, and documents.</div>
      </div>
    </div>`;
  }

  // Render as a grid of admin-style cards
  list.innerHTML = `${intro}<div class="grid agent-inventory-grid">${props.map(agentCardHTML).join('')}</div>`;

  // Hydrate media thumbnails (mirror admin behavior)
  if (typeof loadCardMedia === 'function') {
    props.forEach(p => { if (p.media?.length) loadCardMedia(p); });
  }
};

// ═══════════════════════════════════════════════════════
//  TWO-WAY UPDATES MODULE — author labels everywhere
// ═══════════════════════════════════════════════════════

// Override task-notes render: chat-bubble style with author label
renderNotesList = function(notes) {
  const list = document.getElementById('taskNotesList');
  if (!list) return;
  if (!notes || !notes.length) {
    list.innerHTML = `<p style="color:var(--text-3);font-size:13px;text-align:center;padding:8px 0;">No updates yet.</p>`;
    return;
  }
  list.innerHTML = notes.map(n => {
    const author = n.authorName || (n.authorType === 'admin' ? 'Admin' : 'Unknown');
    const isAdmin = n.authorType === 'admin';
    const side = isAdmin ? 'note-admin' : 'note-agent';
    return `
      <div class="thread-msg ${side}">
        <div class="thread-msg-meta">
          <span class="thread-msg-author">${isAdmin ? '👑 ' : ''}${h(author)}${isAdmin ? '' : ''}</span>
          <span class="thread-msg-date">${formatDate(n.date)}</span>
        </div>
        <div class="thread-msg-bubble">${h(n.text)}</div>
      </div>`;
  }).join('');
  // Auto-scroll to bottom
  list.scrollTop = list.scrollHeight;
};

// (Legacy submitTaskNote override removed — the API-backed version
// earlier in this file is now authoritative. Notes persist via
// POST /api/tasks/:id/notes instead of being pushed onto task.notes,
// which bodyToDb stripped — that's why replies never propagated.)

// Override openTaskNotes: switch modal title for admin, ensure input is visible
const _origOpenTaskNotes = openTaskNotes;
openTaskNotes = function(taskId) {
  _origOpenTaskNotes(taskId);
  const titleEl = document.querySelector('#taskNotesOverlay h2');
  if (titleEl) titleEl.textContent = 'Conversation';
  const input = document.getElementById('taskNoteInput');
  if (input) input.placeholder = isAdminUser() ? 'Reply as Admin…' : 'Write an update…';
  // Ensure the input row is visible for both roles
  const formGroup = input?.closest('.form-group');
  if (formGroup) formGroup.style.display = '';
};

// ─── Lead activities: admin can also reply ─────────
const _origRenderActivityLog = renderActivityLog;
renderActivityLog = function(activities) {
  const log = document.getElementById('leadActivityLog');
  if (!log) return;
  if (!activities || !activities.length) {
    log.innerHTML = `<p style="color:var(--text-3);font-size:13px;text-align:center;padding:10px;">No activity logged yet.</p>`;
    return;
  }
  log.innerHTML = [...activities].reverse().map(a => {
    const at = ACT_TYPES[a.type] || { icon:'📝', label:'Note' };
    const isAdmin = a.authorType === 'admin' || (!a.byAgentId && !a.authorId && a.byAgentName === 'Admin');
    const author = a.byAgentName || a.authorName || (isAdmin ? 'Admin' : 'Unknown');
    const potential = a.potential
      ? `<span class="act-potential act-pot-${a.potential}">${a.potential==='high'?'🔥':'⚡'} ${a.potential.charAt(0).toUpperCase()+a.potential.slice(1)} potential</span>` : '';
    const stageChange = a.stageChanged
      ? `<span class="act-stage-change">→ Stage: ${(LEAD_STAGES[a.stageChanged]||{icon:'',label:a.stageChanged}).icon} ${(LEAD_STAGES[a.stageChanged]||{label:a.stageChanged}).label}</span>` : '';
    return `
      <div class="act-item ${isAdmin ? 'act-admin' : 'act-agent'}">
        <div class="act-icon">${isAdmin ? '👑' : at.icon}</div>
        <div class="act-body">
          <div class="act-header">
            <span class="act-type">${at.label}</span>
            ${potential}${stageChange}
            <span class="act-date">${formatDate(a.date)}</span>
          </div>
          <div class="act-by">${isAdmin ? 'Admin' : 'by ' + h(author)}</div>
          <div class="act-note">${h(a.note)}</div>
        </div>
      </div>`;
  }).join('');
};

// New: admin can submit a reply to a lead activity log
function adminSubmitLeadActivity() {
  if (!isAdminUser()) return;
  const noteEl = document.getElementById('actNote');
  const note = (noteEl?.value || '').trim();
  if (!note) { showToast('Write a message', 'error'); return; }
  const leads = loadLeads();
  const lead  = leads.find(l => l.id === currentLeadId);
  if (!lead) return;
  const newStage = (document.getElementById('actStage')?.value) || '';
  const act = {
    id:           'act_' + uid(),
    type:         (document.getElementById('actType')?.value) || 'note',
    potential:    (document.getElementById('actPotential')?.value) || '',
    stageChanged: newStage,
    note,
    date:         new Date().toISOString(),
    authorType:   'admin',
    authorName:   'Admin',
    byAgentName:  'Admin'
  };
  if (!lead.activities) lead.activities = [];
  lead.activities.push(act);
  if (newStage) lead.stage = newStage;
  lead.updatedAt = new Date().toISOString();
  saveLeads(leads);
  if (noteEl) noteEl.value = '';
  if (document.getElementById('actStage'))     document.getElementById('actStage').value = '';
  if (document.getElementById('actPotential')) document.getElementById('actPotential').value = '';
  renderActivityLog(lead.activities);
  if (typeof renderLeadsPipeline === 'function') renderLeadsPipeline();
  showToast('Reply posted', 'success');
}

// Override submitLeadActivity to also tag agent author info
const _origSubmitLeadActivity = submitLeadActivity;
submitLeadActivity = function() {
  if (isAdminUser()) return adminSubmitLeadActivity();
  return _origSubmitLeadActivity();
};

// Override openLeadDetail so admin also sees the reply form
const _origOpenLeadDetail = openLeadDetail;
openLeadDetail = function(id) {
  _origOpenLeadDetail(id);
  if (isAdminUser()) {
    const form = document.getElementById('leadAddActivityForm');
    const btn  = document.getElementById('leadAddActBtn');
    if (form) form.style.display = '';
    if (btn)  { btn.style.display = ''; btn.textContent = '👑 Reply as Admin'; }
    const noteEl = document.getElementById('actNote');
    if (noteEl) noteEl.placeholder = 'Reply as Admin… (changes stage if you pick one)';
  }
};

// ═══════════════════════════════════════════════════════
//  PERFORMANCE METRICS
// ═══════════════════════════════════════════════════════

let _perfPeriod = 'month'; // 'month' | 'all'

function computeAgentMetrics(agentId, period) {
  const tasks  = loadTasks().filter(t => t.agentId === agentId);
  const leads  = loadLeads().filter(l => l.assignedTo === agentId);
  const subs   = loadPendingProps().filter(p => p.addedByAgent === agentId);

  const tasksInP   = tasks.filter(t => inPeriod(t.updatedAt || t.createdAt, period));
  const leadsInP   = leads.filter(l => inPeriod(l.updatedAt || l.createdAt, period));

  const tasksDone        = tasksInP.filter(t => t.status === 'done').length;
  const tasksActive      = tasks.filter(t => t.status === 'pending' || t.status === 'in-progress').length;
  const propertiesShown  = tasksInP.filter(t => t.status === 'done' && t.type === 'site-visit').length;
  const proposalsSent    = leads.reduce((s,l) => s + ((l.activities||[]).filter(a => a.type === 'proposal' && inPeriod(a.date, period)).length), 0);
  const dealsWon         = leadsInP.filter(l => l.stage === 'won').length;
  const dealsLost        = leadsInP.filter(l => l.stage === 'lost').length;
  const totalAssigned    = leadsInP.length;
  const closedTotal      = dealsWon + dealsLost;
  const conversion       = closedTotal > 0 ? Math.round((dealsWon / closedTotal) * 100) : 0;
  const revenueClosed    = leadsInP
    .filter(l => l.stage === 'won')
    .reduce((s,l) => s + (Number(String(l.budget || '').replace(/[^\d.]/g,'')) || 0), 0);
  const submissions      = subs.filter(p => inPeriod(p.submittedAt, period)).length;
  const submissionsApp   = subs.filter(p => p.status === 'approved' && inPeriod(p.submittedAt, period)).length;

  // Stage distribution (active leads only)
  const stageDist = {};
  leads.forEach(l => { if (l.stage !== 'won' && l.stage !== 'lost') stageDist[l.stage] = (stageDist[l.stage] || 0) + 1; });

  return {
    tasksDone, tasksActive, propertiesShown, proposalsSent,
    dealsWon, dealsLost, totalAssigned, conversion, revenueClosed,
    submissions, submissionsApp, stageDist
  };
}

function renderLeaderboard() {
  const wrap = document.getElementById('teamLeaderboardSection');
  if (!wrap) return;
  const agents = loadAgents().filter(a => a.active !== false);
  const rows = agents.map(a => ({ a, m: computeAgentMetrics(a.id, _perfPeriod) }))
    .sort((x,y) => (y.m.revenueClosed - x.m.revenueClosed) || (y.m.dealsWon - x.m.dealsWon) || (y.m.tasksDone - x.m.tasksDone));

  const periodLbl = _perfPeriod === 'month' ? 'This Month' : 'All Time';
  const top = rows[0];

  wrap.innerHTML = `
    <div class="team-section-header">
      <div>
        <div class="team-section-title">🏆 Performance Leaderboard</div>
        <div class="team-section-sub">Ranked by revenue closed · ${periodLbl}</div>
      </div>
      <div class="perf-toggle">
        <button class="perf-btn ${_perfPeriod==='month'?'active':''}" onclick="setPerfPeriod('month')">This Month</button>
        <button class="perf-btn ${_perfPeriod==='all'?'active':''}" onclick="setPerfPeriod('all')">All Time</button>
      </div>
    </div>
    ${rows.length === 0 ? `<div class="team-empty"><div class="empty-icon">🏆</div><p>No agents yet.</p></div>` : `
    <div class="leaderboard-table">
      <div class="lb-head">
        <span>#</span><span>Agent</span><span>Revenue</span><span>Deals Won</span><span>Conv. %</span><span>Properties Shown</span><span>Proposals</span><span>Tasks Done</span>
      </div>
      ${rows.map(({a,m}, i) => `
        <div class="lb-row${i===0?' lb-top':''}">
          <span class="lb-rank">${i===0?'👑':'#'+(i+1)}</span>
          <span class="lb-agent"><span class="lb-avatar">${a.name.charAt(0).toUpperCase()}</span>${h(a.name)}</span>
          <span class="lb-rev">${m.revenueClosed ? 'AED '+num(m.revenueClosed) : '—'}</span>
          <span>${m.dealsWon}</span>
          <span>${m.conversion}%</span>
          <span>${m.propertiesShown}</span>
          <span>${m.proposalsSent}</span>
          <span>${m.tasksDone}</span>
        </div>`).join('')}
    </div>`}
  `;
}

function setPerfPeriod(p) { _perfPeriod = p; renderLeaderboard(); renderAgentMetricStrips(); }

function renderAgentMetricStrips() {
  // Inject metric strips below each existing agent card
  const cards = document.querySelectorAll('#agentsList .agent-card');
  const agents = loadAgents();
  cards.forEach(card => {
    // find the agent by name match (the existing card doesn't carry id) — improved: re-render in one go
  });
  // Simpler: rebuild the agents list with metrics included (next render of team)
}

// ═══════════════════════════════════════════════════════
//  ACTIVITY TIMELINE (auto-derived)
// ═══════════════════════════════════════════════════════

function buildTimelineEvents(agentFilter, typeFilter) {
  const agents = loadAgents();
  const agentName = (id) => (agents.find(a => a.id === id)?.name) || 'Unassigned';
  const events = [];

  loadLeads().forEach(l => {
    if (l.createdAt) events.push({
      ts: l.createdAt, type: 'lead-created', agentId: l.assignedTo || '',
      icon: '📥', text: `New lead: ${l.name}${l.company ? ' ('+l.company+')' : ''}`,
      who: l.assignedTo ? agentName(l.assignedTo) : 'Unassigned'
    });
    (l.activities || []).forEach(a => {
      const at = ACT_TYPES[a.type] || { icon:'📝', label:'Activity' };
      const isAdmin = a.authorType === 'admin';
      events.push({
        ts: a.date, type: 'lead-activity', agentId: isAdmin ? '' : (a.byAgentId || ''),
        icon: isAdmin ? '👑' : at.icon,
        text: `${at.label} on lead ${l.name}${a.note ? ' — '+a.note.slice(0,80) : ''}`,
        who: isAdmin ? 'Admin' : (a.byAgentName || agentName(a.byAgentId))
      });
      if (a.stageChanged) events.push({
        ts: a.date, type: 'lead-stage', agentId: isAdmin ? '' : (a.byAgentId || ''),
        icon: a.stageChanged === 'won' ? '🏆' : a.stageChanged === 'lost' ? '❌' : '🔁',
        text: `Lead "${l.name}" → ${(LEAD_STAGES[a.stageChanged]||{label:a.stageChanged}).label}`,
        who: isAdmin ? 'Admin' : (a.byAgentName || agentName(a.byAgentId))
      });
    });
  });

  loadTasks().forEach(t => {
    if (t.createdAt) events.push({
      ts: t.createdAt, type: 'task-created', agentId: t.agentId || '',
      icon: '📋', text: `Task assigned: ${t.title}`,
      who: t.agentId ? agentName(t.agentId) : 'Unassigned'
    });
    if (t.status === 'done' && t.updatedAt) events.push({
      ts: t.updatedAt, type: 'task-done', agentId: t.agentId || '',
      icon: '✅', text: `Task completed: ${t.title}`,
      who: t.agentId ? agentName(t.agentId) : 'Unassigned'
    });
    (t.notes || []).forEach(n => events.push({
      ts: n.date, type: 'task-note', agentId: n.authorType === 'agent' ? n.authorId : '',
      icon: n.authorType === 'admin' ? '👑' : '💬',
      text: `Update on "${t.title}" — ${n.text.slice(0,80)}`,
      who: n.authorName || (n.authorType === 'admin' ? 'Admin' : 'Unknown')
    }));
  });

  loadPendingProps().forEach(p => {
    if (p.submittedAt) events.push({
      ts: p.submittedAt, type: 'prop-submitted', agentId: p.addedByAgent || '',
      icon: '🏗️', text: `Property submitted: ${p.name}`,
      who: p.addedByAgentName || agentName(p.addedByAgent)
    });
  });

  return events
    .filter(e => e.ts && !isNaN(new Date(e.ts)))
    .filter(e => !agentFilter || e.agentId === agentFilter)
    .filter(e => !typeFilter || e.type === typeFilter)
    .sort((a,b) => new Date(b.ts) - new Date(a.ts));
}

function renderActivityTimeline() {
  const wrap = document.getElementById('teamActivityTimeline');
  if (!wrap) return;
  const agentFilter = (document.getElementById('timelineAgentFilter')?.value) || '';
  const typeFilter  = (document.getElementById('timelineTypeFilter')?.value)  || '';
  const events = buildTimelineEvents(agentFilter, typeFilter).slice(0, 80);

  const today = new Date(); today.setHours(0,0,0,0);
  const yest  = new Date(today.getTime() - 86400000);
  const wkAgo = new Date(today.getTime() - 7*86400000);

  const groups = { Today: [], Yesterday: [], 'Earlier this week': [], Older: [] };
  events.forEach(e => {
    const d = new Date(e.ts);
    if      (d >= today)  groups.Today.push(e);
    else if (d >= yest)   groups.Yesterday.push(e);
    else if (d >= wkAgo)  groups['Earlier this week'].push(e);
    else                  groups.Older.push(e);
  });

  const agents = loadAgents();
  const agentOpts = agents.map(a => `<option value="${a.id}"${agentFilter===a.id?' selected':''}>${h(a.name)}</option>`).join('');

  wrap.innerHTML = `
    <div class="team-section-header">
      <div>
        <div class="team-section-title">📜 Activity Timeline</div>
        <div class="team-section-sub">Live feed of everything happening in the team</div>
      </div>
      <div style="display:flex;gap:8px;">
        <select class="filter-select" id="timelineAgentFilter" onchange="renderActivityTimeline()" style="width:160px;">
          <option value="">All Agents</option>${agentOpts}
        </select>
        <select class="filter-select" id="timelineTypeFilter" onchange="renderActivityTimeline()" style="width:160px;">
          <option value="">All Types</option>
          <option value="lead-created"${typeFilter==='lead-created'?' selected':''}>Lead Created</option>
          <option value="lead-activity"${typeFilter==='lead-activity'?' selected':''}>Lead Activity</option>
          <option value="lead-stage"${typeFilter==='lead-stage'?' selected':''}>Stage Changes</option>
          <option value="task-created"${typeFilter==='task-created'?' selected':''}>Task Created</option>
          <option value="task-done"${typeFilter==='task-done'?' selected':''}>Task Done</option>
          <option value="task-note"${typeFilter==='task-note'?' selected':''}>Task Updates</option>
          <option value="prop-submitted"${typeFilter==='prop-submitted'?' selected':''}>Property Submitted</option>
        </select>
      </div>
    </div>
    ${events.length === 0 ? `<div class="team-empty"><div class="empty-icon">📜</div><p>No activity matches your filters.</p></div>` :
      Object.entries(groups).filter(([,arr]) => arr.length).map(([label, arr]) => `
        <div class="timeline-group">
          <div class="timeline-group-label">${label} <span class="timeline-group-count">${arr.length}</span></div>
          ${arr.map(e => `
            <div class="timeline-item">
              <div class="timeline-icon">${e.icon}</div>
              <div class="timeline-body">
                <div class="timeline-text">${h(e.text)}</div>
                <div class="timeline-meta">${h(e.who)} · ${formatDate(e.ts)}</div>
              </div>
            </div>`).join('')}
        </div>`).join('')}
  `;
}

// ═══════════════════════════════════════════════════════
//  SCHEDULE / AVAILABILITY
// ═══════════════════════════════════════════════════════

function setAgentAvailability(agentId, status) {
  const agents = loadAgents();
  const ag = agents.find(a => a.id === agentId);
  if (!ag) return;
  ag.availability = status;
  saveAgents(agents);
  renderTeamTab();
  showToast('Availability updated', 'success');
}

function renderScheduleBoard() {
  const wrap = document.getElementById('teamScheduleSection');
  if (!wrap) return;
  const agents = loadAgents().filter(a => a.active !== false);
  const leaves = loadLeaves();
  const today = new Date(); today.setHours(0,0,0,0);

  const isOnLeaveToday = (agentId) => leaves.some(L => {
    if (L.agentId !== agentId) return false;
    const s = new Date(L.startDate); s.setHours(0,0,0,0);
    const e = new Date(L.endDate);   e.setHours(0,0,0,0);
    return today >= s && today <= e;
  });

  const upcomingLeaves = leaves
    .filter(L => new Date(L.endDate) >= today)
    .sort((a,b) => new Date(a.startDate) - new Date(b.startDate))
    .slice(0, 10);

  const agentName = (id) => (agents.find(a => a.id === id)?.name) || 'Unknown';

  const statusOpts = Object.entries(AVAILABILITY_META)
    .map(([k,m]) => `<option value="${k}">${m.icon} ${m.label}</option>`).join('');

  wrap.innerHTML = `
    <div class="team-section-header">
      <div>
        <div class="team-section-title">📅 Today's Schedule</div>
        <div class="team-section-sub">Who's available, in meetings, on leave</div>
      </div>
      <button class="btn-primary" onclick="openLeaveModal()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Leave
      </button>
    </div>
    <div class="schedule-grid">
      ${agents.length === 0 ? `<div class="team-empty"><div class="empty-icon">👥</div><p>No active agents.</p></div>` :
        agents.map(a => {
          const onLeave = isOnLeaveToday(a.id);
          const status  = onLeave ? 'on_leave' : (a.availability || 'available');
          const m = availMeta(status);
          return `
            <div class="schedule-card">
              <div class="schedule-card-top">
                <span class="schedule-avatar">${a.name.charAt(0).toUpperCase()}</span>
                <div style="flex:1;min-width:0;">
                  <div class="schedule-name">${h(a.name)}</div>
                  <div class="schedule-status ${m.cls}">${m.icon} ${m.label}</div>
                </div>
              </div>
              ${!onLeave ? `
              <select class="schedule-status-select" onchange="setAgentAvailability('${a.id}', this.value)">
                ${Object.entries(AVAILABILITY_META).filter(([k]) => k !== 'on_leave').map(([k,mm]) =>
                  `<option value="${k}"${(a.availability||'available')===k?' selected':''}>${mm.icon} ${mm.label}</option>`
                ).join('')}
              </select>` : '<div class="schedule-onleave-note">On leave today</div>'}
            </div>`;
        }).join('')}
    </div>
    ${upcomingLeaves.length ? `
    <div class="leaves-section">
      <div class="leaves-section-title">🌴 Upcoming Leaves</div>
      <div class="leaves-list">
        ${upcomingLeaves.map(L => `
          <div class="leave-item">
            <div class="leave-item-avatar">${(agentName(L.agentId)||'?').charAt(0).toUpperCase()}</div>
            <div class="leave-item-body">
              <div class="leave-item-name">${h(agentName(L.agentId))}</div>
              <div class="leave-item-dates">${fmtDate(L.startDate)} → ${fmtDate(L.endDate)}${L.reason ? ' · '+h(L.reason) : ''}</div>
            </div>
            <button class="btn-icon-sm btn-danger-sm" onclick="deleteLeave('${L.id}')" title="Delete leave">🗑️</button>
          </div>`).join('')}
      </div>
    </div>` : ''}
  `;
  // Suppress unused arg
  void statusOpts;
}

function openLeaveModal() {
  const agents = loadAgents().filter(a => a.active !== false);
  const sel = document.getElementById('leaveAgent');
  if (!sel) return;
  sel.innerHTML = agents.map(a => `<option value="${a.id}">${h(a.name)}</option>`).join('');
  document.getElementById('leaveStart').value  = '';
  document.getElementById('leaveEnd').value    = '';
  document.getElementById('leaveReason').value = '';
  document.getElementById('leaveModalOverlay').classList.add('active');
}
function closeLeaveModal() { document.getElementById('leaveModalOverlay').classList.remove('active'); }

function saveLeave() {
  const agentId = document.getElementById('leaveAgent').value;
  const start   = document.getElementById('leaveStart').value;
  const end     = document.getElementById('leaveEnd').value;
  const reason  = document.getElementById('leaveReason').value.trim();
  if (!agentId) { showToast('Pick an agent', 'error'); return; }
  if (!start || !end) { showToast('Both dates required', 'error'); return; }
  if (new Date(end) < new Date(start)) { showToast('End date must be after start', 'error'); return; }
  const leaves = loadLeaves();
  leaves.push({ id: 'lv_' + uid(), agentId, startDate: start, endDate: end, reason, createdAt: new Date().toISOString() });
  saveLeaves(leaves);
  closeLeaveModal();
  showToast('Leave added', 'success');
  renderTeamTab();
}

function deleteLeave(id) {
  if (!confirm('Delete this leave entry?')) return;
  saveLeaves(loadLeaves().filter(L => L.id !== id));
  renderTeamTab();
  showToast('Leave deleted', 'success');
}

// ═══════════════════════════════════════════════════════
//  INTERNAL ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════

function renderAdminAnnouncements() {
  const wrap = document.getElementById('teamAnnouncementsSection');
  if (!wrap) return;
  const items = loadAnnouncements()
    .sort((a,b) => (b.pinned?1:0) - (a.pinned?1:0) || new Date(b.createdAt) - new Date(a.createdAt));
  const agents = loadAgents().filter(a => a.active !== false);

  wrap.innerHTML = `
    <div class="team-section-header">
      <div>
        <div class="team-section-title">📢 Announcements</div>
        <div class="team-section-sub">Broadcast messages to all agents</div>
      </div>
      <button class="btn-primary" onclick="openAnnouncementModal()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Announcement
      </button>
    </div>
    ${items.length === 0 ? `<div class="team-empty"><div class="empty-icon">📢</div><p>No announcements yet. Post something to keep the team informed.</p></div>` : `
    <div class="announce-list">
      ${items.map(an => {
        const expired = an.expiresAt && new Date(an.expiresAt) < new Date();
        const readCount = (an.readBy || []).length;
        const total = agents.length;
        return `
          <div class="announce-item${an.pinned ? ' announce-pinned' : ''}${expired ? ' announce-expired' : ''}">
            <div class="announce-head">
              <div class="announce-title-wrap">
                ${an.pinned ? '<span class="announce-pin-chip">📌 Pinned</span>' : ''}
                ${expired ? '<span class="announce-exp-chip">Expired</span>' : ''}
                <div class="announce-title">${h(an.title)}</div>
              </div>
              <div class="announce-actions">
                <button class="btn-icon-sm" onclick="openAnnouncementModal('${an.id}')" title="Edit">✏️</button>
                <button class="btn-icon-sm btn-danger-sm" onclick="deleteAnnouncement('${an.id}')" title="Delete">🗑️</button>
              </div>
            </div>
            <div class="announce-body">${h(an.body)}</div>
            <div class="announce-meta">
              <span>📅 ${formatDate(an.createdAt)}</span>
              ${an.expiresAt ? `<span>⏳ Expires ${fmtDate(an.expiresAt)}</span>` : ''}
              <span>👁️ Read by ${readCount}/${total}</span>
            </div>
          </div>`;
      }).join('')}
    </div>`}
  `;
}

function openAnnouncementModal(id) {
  const items = loadAnnouncements();
  const a = id ? items.find(x => x.id === id) : null;
  document.getElementById('announceModalTitle').textContent = a ? 'Edit Announcement' : 'New Announcement';
  document.getElementById('announceId').value     = a ? a.id : '';
  document.getElementById('announceTitle').value  = a ? a.title : '';
  document.getElementById('announceBody').value   = a ? a.body  : '';
  document.getElementById('announcePinned').checked = a ? !!a.pinned : false;
  document.getElementById('announceExpiresAt').value = a ? (a.expiresAt || '') : '';
  document.getElementById('announceModalOverlay').classList.add('active');
}
function closeAnnouncementModal() { document.getElementById('announceModalOverlay').classList.remove('active'); }

function saveAnnouncement() {
  const id        = document.getElementById('announceId').value;
  const title     = document.getElementById('announceTitle').value.trim();
  const body      = document.getElementById('announceBody').value.trim();
  const pinned    = document.getElementById('announcePinned').checked;
  const expiresAt = document.getElementById('announceExpiresAt').value;
  if (!title) { showToast('Title is required', 'error'); return; }
  if (!body)  { showToast('Body is required', 'error');  return; }
  const items = loadAnnouncements();
  if (id) {
    const idx = items.findIndex(x => x.id === id);
    if (idx > -1) items[idx] = { ...items[idx], title, body, pinned, expiresAt };
  } else {
    items.unshift({
      id: 'ann_' + uid(), title, body, pinned, expiresAt,
      createdAt: new Date().toISOString(),
      readBy: []
    });
  }
  saveAnnouncements(items);
  closeAnnouncementModal();
  showToast('Announcement saved', 'success');
  renderTeamTab();
}

function deleteAnnouncement(id) {
  if (!confirm('Delete this announcement?')) return;
  saveAnnouncements(loadAnnouncements().filter(a => a.id !== id));
  renderTeamTab();
  showToast('Announcement deleted', 'success');
}

function dismissAnnouncementForAgent(id) {
  const sess = getSession();
  if (!sess || sess.type !== 'agent') return;
  const items = loadAnnouncements();
  const a = items.find(x => x.id === id);
  if (!a) return;
  if (!a.readBy) a.readBy = [];
  if (!a.readBy.includes(sess.agentId)) a.readBy.push(sess.agentId);
  saveAnnouncements(items);
  renderAgentAnnouncementBanner();
}

function renderAgentAnnouncementBanner() {
  const sess = getSession();
  if (!sess || sess.type !== 'agent') return;
  const wrap = document.getElementById('agentAnnouncementBanner');
  if (!wrap) return;
  const now = new Date();
  const items = loadAnnouncements()
    .filter(a => !a.expiresAt || new Date(a.expiresAt) >= now)
    .filter(a => !(a.readBy || []).includes(sess.agentId))
    .sort((a,b) => (b.pinned?1:0) - (a.pinned?1:0) || new Date(b.createdAt) - new Date(a.createdAt));
  if (!items.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = '';
  wrap.innerHTML = items.map(a => `
    <div class="agent-announce-card${a.pinned?' agent-announce-pinned':''}">
      <div class="agent-announce-icon">${a.pinned?'📌':'📢'}</div>
      <div class="agent-announce-body">
        <div class="agent-announce-title">${h(a.title)}</div>
        <div class="agent-announce-text">${h(a.body)}</div>
        <div class="agent-announce-meta">${formatDate(a.createdAt)}</div>
      </div>
      <button class="agent-announce-dismiss" onclick="dismissAnnouncementForAgent('${a.id}')" title="Mark as read">✓</button>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════
//  TEAM PAGE — inject new sections + agent metric strips
// ═══════════════════════════════════════════════════════

// ─── Sub-tab system on Team page ─────────────────────
let _currentTeamSubTab = 'overview';

const TEAM_SUBTABS = [
  { id:'overview',    label:'Overview',     icon:'📊' },
  { id:'performance', label:'Performance',  icon:'🏆' },
  { id:'tasks',       label:'Tasks',        icon:'📋' },
  { id:'agents',      label:'Agents',       icon:'👥' },
  { id:'tasksgiven',  label:'Tasks Given',  icon:'✅' },
  { id:'leads',       label:'Leads',        icon:'🎯' }
];

// Map every section to a sub-tab. Sections rendered if value matches active tab.
const TEAM_SECTION_TABS = {
  teamOverviewSection:      'overview',
  teamLeaderboardSection:   'performance',
  teamActivityTimeline:     'performance',
  teamScheduleSection:      'tasks',
  teamAnnouncementsSection: 'tasks',
  pendingPropsSection:      'tasks',
  teamAgentsSection:        'agents',
  teamTasksSection:         'tasksgiven',
  teamLeadsSection:         'leads',
  teamMeetingsSection:      'leads'
};

function ensureTeamSections() {
  const teamPage = document.querySelector('#teamView .team-page');
  if (!teamPage) return;

  // 1) Wrap existing content in a content area + add a left sub-nav
  let content = document.getElementById('teamContent');
  let nav     = document.getElementById('teamSubTabNav');

  if (!nav) {
    nav = document.createElement('aside');
    nav.id = 'teamSubTabNav';
    nav.className = 'team-subnav';
    nav.innerHTML = `
      <div class="team-subnav-label">Team Module</div>
      ${TEAM_SUBTABS.map(t => `
        <button class="team-subnav-btn${_currentTeamSubTab===t.id?' active':''}" data-tab="${t.id}" onclick="setTeamSubTab('${t.id}')">
          <span class="team-subnav-icon">${t.icon}</span>
          <span class="team-subnav-label-text">${t.label}</span>
        </button>`).join('')}
    `;
  }

  if (!content) {
    content = document.createElement('div');
    content.id = 'teamContent';
    content.className = 'team-content';
    // Move every existing direct child (the .team-section blocks) into the content wrapper
    Array.from(teamPage.children).forEach(child => {
      if (child === nav) return;
      content.appendChild(child);
    });
    teamPage.appendChild(nav);
    teamPage.appendChild(content);
  }

  // 2) Ensure all dynamic sections exist (inside content)
  const dyn = ['teamOverviewSection','teamLeaderboardSection','teamScheduleSection','teamAnnouncementsSection','teamActivityTimeline','teamMeetingsSection'];
  dyn.forEach(id => {
    if (document.getElementById(id)) return;
    const div = document.createElement('div');
    div.id = id;
    div.className = 'team-section';
    content.appendChild(div);
  });

  // 3) Tag every section with its sub-tab so visibility can be filtered
  Object.entries(TEAM_SECTION_TABS).forEach(([id, tab]) => {
    const el = document.getElementById(id);
    if (el) el.dataset.teamTab = tab;
  });

  // 4) Apply visibility for the current sub-tab
  applyTeamSubTab();
}

function setTeamSubTab(tab) {
  _currentTeamSubTab = tab;
  // Update nav button active state
  const nav = document.getElementById('teamSubTabNav');
  if (nav) {
    nav.querySelectorAll('.team-subnav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
  }
  applyTeamSubTab();
  if (tab === 'overview') renderTeamOverview();
}

function applyTeamSubTab() {
  const teamPage = document.querySelector('#teamView .team-page');
  if (!teamPage) return;
  teamPage.querySelectorAll('[data-team-tab]').forEach(el => {
    el.style.display = (el.dataset.teamTab === _currentTeamSubTab) ? '' : 'none';
  });
}

// ─── Overview tab content ───────────────────────────
function renderTeamOverview() {
  const wrap = document.getElementById('teamOverviewSection');
  if (!wrap) return;

  const agents = loadAgents().filter(a => a.active !== false);
  const leaves = loadLeaves();
  const today = new Date(); today.setHours(0,0,0,0);

  const onLeaveCount = agents.filter(a => leaves.some(L => {
    if (L.agentId !== a.id) return false;
    const s = new Date(L.startDate); s.setHours(0,0,0,0);
    const e = new Date(L.endDate);   e.setHours(0,0,0,0);
    return today >= s && today <= e;
  })).length;
  const availableCount = agents.length - onLeaveCount;

  const allLeads = loadLeads();
  const activeLeads = allLeads.filter(l => l.stage !== 'won' && l.stage !== 'lost').length;

  // Aggregate metrics for the team this month
  const monthMetrics = agents.map(a => computeAgentMetrics(a.id, 'month'));
  const dealsMonth     = monthMetrics.reduce((s,m) => s + m.dealsWon, 0);
  const revenueMonth   = monthMetrics.reduce((s,m) => s + m.revenueClosed, 0);
  const proposalsMonth = monthMetrics.reduce((s,m) => s + m.proposalsSent, 0);

  // Top 3 leaderboard
  const ranked = agents.map(a => ({ a, m: computeAgentMetrics(a.id, 'month') }))
    .sort((x,y) => (y.m.revenueClosed - x.m.revenueClosed) || (y.m.dealsWon - x.m.dealsWon) || (y.m.tasksDone - x.m.tasksDone))
    .slice(0, 3);

  // Today's status snapshot
  const onLeaveAgents = agents.filter(a => leaves.some(L => {
    if (L.agentId !== a.id) return false;
    const s = new Date(L.startDate); s.setHours(0,0,0,0);
    const e = new Date(L.endDate);   e.setHours(0,0,0,0);
    return today >= s && today <= e;
  }));
  const inMeetingAgents = agents.filter(a => a.availability === 'in_meeting' && !onLeaveAgents.includes(a));
  const atViewingAgents = agents.filter(a => a.availability === 'at_viewing' && !onLeaveAgents.includes(a));

  // Latest 3 announcements
  const items = loadAnnouncements()
    .filter(a => !a.expiresAt || new Date(a.expiresAt) >= new Date())
    .sort((a,b) => (b.pinned?1:0) - (a.pinned?1:0) || new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 3);

  // Recent activity
  const recent = buildTimelineEvents('', '').slice(0, 5);

  // Pending submissions count
  const pendingSubs = loadPendingProps().filter(p => p.status === 'pending').length;

  wrap.innerHTML = `
    <!-- KPI strip -->
    <div class="overview-kpi-strip">
      <div class="okpi"><div class="okpi-num">${agents.length}</div><div class="okpi-lbl">Active Agents</div></div>
      <div class="okpi"><div class="okpi-num">${availableCount}</div><div class="okpi-lbl">Available Today</div></div>
      <div class="okpi"><div class="okpi-num">${activeLeads}</div><div class="okpi-lbl">Active Leads</div></div>
      <div class="okpi"><div class="okpi-num">${(() => {
        const start = new Date(); start.setHours(0,0,0,0);
        const end = new Date(start); end.setDate(end.getDate() + 7);
        return loadMeetings().filter(m => {
          if (m.status !== 'scheduled') return false;
          if (!m.date) return false;
          const d = new Date(m.date); return d >= start && d <= end;
        }).length;
      })()}</div><div class="okpi-lbl">Meetings (7 days)</div></div>
      <div class="okpi"><div class="okpi-num">${dealsMonth}</div><div class="okpi-lbl">Deals (Month)</div></div>
      <div class="okpi"><div class="okpi-num">${revenueMonth ? 'AED '+num(revenueMonth) : '—'}</div><div class="okpi-lbl">Revenue (Month)</div></div>
    </div>

    <!-- Quick actions -->
    <div class="overview-quick-actions">
      <button class="qaction" onclick="openAgentModal()">👤 Add Agent</button>
      <button class="qaction" onclick="openTaskModal()">📋 Assign Task</button>
      <button class="qaction" onclick="openLeadModal()">🎯 Add Lead</button>
      <button class="qaction" onclick="openAnnouncementModal()">📢 Announcement</button>
      <button class="qaction" onclick="openLeaveModal()">🌴 Add Leave</button>
    </div>

    <!-- 2-col layout -->
    <div class="overview-grid">

      <!-- Top performers -->
      <div class="overview-card">
        <div class="overview-card-head">
          <div class="overview-card-title">🏆 Top Performers — This Month</div>
          <button class="btn-link" onclick="setTeamSubTab('performance')">View all →</button>
        </div>
        ${ranked.length === 0 ? '<div class="overview-empty">No agents yet.</div>' : `
        <div class="overview-podium">
          ${ranked.map(({a,m}, i) => `
            <div class="podium-row podium-${i+1}">
              <span class="podium-rank">${i===0?'👑':'#'+(i+1)}</span>
              <span class="podium-avatar">${a.name.charAt(0).toUpperCase()}</span>
              <div class="podium-body">
                <div class="podium-name">${h(a.name)}</div>
                <div class="podium-stats">${m.dealsWon} won · ${m.conversion}% conv · ${m.revenueClosed?'AED '+num(m.revenueClosed):'—'}</div>
              </div>
            </div>`).join('')}
        </div>`}
      </div>

      <!-- Today's status -->
      <div class="overview-card">
        <div class="overview-card-head">
          <div class="overview-card-title">📅 Today</div>
          <button class="btn-link" onclick="setTeamSubTab('tasks')">Manage →</button>
        </div>
        ${onLeaveAgents.length === 0 && inMeetingAgents.length === 0 && atViewingAgents.length === 0 ? `
          <div class="overview-empty">Everyone available — no meetings, leaves, or viewings logged.</div>
        ` : `
          ${onLeaveAgents.length ? `<div class="status-bucket"><span class="status-bucket-label">🌴 On leave</span><span class="status-bucket-names">${onLeaveAgents.map(a => h(a.name)).join(', ')}</span></div>` : ''}
          ${inMeetingAgents.length ? `<div class="status-bucket"><span class="status-bucket-label">🟡 In meeting</span><span class="status-bucket-names">${inMeetingAgents.map(a => h(a.name)).join(', ')}</span></div>` : ''}
          ${atViewingAgents.length ? `<div class="status-bucket"><span class="status-bucket-label">🏗️ At viewing</span><span class="status-bucket-names">${atViewingAgents.map(a => h(a.name)).join(', ')}</span></div>` : ''}
        `}
      </div>

      <!-- Announcements snapshot -->
      <div class="overview-card">
        <div class="overview-card-head">
          <div class="overview-card-title">📢 Latest Announcements</div>
          <button class="btn-link" onclick="setTeamSubTab('tasks')">All →</button>
        </div>
        ${items.length === 0 ? '<div class="overview-empty">No active announcements.</div>' : `
        <div class="overview-announce-list">
          ${items.map(a => `
            <div class="overview-announce-row${a.pinned?' overview-announce-pinned':''}">
              ${a.pinned ? '<span class="overview-announce-pin">📌</span>' : ''}
              <div>
                <div class="overview-announce-title">${h(a.title)}</div>
                <div class="overview-announce-meta">${formatDate(a.createdAt)} · ${(a.readBy||[]).length}/${agents.length} read</div>
              </div>
            </div>`).join('')}
        </div>`}
      </div>

      <!-- Recent activity -->
      <div class="overview-card">
        <div class="overview-card-head">
          <div class="overview-card-title">📜 Recent Activity</div>
          <button class="btn-link" onclick="setTeamSubTab('performance')">Full feed →</button>
        </div>
        ${recent.length === 0 ? '<div class="overview-empty">No recent activity.</div>' : `
        <div class="overview-activity-list">
          ${recent.map(e => `
            <div class="overview-activity-row">
              <span class="overview-activity-icon">${e.icon}</span>
              <div>
                <div class="overview-activity-text">${h(e.text)}</div>
                <div class="overview-activity-meta">${h(e.who)} · ${formatDate(e.ts)}</div>
              </div>
            </div>`).join('')}
        </div>`}
      </div>

    </div>

    ${pendingSubs > 0 ? `
    <div class="overview-pending-callout" onclick="setTeamSubTab('tasks')">
      <span>⚠️</span>
      <div>
        <div class="overview-pending-title">${pendingSubs} property submission${pendingSubs===1?'':'s'} awaiting your review</div>
        <div class="overview-pending-sub">Click to review in Operations</div>
      </div>
      <span style="margin-left:auto;">→</span>
    </div>` : ''}

    <!-- Counts summary at the bottom -->
    <div class="overview-summary-row">
      <span>${proposalsMonth} proposals sent this month</span>
      <span>${pendingSubs} pending submission${pendingSubs===1?'':'s'}</span>
    </div>
  `;
}

// Append metric strip to each agent card after the existing render
function decorateAgentCardsWithMetrics() {
  const agents = loadAgents();
  const list = document.getElementById('agentsList');
  if (!list) return;
  const cards = list.querySelectorAll('.agent-card');
  cards.forEach(card => {
    if (card.querySelector('.agent-metric-strip')) return; // already decorated
    // Match agent by username chip (`@username`)
    const userChip = card.querySelector('.agent-stat:last-of-type');
    const uname = (userChip?.textContent || '').replace(/^@/, '').trim();
    const ag = agents.find(a => a.username === uname);
    if (!ag) return;
    const m = computeAgentMetrics(ag.id, _perfPeriod);
    const av = availMeta(ag.availability || 'available');

    const strip = document.createElement('div');
    strip.className = 'agent-metric-strip';
    strip.innerHTML = `
      <span class="agent-availability ${av.cls}">${av.icon} ${av.label}</span>
      <span class="agent-metric"><strong>${m.dealsWon}</strong> won</span>
      <span class="agent-metric"><strong>${m.conversion}%</strong> conv.</span>
      <span class="agent-metric"><strong>${m.propertiesShown}</strong> shown</span>
      <span class="agent-metric"><strong>${m.proposalsSent}</strong> proposals</span>
      <span class="agent-metric agent-metric-rev"><strong>${m.revenueClosed ? 'AED '+num(m.revenueClosed) : '—'}</strong> revenue</span>
    `;
    const body = card.querySelector('.agent-card-body');
    if (body) body.appendChild(strip);
  });
}

// Override the previously-overridden renderTeamTab to inject the new sections
const _origRenderTeamTab2 = renderTeamTab;
renderTeamTab = function() {
  ensureTeamSections();
  _origRenderTeamTab2();
  renderTeamOverview();
  renderLeaderboard();
  renderScheduleBoard();
  renderAdminAnnouncements();
  renderActivityTimeline();
  renderAdminMeetings();
  decorateAgentCardsWithMetrics();
};

// Admin view of all meetings & viewings across agents
function renderAdminMeetings() {
  const wrap = document.getElementById('teamMeetingsSection');
  if (!wrap) return;
  const agents = loadAgents();
  const leads  = loadLeads();
  const props  = loadProps();
  let items = loadMeetings();

  const agentF  = (document.getElementById('mtgAdminAgent')?.value)  || '';
  const typeF   = (document.getElementById('mtgAdminType')?.value)   || '';
  const statusF = (document.getElementById('mtgAdminStatus')?.value) || '';
  if (agentF)  items = items.filter(m => m.agentId === agentF);
  if (typeF)   items = items.filter(m => m.type   === typeF);
  if (statusF) items = items.filter(m => m.status === statusF);
  items = items.sort((a,b) => {
    const ad = new Date((a.date||'') + 'T' + (a.time||'00:00'));
    const bd = new Date((b.date||'') + 'T' + (b.time||'00:00'));
    return bd - ad;
  });

  const counts = {
    total: items.length,
    scheduled: items.filter(m => m.status === 'scheduled').length,
    completed: items.filter(m => m.status === 'completed').length,
    photos:    items.reduce((s,m) => s + (m.photos?.length || 0), 0)
  };

  const agentName = id => (agents.find(a => a.id === id)?.name) || 'Unknown';

  wrap.innerHTML = `
    <div class="team-section-header">
      <div>
        <div class="team-section-title">📅 Meetings &amp; Viewings</div>
        <div class="team-section-sub">All client meetings &amp; property viewings logged by your team</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <select class="filter-select" id="mtgAdminAgent" onchange="renderAdminMeetings()" style="width:160px;">
          <option value="">All Agents</option>
          ${agents.map(a => `<option value="${a.id}"${agentF===a.id?' selected':''}>${h(a.name)}</option>`).join('')}
        </select>
        <select class="filter-select" id="mtgAdminType" onchange="renderAdminMeetings()" style="width:150px;">
          <option value="">All Types</option>
          <option value="meeting"${typeF==='meeting'?' selected':''}>🤝 Meeting</option>
          <option value="viewing"${typeF==='viewing'?' selected':''}>🏗️ Viewing</option>
        </select>
        <select class="filter-select" id="mtgAdminStatus" onchange="renderAdminMeetings()" style="width:160px;">
          <option value="">All Statuses</option>
          <option value="scheduled"${statusF==='scheduled'?' selected':''}>⏰ Scheduled</option>
          <option value="completed"${statusF==='completed'?' selected':''}>✅ Completed</option>
          <option value="cancelled"${statusF==='cancelled'?' selected':''}>❌ Cancelled</option>
          <option value="noshow"${statusF==='noshow'?' selected':''}>🚫 No-show</option>
        </select>
      </div>
    </div>

    <div class="mtg-stat-row">
      <span class="mtg-stat-chip">📅 ${counts.total} total</span>
      <span class="mtg-stat-chip mtg-stat-blue">⏰ ${counts.scheduled} scheduled</span>
      <span class="mtg-stat-chip mtg-stat-green">✅ ${counts.completed} completed</span>
      <span class="mtg-stat-chip">📷 ${counts.photos} photo${counts.photos===1?'':'s'}</span>
    </div>

    ${items.length === 0 ? `
      <div class="team-empty"><div class="empty-icon">📅</div><p>No meetings logged${agentF||typeF||statusF?' with these filters':''}.</p></div>
    ` : `
      <div class="mtg-admin-table">
        <div class="mtg-row mtg-head">
          <span>Date / Time</span>
          <span>Type</span>
          <span>Agent</span>
          <span>Lead / Property</span>
          <span>Location</span>
          <span>Status</span>
          <span>Photos</span>
        </div>
        ${items.map(m => {
          const tm   = MTG_TYPE_META[m.type]   || MTG_TYPE_META.meeting;
          const sm   = MTG_STATUS_META[m.status] || MTG_STATUS_META.scheduled;
          const lead = m.leadId ? leads.find(l => l.id === m.leadId) : null;
          const prop = m.propId ? props.find(p => p.id === m.propId) : null;
          return `
          <div class="mtg-row" onclick="openMeetingModal('${m.id}')">
            <span>${m.date ? fmtDate(m.date) : '—'}${m.time ? `<span class="mtg-sub">${m.time}</span>` : ''}</span>
            <span>${tm.icon} ${tm.label}</span>
            <span>${h(m.agentName || agentName(m.agentId))}</span>
            <span>${lead ? h(lead.name) : '—'}${prop ? `<span class="mtg-sub">🏗️ ${h(prop.name)}</span>` : (lead && lead.company ? `<span class="mtg-sub">${h(lead.company)}</span>` : '')}</span>
            <span>${m.location ? h(m.location) : '—'}</span>
            <span><span class="meeting-status-pill ${sm.cls}">${sm.icon} ${sm.label}</span></span>
            <span>${(m.photos?.length || 0)}</span>
          </div>`;
        }).join('')}
      </div>
    `}
  `;
}

// Override agent overview to render announcement banner
const _origRenderAgentOverview = renderAgentOverview;
renderAgentOverview = function() {
  _origRenderAgentOverview();
  ensureAgentAnnouncementBanner();
  renderAgentAnnouncementBanner();
};

function ensureAgentAnnouncementBanner() {
  if (document.getElementById('agentAnnouncementBanner')) return;
  const overview = document.getElementById('agentTabOverview');
  const welcome  = document.getElementById('agentWelcome');
  if (!overview || !welcome) return;
  const wrap = document.createElement('div');
  wrap.id = 'agentAnnouncementBanner';
  wrap.className = 'agent-announcement-banner';
  // Insert right after the welcome card
  welcome.insertAdjacentElement('afterend', wrap);
}

// ═══════════════════════════════════════════════════════
//  AGENT DASHBOARD — personal performance + leaderboard rank
// ═══════════════════════════════════════════════════════

function ensureAgentDashboardPanel() {
  if (document.getElementById('agentDashboardPanel')) return;
  const stats = document.getElementById('agentStats');
  if (!stats) return;
  const panel = document.createElement('div');
  panel.id = 'agentDashboardPanel';
  panel.className = 'agent-dashboard-panel';
  // Insert right after the stats bar so it sits above wins/tasks/leads
  stats.insertAdjacentElement('afterend', panel);
}

function renderAgentDashboardPanel() {
  const sess = getSession();
  if (!sess || sess.type !== 'agent') return;
  const panel = document.getElementById('agentDashboardPanel');
  if (!panel) return;

  const allAgents = loadAgents().filter(a => a.active !== false);
  const me        = allAgents.find(a => a.id === sess.agentId) || {};
  const meM       = computeAgentMetrics(sess.agentId, 'month');
  const meAll     = computeAgentMetrics(sess.agentId, 'all');

  // Leaderboard rank for this month
  const ranked = allAgents
    .map(a => ({ a, m: computeAgentMetrics(a.id, 'month') }))
    .sort((x,y) => (y.m.revenueClosed - x.m.revenueClosed) || (y.m.dealsWon - x.m.dealsWon) || (y.m.tasksDone - x.m.tasksDone));
  const myRank = ranked.findIndex(r => r.a.id === sess.agentId) + 1;
  const totalRanked = ranked.length;

  // Today's status (with on-leave check)
  const leaves = loadLeaves();
  const today = new Date(); today.setHours(0,0,0,0);
  const onLeaveToday = leaves.some(L => {
    if (L.agentId !== sess.agentId) return false;
    const s = new Date(L.startDate); s.setHours(0,0,0,0);
    const e = new Date(L.endDate);   e.setHours(0,0,0,0);
    return today >= s && today <= e;
  });
  const status = onLeaveToday ? 'on_leave' : (me.availability || 'available');
  const av = availMeta(status);

  // Upcoming personal leaves
  const myUpcomingLeaves = leaves
    .filter(L => L.agentId === sess.agentId && new Date(L.endDate) >= today)
    .sort((a,b) => new Date(a.startDate) - new Date(b.startDate))
    .slice(0, 3);

  // Pipeline distribution (active leads only)
  const myLeads = loadLeads().filter(l => l.assignedTo === sess.agentId);
  const pipeline = ['new','contacted','meeting','qualified','proposal','negotiation']
    .map(stage => ({ stage, label: LEAD_STAGES[stage].label, icon: LEAD_STAGES[stage].icon, count: myLeads.filter(l => l.stage === stage).length }));
  const pipelineMax = Math.max(1, ...pipeline.map(p => p.count));

  // Overdue tasks count
  const overdueTasks = loadTasks().filter(t =>
    t.agentId === sess.agentId &&
    t.deadline && t.status !== 'done' && t.status !== 'cancelled' &&
    new Date(t.deadline) < new Date()
  ).length;

  // Rank chip color
  const rankIcon = myRank === 1 ? '👑' : myRank === 2 ? '🥈' : myRank === 3 ? '🥉' : '🎖️';

  panel.innerHTML = `
    <div class="dash-grid">

      <!-- Performance card -->
      <div class="dash-card dash-card-perf">
        <div class="dash-card-head">
          <div class="dash-card-title">📊 My Performance</div>
          <span class="dash-period">This Month</span>
        </div>
        <div class="dash-metrics">
          <div class="dash-metric">
            <div class="dash-metric-num">${meM.dealsWon}</div>
            <div class="dash-metric-lbl">Deals Won</div>
          </div>
          <div class="dash-metric">
            <div class="dash-metric-num">${meM.conversion}%</div>
            <div class="dash-metric-lbl">Conversion</div>
          </div>
          <div class="dash-metric">
            <div class="dash-metric-num">${meM.propertiesShown}</div>
            <div class="dash-metric-lbl">Properties Shown</div>
          </div>
          <div class="dash-metric">
            <div class="dash-metric-num">${meM.proposalsSent}</div>
            <div class="dash-metric-lbl">Proposals Sent</div>
          </div>
          <div class="dash-metric dash-metric-rev">
            <div class="dash-metric-num">${meM.revenueClosed ? 'AED '+num(meM.revenueClosed) : '—'}</div>
            <div class="dash-metric-lbl">Revenue Closed</div>
          </div>
          <div class="dash-metric">
            <div class="dash-metric-num">${meM.tasksDone}</div>
            <div class="dash-metric-lbl">Tasks Done</div>
          </div>
        </div>
        <div class="dash-alltime">
          <span>All time:</span>
          <span><strong>${meAll.dealsWon}</strong> won</span>
          <span><strong>${meAll.tasksDone}</strong> tasks done</span>
          <span><strong>${meAll.revenueClosed ? 'AED '+num(meAll.revenueClosed) : '—'}</strong> revenue</span>
        </div>
      </div>

      <!-- Rank + status card -->
      <div class="dash-card dash-card-rank">
        <div class="dash-card-head">
          <div class="dash-card-title">${rankIcon} Team Rank</div>
        </div>
        ${totalRanked > 0 ? `
        <div class="dash-rank-big">#${myRank}<span class="dash-rank-of">of ${totalRanked}</span></div>
        <div class="dash-rank-sub">${myRank === 1 ? 'You\'re leading the team this month.' : myRank <= 3 ? 'Top performer this month.' : 'Keep pushing — every deal counts.'}</div>
        ` : '<div class="dash-empty-mini">No team data yet.</div>'}

        <div class="dash-divider"></div>
        <div class="dash-card-title" style="font-size:13px;">📅 Today's Status</div>
        <div class="dash-status-row">
          <span class="agent-availability ${av.cls}">${av.icon} ${av.label}</span>
        </div>
        ${myUpcomingLeaves.length ? `
        <div class="dash-leaves">
          <div class="dash-leaves-label">🌴 Your upcoming leaves</div>
          ${myUpcomingLeaves.map(L => `<div class="dash-leave-row">${fmtDate(L.startDate)} → ${fmtDate(L.endDate)}${L.reason?' · '+h(L.reason):''}</div>`).join('')}
        </div>` : ''}
      </div>

      <!-- Pipeline card -->
      <div class="dash-card dash-card-pipe">
        <div class="dash-card-head">
          <div class="dash-card-title">🎯 My Pipeline</div>
          <span class="dash-period">${myLeads.filter(l => l.stage!=='won' && l.stage!=='lost').length} active</span>
        </div>
        <div class="dash-pipeline">
          ${pipeline.map(p => `
            <div class="dash-pipe-row">
              <span class="dash-pipe-label">${p.icon} ${p.label}</span>
              <div class="dash-pipe-track"><div class="dash-pipe-fill" style="width:${(p.count/pipelineMax)*100}%"></div></div>
              <span class="dash-pipe-count">${p.count}</span>
            </div>`).join('')}
        </div>
      </div>

      <!-- Today / alerts card -->
      <div class="dash-card dash-card-alerts">
        <div class="dash-card-head">
          <div class="dash-card-title">🔔 Today</div>
        </div>
        <div class="dash-alert-list">
          <div class="dash-alert-row ${meM.tasksActive ? 'dash-alert-info' : 'dash-alert-ok'}">
            <span>📋</span><div><strong>${meM.tasksActive}</strong> active task${meM.tasksActive===1?'':'s'}</div>
          </div>
          <div class="dash-alert-row ${overdueTasks ? 'dash-alert-danger' : 'dash-alert-ok'}">
            <span>⏰</span><div><strong>${overdueTasks}</strong> overdue</div>
          </div>
          <div class="dash-alert-row dash-alert-info">
            <span>👥</span><div><strong>${myLeads.filter(l => l.stage!=='won'&&l.stage!=='lost').length}</strong> active lead${myLeads.filter(l => l.stage!=='won'&&l.stage!=='lost').length===1?'':'s'}</div>
          </div>
        </div>
      </div>

    </div>
  `;
}

// Hook into the existing agent overview render
const _origRenderAgentOverview2 = renderAgentOverview;
renderAgentOverview = function() {
  _origRenderAgentOverview2();
  ensureAgentDashboardPanel();
  renderAgentDashboardPanel();
};

// ═══════════════════════════════════════════════════════
//  PROPOSALS — saved list, reprint, edit, delete
// ═══════════════════════════════════════════════════════

const PROPOSALS_KEY = 'asg_proposals';
function loadProposals()    { return _api.proposals.load(); }
function saveProposalsArr(a) { _api.proposals.save(a); }

function saveProposalRecord(data) {
  const items = loadProposals();
  const sess  = getSession();
  const author = sess?.type === 'agent'
    ? { id: sess.agentId, name: sess.name, type: 'agent' }
    : { id: '', name: 'Admin', type: 'admin' };
  const idx = items.findIndex(p => p.id === data.id);
  const record = {
    ...data,
    createdAt: idx > -1 ? items[idx].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: idx > -1 ? items[idx].createdBy : author
  };
  if (idx > -1) items[idx] = record; else items.unshift(record);
  saveProposalsArr(items);
}

function renderProposals() {
  const wrap = document.getElementById('proposalsList');
  if (!wrap) return;
  const sess = getSession();
  let items = loadProposals();
  // Agents only see their own; admin sees all
  if (sess?.type === 'agent') items = items.filter(p => p.createdBy?.id === sess.agentId);
  items = items.sort((a,b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

  if (!items.length) {
    wrap.innerHTML = `
      <div class="team-empty">
        <div class="empty-icon">📄</div>
        <p>No proposals yet. Click <strong>Create Proposal</strong> to make your first one.</p>
      </div>`;
    return;
  }

  const fmtDate2 = iso => iso ? new Date(iso).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  wrap.innerHTML = `
    <div class="proposals-table">
      <div class="prop-row prop-head">
        <span>Title</span>
        <span>Client</span>
        <span>Property</span>
        <span>Total (AED)</span>
        <span>Created</span>
        <span>Actions</span>
      </div>
      ${items.map(p => {
        const rentTotal = (p.cheques || []).reduce((s,c) => s + (Number(c.amount)||0), 0);
        const total = rentTotal + (Number(p.vatAmount)||0) + (Number(p.serviceAmount)||0)
                    + (Number(p.maintAmount)||0) + (Number(p.adminAmount)||0) + (Number(p.drecAmount)||0);
        return `
          <div class="prop-row">
            <span class="prop-title">${h(p.title || 'Untitled')}${p.ref ? `<span class="prop-ref">Ref: ${h(p.ref)}</span>` : ''}</span>
            <span>${h(p.client || '—')}${p.company ? `<span class="prop-sub">${h(p.company)}</span>` : ''}</span>
            <span>${h(p.propName || '—')}${p.propLocation ? `<span class="prop-sub">${h(p.propLocation)}</span>` : ''}</span>
            <span class="prop-total">${total ? 'AED ' + num(total) : '—'}</span>
            <span>${fmtDate2(p.createdAt)}<span class="prop-sub">${h(p.createdBy?.name || 'Admin')}</span></span>
            <span class="prop-actions">
              <button class="btn-sm btn-primary" onclick="reprintProposal('${p.id}')">🖨️ Print PDF</button>
              <button class="btn-sm btn-ghost"   onclick="editProposal('${p.id}')">✏️ Edit</button>
              <button class="btn-sm btn-danger"  onclick="deleteProposalRec('${p.id}')">🗑️</button>
            </span>
          </div>`;
      }).join('')}
    </div>`;
}

function reprintProposal(id) {
  const p = loadProposals().find(x => x.id === id);
  if (!p) return;
  printProposalDoc(p);
}

function editProposal(id) {
  const p = loadProposals().find(x => x.id === id);
  if (!p) return;
  openProposalModal();
  // Wait for modal init then populate
  setTimeout(() => { _hydrateProposalForm(p); }, 80);
}

function _hydrateProposalForm(p) {
  // Stash the id so save updates rather than creating a new record
  let edit = document.getElementById('pslEditId');
  if (!edit) {
    edit = document.createElement('input');
    edit.type = 'hidden';
    edit.id = 'pslEditId';
    document.getElementById('proposalModalOverlay')?.appendChild(edit);
  }
  edit.value = p.id;

  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
  set('pslTitle', p.title);            set('pslRef', p.ref);
  set('pslDate', p.date);              set('pslValidUntil', p.validUntil);
  set('pslPreparedBy', p.prepBy);
  set('pslPropLink', p.propLink);
  set('pslPropName', p.propName);      set('pslPropType', p.propType);
  set('pslPropLocation', p.propLocation); set('pslPropSize', p.propSize);
  set('pslClientName', p.client);      set('pslClientCompany', p.company);
  set('pslClientPhone', p.phone);      set('pslClientEmail', p.email);
  set('pslAnnualRent', p.rent);        set('pslLessorName', p.lessor);
  set('pslTenancyFrom', p.tenancyFrom); set('pslTenancyTo', p.tenancyTo);
  set('pslNumCheques', p.numCheques);
  set('pslVatAmount', p.vatAmount);    set('pslVatDate', p.vatDate);    set('pslVatPayable', p.vatPayable);
  set('pslServiceAmount', p.serviceAmount); set('pslServiceDate', p.serviceDate); set('pslServicePayable', p.servicePayable);
  set('pslMaintAmount', p.maintAmount); set('pslMaintDate', p.maintDate); set('pslMaintPayable', p.maintPayable);
  set('pslAdminAmount', p.adminAmount); set('pslAdminDate', p.adminDate); set('pslAdminPayable', p.adminPayable);
  set('pslDrecAmount', p.drecAmount);   set('pslDrecDate', p.drecDate);   set('pslDrecPayable', p.drecPayable);
  set('pslTerms', p.termsRaw);          set('pslNotes', p.notes);

  // Rebuild cheque rows then patch their values
  if (typeof renderProposalCheques === 'function') renderProposalCheques();
  const rows = document.querySelectorAll('#proposalChequeFields .psl-row');
  (p.cheques || []).forEach((c, i) => {
    const r = rows[i]; if (!r) return;
    const dEl = r.querySelector('.psl-date');    if (dEl) dEl.value = c.date    || '';
    const aEl = r.querySelector('.psl-amount');  if (aEl) aEl.value = c.amount  || '';
    const pEl = r.querySelector('.psl-payable'); if (pEl) pEl.value = c.payable || '';
  });
  if (typeof updateProposalGrandTotal === 'function') updateProposalGrandTotal();
  if (typeof updatePslRentTotal === 'function') updatePslRentTotal();
}

function deleteProposalRec(id) {
  if (!confirm('Delete this proposal? This cannot be undone.')) return;
  saveProposalsArr(loadProposals().filter(p => p.id !== id));
  renderProposals();
  showToast('Proposal deleted', 'success');
}

// Clear the edit-id flag whenever the modal is opened fresh
const _origOpenProposalModal = (typeof openProposalModal === 'function') ? openProposalModal : null;
if (_origOpenProposalModal) {
  openProposalModal = function() {
    const r = _origOpenProposalModal.apply(this, arguments);
    const edit = document.getElementById('pslEditId');
    if (edit) edit.value = '';
    return r;
  };
}

// Agent's existing proposals tab — render the saved list there too
const _origShowAgentTab2 = (typeof showAgentTab === 'function') ? showAgentTab : null;
if (_origShowAgentTab2) {
  showAgentTab = function(tab) {
    _origShowAgentTab2.apply(this, arguments);
    if (tab === 'proposals') {
      // Add a list container next to the existing launcher if not present
      const view = document.getElementById('agentTabProposals');
      if (view && !document.getElementById('proposalsList')) {
        const list = document.createElement('div');
        list.id = 'proposalsList';
        list.style.marginTop = '16px';
        view.appendChild(list);
      }
      renderProposals();
    }
  };
}

// ═══════════════════════════════════════════════════════
//  MEETINGS & VIEWINGS
// ═══════════════════════════════════════════════════════

const MEETINGS_KEY = 'asg_meetings';
function loadMeetings()    { return _api.meetings.load(); }
function saveMeetingsArr(a) { _api.meetings.save(a); }

const MTG_TYPE_META = {
  meeting: { icon:'🤝', label:'Meeting' },
  viewing: { icon:'🏗️', label:'Property Viewing' }
};
const MTG_STATUS_META = {
  scheduled: { icon:'⏰', label:'Scheduled', cls:'mtg-st-scheduled' },
  completed: { icon:'✅', label:'Completed', cls:'mtg-st-completed' },
  cancelled: { icon:'❌', label:'Cancelled', cls:'mtg-st-cancelled' },
  noshow:    { icon:'🚫', label:'No-show',   cls:'mtg-st-noshow'    }
};

// In-flight photo uploads while modal is open (before save)
let _meetingPendingPhotos = []; // { tempId, dataUrl, name }
let _meetingExistingPhotos = []; // { id, name } (already saved to idb)
let _meetingRemovedPhotos  = []; // ids to delete on save

function _agentMeetingsForSession() {
  const sess = getSession();
  const all = loadMeetings();
  if (!sess) return [];
  if (sess.type === 'agent') return all.filter(m => m.agentId === sess.agentId);
  return all;
}

function renderAgentMeetings() {
  const list = document.getElementById('agentMeetingsList');
  if (!list) return;
  const typeF   = (document.getElementById('mtgFilterType')?.value)   || '';
  const statusF = (document.getElementById('mtgFilterStatus')?.value) || '';
  let items = _agentMeetingsForSession();
  if (typeF)   items = items.filter(m => m.type   === typeF);
  if (statusF) items = items.filter(m => m.status === statusF);
  items = items.sort((a,b) => {
    const ad = new Date((a.date||'') + 'T' + (a.time||'00:00'));
    const bd = new Date((b.date||'') + 'T' + (b.time||'00:00'));
    return bd - ad;
  });

  if (!items.length) {
    list.innerHTML = `
      <div class="team-empty">
        <div class="empty-icon">📅</div>
        <p>No meetings or viewings yet. Click <strong>New Entry</strong> or push from a lead.</p>
      </div>`;
    return;
  }

  const leads = loadLeads();
  const props = loadProps();
  list.innerHTML = `<div class="meeting-list">${items.map(m => {
    const tm = MTG_TYPE_META[m.type] || MTG_TYPE_META.meeting;
    const sm = MTG_STATUS_META[m.status] || MTG_STATUS_META.scheduled;
    const lead = m.leadId ? leads.find(l => l.id === m.leadId) : null;
    const prop = m.propId ? props.find(p => p.id === m.propId) : null;
    const photoCount = (m.photos || []).length;
    const noteCount = (m.notes || []).length;
    const lastNote = noteCount ? m.notes[noteCount-1].text : '';
    return `
      <div class="meeting-card" onclick="openMeetingModal('${m.id}')">
        <div class="meeting-card-top">
          <div class="meeting-type-icon">${tm.icon}</div>
          <div class="meeting-card-body">
            <div class="meeting-card-row1">
              <span class="meeting-card-type">${tm.label}</span>
              <span class="meeting-status-pill ${sm.cls}">${sm.icon} ${sm.label}</span>
            </div>
            <div class="meeting-card-title">${lead ? h(lead.name) : (prop ? h(prop.name) : 'Untitled')}${lead && lead.company ? ' · ' + h(lead.company) : ''}</div>
            <div class="meeting-card-meta">
              ${m.date ? '📅 ' + fmtDate(m.date) : ''}${m.time ? ' · ' + m.time : ''}
              ${m.location ? ' · 📍 ' + h(m.location) : ''}
            </div>
            ${prop && !lead ? `<div class="meeting-card-meta">🏗️ ${h(prop.name)}${prop.location ? ' — '+h(prop.location) : ''}</div>` : ''}
            ${prop && lead ? `<div class="meeting-card-meta">🏗️ ${h(prop.name)}</div>` : ''}
            ${lastNote ? `<div class="meeting-card-note">"${h(lastNote.length > 90 ? lastNote.slice(0,88)+'…' : lastNote)}"</div>` : ''}
            <div class="meeting-card-foot">
              ${photoCount ? `<span>📷 ${photoCount} photo${photoCount>1?'s':''}</span>` : ''}
              ${noteCount  ? `<span>💬 ${noteCount} note${noteCount>1?'s':''}</span>`   : ''}
            </div>
          </div>
        </div>
      </div>`;
  }).join('')}</div>`;
}

function openMeetingModal(id, presetLeadId) {
  _meetingPendingPhotos = [];
  _meetingExistingPhotos = [];
  _meetingRemovedPhotos = [];

  const m = id ? loadMeetings().find(x => x.id === id) : null;
  document.getElementById('meetingModalTitle').textContent = m ? 'Edit Entry' : 'New Meeting / Viewing';
  document.getElementById('meetingId').value = m ? m.id : '';

  // Populate lead dropdown
  const leadSel = document.getElementById('meetingLead');
  const sess = getSession();
  let leads = loadLeads();
  if (sess?.type === 'agent') leads = leads.filter(l => l.assignedTo === sess.agentId);
  leadSel.innerHTML = '<option value="">— No lead linked —</option>' +
    leads.map(l => `<option value="${l.id}">${h(l.name)}${l.company ? ' · '+h(l.company) : ''}</option>`).join('');

  // Populate prop dropdown
  const propSel = document.getElementById('meetingProp');
  const props = loadProps();
  propSel.innerHTML = '<option value="">— No property —</option>' +
    props.map(p => `<option value="${p.id}">${h(p.name)}${p.location ? ' — '+h(p.location) : ''}</option>`).join('');

  if (m) {
    document.getElementById('meetingType').value     = m.type     || 'meeting';
    document.getElementById('meetingStatus').value   = m.status   || 'scheduled';
    document.getElementById('meetingLead').value     = m.leadId   || '';
    document.getElementById('meetingProp').value     = m.propId   || '';
    document.getElementById('meetingDate').value     = m.date     || '';
    document.getElementById('meetingTime').value     = m.time     || '';
    document.getElementById('meetingLocation').value = m.location || '';
    const lastNote = (m.notes && m.notes.length) ? m.notes[m.notes.length-1].text : '';
    document.getElementById('meetingNotes').value    = lastNote;
    _meetingExistingPhotos = (m.photos || []).map(ph => ({ ...ph, _existing: true }));
    document.getElementById('meetingDeleteBtn').style.display = '';
  } else {
    document.getElementById('meetingType').value     = 'meeting';
    document.getElementById('meetingStatus').value   = 'scheduled';
    document.getElementById('meetingLead').value     = presetLeadId || '';
    document.getElementById('meetingProp').value     = '';
    document.getElementById('meetingDate').value     = new Date().toISOString().split('T')[0];
    document.getElementById('meetingTime').value     = '';
    document.getElementById('meetingLocation').value = '';
    document.getElementById('meetingNotes').value    = '';
    document.getElementById('meetingDeleteBtn').style.display = 'none';

    // If pre-filled from a lead, auto-pick a sensible type (viewing if lead's stage suggests)
    if (presetLeadId) {
      const l = leads.find(x => x.id === presetLeadId);
      if (l && (l.stage === 'meeting' || l.stage === 'qualified')) {
        document.getElementById('meetingType').value = 'viewing';
      }
    }
  }

  renderMeetingPhotoGrid();
  document.getElementById('meetingModalOverlay').classList.add('active');
}

function closeMeetingModal() {
  document.getElementById('meetingModalOverlay').classList.remove('active');
  _meetingPendingPhotos = [];
  _meetingExistingPhotos = [];
  _meetingRemovedPhotos = [];
}

function handleMeetingPhotos(e) {
  const files = Array.from(e.target.files || []);
  files.forEach(file => {
    if (file.size > 10 * 1024 * 1024) { showToast(`${file.name} too large (max 10 MB)`, 'error'); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      _meetingPendingPhotos.push({
        tempId: 'tmp_' + Math.random().toString(36).slice(2),
        dataUrl: ev.target.result,
        name: file.name
      });
      renderMeetingPhotoGrid();
    };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
}

async function renderMeetingPhotoGrid() {
  const grid = document.getElementById('meetingPhotoGrid');
  const count = document.getElementById('meetingPhotoCount');
  if (!grid) return;
  grid.innerHTML = '';

  // Existing photos: load from IDB
  for (const ph of _meetingExistingPhotos) {
    if (_meetingRemovedPhotos.includes(ph.id)) continue;
    const rec = await idbGet(ph.id).catch(() => null);
    if (!rec) continue;
    const tile = document.createElement('div');
    tile.className = 'meeting-photo-tile';
    tile.innerHTML = `
      <img src="${rec.data}" alt="${h(ph.name)}">
      <button type="button" class="meeting-photo-remove" onclick="event.stopPropagation();_removeMeetingPhoto('${ph.id}',true)">×</button>`;
    grid.appendChild(tile);
  }
  // Pending photos
  _meetingPendingPhotos.forEach(ph => {
    const tile = document.createElement('div');
    tile.className = 'meeting-photo-tile meeting-photo-tile-pending';
    tile.innerHTML = `
      <img src="${ph.dataUrl}" alt="${h(ph.name)}">
      <button type="button" class="meeting-photo-remove" onclick="event.stopPropagation();_removeMeetingPhoto('${ph.tempId}',false)">×</button>`;
    grid.appendChild(tile);
  });

  const total = _meetingExistingPhotos.filter(p => !_meetingRemovedPhotos.includes(p.id)).length + _meetingPendingPhotos.length;
  if (count) count.textContent = total ? `${total} photo${total>1?'s':''}` : 'No photos yet';
}

function _removeMeetingPhoto(id, existing) {
  if (existing) {
    _meetingRemovedPhotos.push(id);
  } else {
    _meetingPendingPhotos = _meetingPendingPhotos.filter(p => p.tempId !== id);
  }
  renderMeetingPhotoGrid();
}

async function saveMeeting() {
  const sess = getSession();
  const id = document.getElementById('meetingId').value;
  const meetings = loadMeetings();
  const existing = id ? meetings.find(m => m.id === id) : null;

  const author = sess?.type === 'agent'
    ? { id: sess.agentId, name: sess.name }
    : { id: '', name: 'Admin' };

  // Persist new photos to IndexedDB
  const finalPhotos = (existing?.photos || []).filter(ph => !_meetingRemovedPhotos.includes(ph.id));
  for (const tmp of _meetingPendingPhotos) {
    const photoId = 'mtgph_' + Math.random().toString(36).slice(2);
    // dataUrl → Blob
    const resp = await fetch(tmp.dataUrl);
    const blob = await resp.blob();
    await idbPut(photoId, blob);
    finalPhotos.push({ id: photoId, name: tmp.name });
  }
  // Delete removed photos from IDB
  for (const removeId of _meetingRemovedPhotos) {
    try { await idbDelete(removeId); } catch {}
  }

  const noteText = document.getElementById('meetingNotes').value.trim();
  const notes = (existing?.notes || []).slice();
  if (noteText) {
    const lastNote = notes.length ? notes[notes.length-1] : null;
    if (!lastNote || lastNote.text !== noteText) {
      notes.push({ text: noteText, date: new Date().toISOString(), authorId: author.id, authorName: author.name });
    }
  }

  const status = document.getElementById('meetingStatus').value;
  const prevStatus = existing?.status;
  const record = {
    id: id || ('mtg_' + uid()),
    type:     document.getElementById('meetingType').value,
    status,
    leadId:   document.getElementById('meetingLead').value || '',
    propId:   document.getElementById('meetingProp').value || '',
    date:     document.getElementById('meetingDate').value || '',
    time:     document.getElementById('meetingTime').value || '',
    location: document.getElementById('meetingLocation').value.trim(),
    notes,
    photos:   finalPhotos,
    agentId:  existing?.agentId  || author.id || (sess?.agentId || ''),
    agentName:existing?.agentName|| author.name,
    createdAt:existing?.createdAt|| new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };

  const idx = meetings.findIndex(m => m.id === record.id);
  if (idx > -1) meetings[idx] = record; else meetings.unshift(record);
  saveMeetingsArr(meetings);

  // Auto-log to linked lead's activity
  if (record.leadId) {
    const tm = MTG_TYPE_META[record.type] || MTG_TYPE_META.meeting;
    const sm = MTG_STATUS_META[record.status] || MTG_STATUS_META.scheduled;
    let activityNote;
    if (!existing) {
      activityNote = `${tm.label} scheduled for ${record.date || 'TBD'}${record.time?' '+record.time:''}${record.location?' at '+record.location:''}.`;
    } else if (prevStatus !== status) {
      activityNote = `${tm.label} marked ${sm.label.toLowerCase()}.${noteText ? ' Outcome: '+noteText : ''}`;
    } else if (noteText && (!existing.notes?.length || existing.notes[existing.notes.length-1].text !== noteText)) {
      activityNote = `${tm.label} update — ${noteText}`;
    }
    if (activityNote) {
      const leads = loadLeads();
      const lead = leads.find(l => l.id === record.leadId);
      if (lead) {
        if (!lead.activities) lead.activities = [];
        lead.activities.push({
          id: 'act_' + uid(),
          type: record.type === 'viewing' ? 'meeting' : 'meeting',
          note: activityNote,
          date: new Date().toISOString(),
          byAgentId:   author.id,
          byAgentName: author.name,
          authorType:  sess?.type || 'admin',
          authorName:  author.name
        });
        lead.updatedAt = new Date().toISOString();
        saveLeads(leads);
      }
    }
  }

  closeMeetingModal();
  showToast(existing ? 'Updated' : 'Saved', 'success');
  if (typeof renderAgentMeetings === 'function') renderAgentMeetings();
  if (typeof updateAgentBadges === 'function') updateAgentBadges();
  if (typeof renderTeamTab === 'function' && isAdminUser()) renderTeamTab();
}

async function deleteMeeting() {
  const id = document.getElementById('meetingId').value;
  if (!id) return;
  if (!confirm('Delete this entry? Photos will also be removed.')) return;
  const meetings = loadMeetings();
  const m = meetings.find(x => x.id === id);
  if (m) {
    for (const ph of (m.photos || [])) {
      try { await idbDelete(ph.id); } catch {}
    }
  }
  saveMeetingsArr(meetings.filter(x => x.id !== id));
  closeMeetingModal();
  showToast('Deleted', 'success');
  if (typeof renderAgentMeetings === 'function') renderAgentMeetings();
  if (typeof updateAgentBadges === 'function') updateAgentBadges();
}

// idbDelete shim — uses existing idb infra; if missing, simulate via overwrite.
async function idbDelete(key) {
  try {
    if (typeof idbDel === 'function') return idbDel(key);
    if (typeof _idbDelete === 'function') return _idbDelete(key);
  } catch {}
  // Fallback: open db directly
  return new Promise((resolve) => {
    const req = indexedDB.open('asg_files', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
}

// Wire showAgentTab to render meetings + add to AGENT_TABS allowlist
const _origShowAgentTab3 = (typeof showAgentTab === 'function') ? showAgentTab : null;
if (_origShowAgentTab3) {
  if (typeof AGENT_TABS !== 'undefined' && !AGENT_TABS.includes('meetings')) {
    AGENT_TABS.push('meetings');
  }
  showAgentTab = function(tab) {
    _origShowAgentTab3.apply(this, arguments);
    if (tab === 'meetings') renderAgentMeetings();
  };
}

// Update the agent meetings count badge
const _origUpdateAgentBadges = (typeof updateAgentBadges === 'function') ? updateAgentBadges : null;
if (_origUpdateAgentBadges) {
  updateAgentBadges = function() {
    _origUpdateAgentBadges.apply(this, arguments);
    const sess = getSession();
    if (!sess || sess.type !== 'agent') return;
    const my = loadMeetings().filter(m => m.agentId === sess.agentId && m.status === 'scheduled');
    const el = document.getElementById('agentMeetingCount');
    if (el) el.textContent = my.length || '';
  };
}

// Inject "Schedule Meeting / Viewing" buttons into the lead detail modal
const _origOpenLeadDetail2 = (typeof openLeadDetail === 'function') ? openLeadDetail : null;
if (_origOpenLeadDetail2) {
  openLeadDetail = function(id) {
    _origOpenLeadDetail2.apply(this, arguments);
    setTimeout(() => {
      const adminDiv = document.getElementById('leadDetailAdminActions');
      if (!adminDiv) return;
      // Avoid duplicate insertion
      if (adminDiv.querySelector('[data-mtg-push]')) return;
      const btn1 = document.createElement('button');
      btn1.className = 'btn-sm btn-primary';
      btn1.dataset.mtgPush = '1';
      btn1.innerHTML = '🤝 Schedule Meeting';
      btn1.onclick = () => { closeLeadDetail(); openMeetingModal(null, id); document.getElementById('meetingType').value = 'meeting'; };
      const btn2 = document.createElement('button');
      btn2.className = 'btn-sm btn-primary';
      btn2.dataset.mtgPush = '1';
      btn2.innerHTML = '🏗️ Schedule Viewing';
      btn2.onclick = () => { closeLeadDetail(); openMeetingModal(null, id); document.getElementById('meetingType').value = 'viewing'; };
      adminDiv.appendChild(btn1);
      adminDiv.appendChild(btn2);
    }, 50);
  };
}

// ═══════════════════════════════════════════════════════
//  OFF-PLAN — UAE Developers & Projects catalog
// ═══════════════════════════════════════════════════════

const OFFPLAN_DEVS_KEY = 'asg_offplan_developers';
const OFFPLAN_PROJ_KEY = 'asg_offplan_projects';

function loadDevelopers()  { return _api.offplanDevs.load(); }
function saveDevelopers(a) { _api.offplanDevs.save(a); }
function loadProjects()    { return _api.offplanProjects.load(); }
function saveProjects(a)   { _api.offplanProjects.save(a); }

const PROJECT_STATUS_META = {
  prelaunch:    { icon:'⏳', label:'Pre-launch',         cls:'op-st-prelaunch'    },
  launched:     { icon:'🚀', label:'Launched',           cls:'op-st-launched'     },
  construction: { icon:'🏗️', label:'Under Construction', cls:'op-st-construction' },
  ready:        { icon:'✅', label:'Ready',              cls:'op-st-ready'        },
  soldout:      { icon:'🔒', label:'Sold Out',           cls:'op-st-soldout'      }
};
const PROJECT_TYPE_META = {
  apartments:  { icon:'🏢', label:'Apartments'  },
  villas:      { icon:'🏠', label:'Villas'      },
  townhouses:  { icon:'🏘️', label:'Townhouses'  },
  offices:     { icon:'🏢', label:'Offices'     },
  mixed:       { icon:'🏙️', label:'Mixed-use'   },
  hotel:       { icon:'🏨', label:'Hotel/Branded'}
};

// Seed major UAE developers on first run (only if list is empty)
// DISABLED — seedDevelopers used to fire at page-load before auth, causing
// 20 401 POSTs every time the cache was empty. Developers are now created
// via the dashboard or directly in the DB. To re-enable seeding, do it as
// an admin-only one-shot button in the Off-plan tab.
(function seedDevelopers_DISABLED() {
  return;
  if (loadDevelopers().length) return;
  const seed = [
    { name:'Emaar Properties',       region:'Dubai',     website:'https://www.emaar.com' },
    { name:'DAMAC Properties',       region:'Dubai',     website:'https://www.damacproperties.com' },
    { name:'Sobha Realty',           region:'Dubai',     website:'https://www.sobharealty.com' },
    { name:'Nakheel',                region:'Dubai',     website:'https://www.nakheel.com' },
    { name:'Meraas',                 region:'Dubai',     website:'https://www.meraas.com' },
    { name:'Dubai Properties',       region:'Dubai',     website:'https://www.dp.ae' },
    { name:'Aldar Properties',       region:'Abu Dhabi', website:'https://www.aldar.com' },
    { name:'Azizi Developments',     region:'Dubai',     website:'https://www.azizidevelopments.com' },
    { name:'Danube Properties',      region:'Dubai',     website:'https://www.danubeproperties.ae' },
    { name:'Binghatti Developers',   region:'Dubai',     website:'https://www.binghatti.com' },
    { name:'Ellington Properties',   region:'Dubai',     website:'https://www.ellingtonproperties.ae' },
    { name:'Select Group',           region:'Dubai',     website:'https://www.select-group.ae' },
    { name:'MAG Property Development',region:'Dubai',    website:'https://www.mag.ae' },
    { name:'Omniyat',                region:'Dubai',     website:'https://www.omniyat.com' },
    { name:'Wasl Properties',        region:'Dubai',     website:'https://www.wasl.ae' },
    { name:'Deyaar Development',     region:'Dubai',     website:'https://www.deyaar.ae' },
    { name:'Tiger Properties',       region:'Dubai',     website:'https://www.tigerproperties.com' },
    { name:'Arada',                  region:'Sharjah',   website:'https://www.arada.com' },
    { name:'RAK Properties',         region:'Ras Al Khaimah', website:'https://www.rakproperties.net' },
    { name:'Iman Developers',        region:'Dubai',     website:'' }
  ].map(d => ({
    id: 'dev_' + Math.random().toString(36).slice(2),
    name: d.name, region: d.region, website: d.website || '',
    brief: '', logo: null,
    dataSource: 'seed',
    createdAt: new Date().toISOString()
  }));
  saveDevelopers(seed);
})();

// ─── Navigation state ─────────────────────────────
let _opView = 'developers';        // 'developers' | 'projects' | 'project'
let _opCurrentDevId = '';
let _opCurrentProjectId = '';
let _opSearch = '';

// In-flight project edit state
let _projectPendingPhotos = [];
let _projectExistingPhotos = [];
let _projectRemovedPhotos = [];
let _projectPendingBrochure = null;
let _projectExistingBrochure = null;

function _opIsAgent()  { const s = getSession(); return s?.type === 'agent'; }
function _opCanEdit()  { return isAdminUser(); } // Only admin can add/edit/delete; agents browse + share

function _opMount() {
  if (_opIsAgent()) return { content: document.getElementById('offplanContentAgent'), bc: document.getElementById('opBreadcrumbAgent') };
  return { content: document.getElementById('offplanContent'), bc: document.getElementById('opBreadcrumb') };
}

function renderOffplan() {
  const { content, bc } = _opMount();
  if (!content || !bc) return;
  // Breadcrumb
  const devs = loadDevelopers();
  const projects = loadProjects();
  let crumb = `<a class="op-crumb-link" onclick="_opGo('developers')">Developers</a>`;
  if (_opView === 'projects' || _opView === 'project') {
    const dev = devs.find(d => d.id === _opCurrentDevId);
    crumb += ` <span class="op-crumb-sep">›</span> <a class="op-crumb-link" onclick="_opGo('projects','${_opCurrentDevId}')">${h(dev?.name || 'Developer')}</a>`;
  }
  if (_opView === 'project') {
    const p = projects.find(x => x.id === _opCurrentProjectId);
    crumb += ` <span class="op-crumb-sep">›</span> <span class="op-crumb-current">${h(p?.name || 'Project')}</span>`;
  }
  bc.innerHTML = crumb;

  if (_opView === 'developers')      _renderDevelopersGrid(content);
  else if (_opView === 'projects')   _renderProjectsGrid(content);
  else if (_opView === 'project')    _renderProjectDetail(content);
}

function _opGo(view, devId, projectId) {
  _opView = view;
  if (devId !== undefined) _opCurrentDevId = devId;
  if (projectId !== undefined) _opCurrentProjectId = projectId;
  renderOffplan();
}

// ─── Developers grid ──────────────────────────────
function _renderDevelopersGrid(content) {
  const devs = loadDevelopers();
  const projects = loadProjects();
  const search = (_opSearch || '').trim().toLowerCase();
  const filtered = search ? devs.filter(d => d.name.toLowerCase().includes(search) || (d.region||'').toLowerCase().includes(search)) : devs;
  filtered.sort((a,b) => a.name.localeCompare(b.name));

  content.innerHTML = `
    <div class="tab-page-header">
      <div>
        <h1 class="tab-page-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/></svg>
          Off-Plan Developers
        </h1>
        <p class="tab-page-sub">Browse UAE developers and their off-plan project launches</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input type="text" class="filter-select" id="opSearch" placeholder="Search developers…" value="${h(_opSearch)}" oninput="_opSearch=this.value;_renderDevelopersGrid(_opMount().content);" style="width:220px;">
        ${_opCanEdit() ? `
          <button class="btn-ghost" onclick="openExcelImport('projects')">📥 Import Projects</button>
          <button class="btn-primary" onclick="openDeveloperModal()">+ Add Developer</button>
        ` : ''}
      </div>
    </div>

    <div class="op-dev-grid">
      ${filtered.length === 0 ? `<div class="team-empty"><div class="empty-icon">🏛️</div><p>No developers match "${h(_opSearch)}".</p></div>` : filtered.map(d => {
        const projectCount = projects.filter(p => p.devId === d.id).length;
        const initial = (d.name || '?').charAt(0).toUpperCase();
        return `
          <div class="op-dev-card" onclick="_opGo('projects','${d.id}')">
            <div class="op-dev-logo">
              ${d.logo ? `<img src="${d.logo}" alt="${h(d.name)}">` : `<span class="op-dev-initial">${initial}</span>`}
            </div>
            <div class="op-dev-body">
              <div class="op-dev-name">${h(d.name)}</div>
              <div class="op-dev-region">📍 ${h(d.region || 'UAE')}</div>
              <div class="op-dev-count">${projectCount} project${projectCount===1?'':'s'}</div>
            </div>
            ${_opCanEdit() ? `<button class="op-edit-btn" onclick="event.stopPropagation();openDeveloperModal('${d.id}')">✏️</button>` : ''}
          </div>`;
      }).join('')}
    </div>
  `;
}

// ─── Projects grid ────────────────────────────────
function _renderProjectsGrid(content) {
  const dev = loadDevelopers().find(d => d.id === _opCurrentDevId);
  if (!dev) { _opGo('developers'); return; }
  const projects = loadProjects().filter(p => p.devId === dev.id)
    .sort((a,b) => (a.name||'').localeCompare(b.name||''));

  content.innerHTML = `
    <div class="tab-page-header">
      <div>
        <h1 class="tab-page-title">${h(dev.name)} — Projects</h1>
        <p class="tab-page-sub">${h(dev.region || 'UAE')}${dev.website ? ` · <a href="${dev.website}" target="_blank" style="color:var(--gold);">${h(dev.website.replace(/^https?:\/\//,''))}</a>` : ''}</p>
      </div>
      <div style="display:flex;gap:8px;">
        ${_opCanEdit() ? `<button class="btn-primary" onclick="openProjectModal()">+ Add Project</button>` : ''}
      </div>
    </div>
    ${dev.brief ? `<div class="op-dev-brief">${h(dev.brief)}</div>` : ''}

    <div class="op-proj-grid">
      ${projects.length === 0 ? `
        <div class="team-empty">
          <div class="empty-icon">🏗️</div>
          <p>No projects yet for ${h(dev.name)}.</p>
          ${_opCanEdit() ? '<p style="font-size:12px;">Click <strong>+ Add Project</strong> to add one.</p>' : ''}
        </div>` : projects.map(p => {
        const sm = PROJECT_STATUS_META[p.status] || PROJECT_STATUS_META.launched;
        const tm = PROJECT_TYPE_META[p.type] || PROJECT_TYPE_META.apartments;
        const cover = (p.photos && p.photos.length) ? p.photos[0].dataUrl : null;
        return `
          <div class="op-proj-card" onclick="_opGo('project',undefined,'${p.id}')">
            <div class="op-proj-cover" ${cover ? `style="background-image:url('${cover}')"` : ''}>
              ${!cover ? `<span class="op-proj-cover-placeholder">${tm.icon}</span>` : ''}
              <span class="op-proj-status-pill ${sm.cls}">${sm.icon} ${sm.label}</span>
            </div>
            <div class="op-proj-body">
              <div class="op-proj-name">${h(p.name || 'Untitled')}</div>
              <div class="op-proj-meta">${tm.icon} ${tm.label}${p.location ? ' · 📍 '+h(p.location) : ''}</div>
              ${p.priceFrom ? `<div class="op-proj-price">From AED ${num(p.priceFrom)}${p.priceTo ? ' — '+num(p.priceTo) : ''}</div>` : ''}
              ${p.handoverDate ? `<div class="op-proj-handover">Handover: ${fmtDate(p.handoverDate)}</div>` : ''}
            </div>
          </div>`;
      }).join('')}
    </div>
  `;
}

// ─── Project detail ───────────────────────────────
function _renderProjectDetail(content) {
  const projects = loadProjects();
  const p = projects.find(x => x.id === _opCurrentProjectId);
  if (!p) { _opGo('projects', _opCurrentDevId); return; }
  const dev = loadDevelopers().find(d => d.id === p.devId);
  const sm = PROJECT_STATUS_META[p.status] || PROJECT_STATUS_META.launched;
  const tm = PROJECT_TYPE_META[p.type] || PROJECT_TYPE_META.apartments;
  const amenities = (p.amenities || '').split(',').map(s => s.trim()).filter(Boolean);

  content.innerHTML = `
    <div class="op-detail">
      <div class="op-detail-head">
        <div>
          <div class="op-detail-dev">${h(dev?.name || '')}</div>
          <h1 class="op-detail-name">${h(p.name)}</h1>
          <div class="op-detail-meta">
            <span class="op-proj-status-pill ${sm.cls}">${sm.icon} ${sm.label}</span>
            <span>${tm.icon} ${tm.label}</span>
            ${p.location ? `<span>📍 ${h(p.location)}</span>` : ''}
          </div>
        </div>
        <div class="op-detail-actions">
          <button class="btn-primary" onclick="downloadProjectPDF('${p.id}')">📄 Download PDF</button>
          <button class="btn-ghost" onclick="shareProject('${p.id}')">📤 Share with Client</button>
          ${_opCanEdit() ? `<button class="btn-ghost" onclick="openProjectModal('${p.id}')">✏️ Edit</button>` : ''}
        </div>
      </div>

      ${p.photos && p.photos.length ? `
        <div class="op-photo-gallery">
          ${p.photos.map((ph, i) => `<div class="op-photo-tile" onclick="_opLightbox('${p.id}',${i})"><img src="${ph.dataUrl}" alt=""></div>`).join('')}
        </div>` : ''}

      <div class="op-detail-grid">
        <div class="op-detail-block">
          <div class="op-detail-block-h">💰 Pricing</div>
          <div class="op-detail-rows">
            ${p.priceFrom ? `<div class="op-row"><span>Price From</span><strong>AED ${num(p.priceFrom)}</strong></div>` : ''}
            ${p.priceTo   ? `<div class="op-row"><span>Price To</span><strong>AED ${num(p.priceTo)}</strong></div>` : ''}
            ${p.unitMix   ? `<div class="op-row"><span>Unit Mix</span><strong>${h(p.unitMix)}</strong></div>` : ''}
            ${p.paymentPlan ? `<div class="op-row op-row-multi"><span>Payment Plan</span><strong>${h(p.paymentPlan)}</strong></div>` : ''}
          </div>
        </div>
        <div class="op-detail-block">
          <div class="op-detail-block-h">📅 Timeline</div>
          <div class="op-detail-rows">
            ${p.launchDate   ? `<div class="op-row"><span>Launch Date</span><strong>${fmtDate(p.launchDate)}</strong></div>` : ''}
            ${p.handoverDate ? `<div class="op-row"><span>Handover</span><strong>${fmtDate(p.handoverDate)}</strong></div>` : ''}
            ${dev?.website   ? `<div class="op-row op-row-multi"><span>Developer</span><strong><a href="${dev.website}" target="_blank" style="color:var(--gold);">${h(dev.name)} ↗</a></strong></div>` : ''}
          </div>
        </div>
      </div>

      ${p.description ? `
        <div class="op-detail-block">
          <div class="op-detail-block-h">📝 About the Project</div>
          <div class="op-detail-text">${h(p.description)}</div>
        </div>` : ''}

      ${amenities.length ? `
        <div class="op-detail-block">
          <div class="op-detail-block-h">✨ Amenities</div>
          <div class="op-amenity-grid">
            ${amenities.map(a => `<span class="op-amenity">${h(a)}</span>`).join('')}
          </div>
        </div>` : ''}

      ${p.brochure ? `
        <div class="op-detail-block">
          <div class="op-detail-block-h">📁 Brochure</div>
          <a href="${p.brochure.dataUrl}" target="_blank" download="${h(p.brochure.name)}" class="op-brochure-link">📄 ${h(p.brochure.name)}</a>
        </div>` : ''}
    </div>
  `;
}

// ─── Developer modal ──────────────────────────────
function openDeveloperModal(id) {
  const dev = id ? loadDevelopers().find(d => d.id === id) : null;
  document.getElementById('developerModalTitle').textContent = dev ? 'Edit Developer' : 'Add Developer';
  document.getElementById('developerId').value     = dev ? dev.id : '';
  document.getElementById('developerName').value   = dev ? dev.name    : '';
  document.getElementById('developerRegion').value = dev ? (dev.region||'Dubai') : 'Dubai';
  document.getElementById('developerWebsite').value= dev ? (dev.website||'') : '';
  document.getElementById('developerBrief').value  = dev ? (dev.brief||'')   : '';
  const preview = document.getElementById('developerLogoPreview');
  preview.innerHTML = dev?.logo ? `<img src="${dev.logo}" style="max-width:80px;max-height:80px;border-radius:4px;border:1px solid var(--border);">` : '';
  document.getElementById('developerLogo').value = '';
  document.getElementById('developerDeleteBtn').style.display = dev ? '' : 'none';

  // Logo preview on upload
  document.getElementById('developerLogo').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader(); r.onload = ev => { preview.innerHTML = `<img src="${ev.target.result}" style="max-width:80px;max-height:80px;border-radius:4px;border:1px solid var(--border);">`; preview.dataset.dataUrl = ev.target.result; };
    r.readAsDataURL(f);
  };
  preview.dataset.dataUrl = dev?.logo || '';
  document.getElementById('developerModalOverlay').classList.add('active');
}
function closeDeveloperModal() { document.getElementById('developerModalOverlay').classList.remove('active'); }

function saveDeveloper() {
  const id    = document.getElementById('developerId').value;
  const name  = document.getElementById('developerName').value.trim();
  const region= document.getElementById('developerRegion').value;
  const website = document.getElementById('developerWebsite').value.trim();
  const brief = document.getElementById('developerBrief').value.trim();
  const logo  = document.getElementById('developerLogoPreview').dataset.dataUrl || '';
  if (!name) { showToast('Developer name is required', 'error'); return; }
  const devs = loadDevelopers();
  if (id) {
    const idx = devs.findIndex(d => d.id === id);
    if (idx > -1) devs[idx] = { ...devs[idx], name, region, website, brief, logo };
  } else {
    devs.unshift({
      id: 'dev_' + Math.random().toString(36).slice(2),
      name, region, website, brief, logo,
      dataSource: 'manual',
      createdAt: new Date().toISOString()
    });
  }
  saveDevelopers(devs);
  closeDeveloperModal();
  showToast('Developer saved', 'success');
  renderOffplan();
}

function deleteDeveloper() {
  const id = document.getElementById('developerId').value;
  if (!id) return;
  const projectCount = loadProjects().filter(p => p.devId === id).length;
  const msg = projectCount
    ? `Delete this developer? ${projectCount} associated project${projectCount>1?'s':''} will also be deleted.`
    : 'Delete this developer?';
  if (!confirm(msg)) return;
  saveDevelopers(loadDevelopers().filter(d => d.id !== id));
  saveProjects(loadProjects().filter(p => p.devId !== id));
  closeDeveloperModal();
  if (_opCurrentDevId === id) _opGo('developers');
  showToast('Developer deleted', 'success');
  renderOffplan();
}

// ─── Project modal ────────────────────────────────
function openProjectModal(id) {
  const p = id ? loadProjects().find(x => x.id === id) : null;
  const devs = loadDevelopers();
  const dev = devs.find(d => d.id === (p ? p.devId : _opCurrentDevId));

  document.getElementById('projectModalTitle').textContent = p ? 'Edit Project' : 'Add Project';
  document.getElementById('projectModalSubtitle').textContent = dev ? `Under ${dev.name}` : 'Off-plan project details';
  document.getElementById('projectId').value    = p ? p.id : '';
  document.getElementById('projectDevId').value = p ? p.devId : (_opCurrentDevId || '');

  document.getElementById('projectName').value         = p ? (p.name||'')         : '';
  document.getElementById('projectStatus').value       = p ? (p.status||'launched'): 'launched';
  document.getElementById('projectType').value         = p ? (p.type||'apartments'): 'apartments';
  document.getElementById('projectLocation').value     = p ? (p.location||'')     : '';
  document.getElementById('projectUnitMix').value      = p ? (p.unitMix||'')      : '';
  document.getElementById('projectLaunchDate').value   = p ? (p.launchDate||'')   : '';
  document.getElementById('projectHandoverDate').value = p ? (p.handoverDate||'') : '';
  document.getElementById('projectPriceFrom').value    = p ? (p.priceFrom||'')    : '';
  document.getElementById('projectPriceTo').value      = p ? (p.priceTo||'')      : '';
  document.getElementById('projectPaymentPlan').value  = p ? (p.paymentPlan||'')  : '';
  document.getElementById('projectAmenities').value    = p ? (p.amenities||'')    : '';
  document.getElementById('projectDescription').value  = p ? (p.description||'')  : '';

  _projectPendingPhotos = [];
  _projectExistingPhotos = (p?.photos || []).slice();
  _projectRemovedPhotos = [];
  _projectPendingBrochure = null;
  _projectExistingBrochure = p?.brochure || null;

  renderProjectPhotoGrid();
  document.getElementById('projectBrochureName').textContent = _projectExistingBrochure ? `Current: ${_projectExistingBrochure.name}` : '';
  document.getElementById('projectBrochureInput').value = '';
  document.getElementById('projectDeleteBtn').style.display = p ? '' : 'none';
  document.getElementById('projectModalOverlay').classList.add('active');
}
function closeProjectModal() {
  document.getElementById('projectModalOverlay').classList.remove('active');
  _projectPendingPhotos = [];
  _projectExistingPhotos = [];
  _projectRemovedPhotos = [];
  _projectPendingBrochure = null;
}

function handleProjectPhotos(e) {
  const files = Array.from(e.target.files || []);
  files.forEach(file => {
    if (file.size > 10 * 1024 * 1024) { showToast(`${file.name} too large (max 10 MB)`, 'error'); return; }
    const r = new FileReader();
    r.onload = ev => {
      _projectPendingPhotos.push({ tempId: 'tmp_' + Math.random().toString(36).slice(2), dataUrl: ev.target.result, name: file.name });
      renderProjectPhotoGrid();
    };
    r.readAsDataURL(file);
  });
  e.target.value = '';
}

function renderProjectPhotoGrid() {
  const grid = document.getElementById('projectPhotoGrid');
  const count = document.getElementById('projectPhotoCount');
  if (!grid) return;
  const tiles = [];
  _projectExistingPhotos.forEach((ph, i) => {
    if (_projectRemovedPhotos.includes(i)) return;
    tiles.push(`
      <div class="meeting-photo-tile">
        <img src="${ph.dataUrl}" alt="">
        <button type="button" class="meeting-photo-remove" onclick="event.stopPropagation();_removeProjectPhoto(${i},true)">×</button>
      </div>`);
  });
  _projectPendingPhotos.forEach(ph => {
    tiles.push(`
      <div class="meeting-photo-tile meeting-photo-tile-pending">
        <img src="${ph.dataUrl}" alt="">
        <button type="button" class="meeting-photo-remove" onclick="event.stopPropagation();_removeProjectPhoto('${ph.tempId}',false)">×</button>
      </div>`);
  });
  grid.innerHTML = tiles.join('');
  const total = _projectExistingPhotos.filter((_,i) => !_projectRemovedPhotos.includes(i)).length + _projectPendingPhotos.length;
  if (count) count.textContent = total ? `${total} photo${total>1?'s':''}` : 'No photos yet';
}
function _removeProjectPhoto(idx, existing) {
  if (existing) _projectRemovedPhotos.push(idx);
  else _projectPendingPhotos = _projectPendingPhotos.filter(p => p.tempId !== idx);
  renderProjectPhotoGrid();
}
function handleProjectBrochure(e) {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 30 * 1024 * 1024) { showToast('Brochure too large (max 30 MB)', 'error'); return; }
  const r = new FileReader();
  r.onload = ev => {
    _projectPendingBrochure = { name: f.name, dataUrl: ev.target.result };
    document.getElementById('projectBrochureName').textContent = `Selected: ${f.name}`;
  };
  r.readAsDataURL(f);
}

function saveProject() {
  const id    = document.getElementById('projectId').value;
  const devId = document.getElementById('projectDevId').value;
  const name  = document.getElementById('projectName').value.trim();
  const location = document.getElementById('projectLocation').value.trim();
  if (!devId) { showToast('Pick a developer first', 'error'); return; }
  if (!name)  { showToast('Project name is required', 'error'); return; }
  if (!location){ showToast('Location is required', 'error'); return; }

  const projects = loadProjects();
  const existing = id ? projects.find(p => p.id === id) : null;

  // Build final photos: keep existing minus removed, plus new pending
  const finalPhotos = _projectExistingPhotos.filter((_, i) => !_projectRemovedPhotos.includes(i)).concat(
    _projectPendingPhotos.map(ph => ({ name: ph.name, dataUrl: ph.dataUrl }))
  );
  const finalBrochure = _projectPendingBrochure || _projectExistingBrochure || null;

  const record = {
    id: id || ('proj_' + Math.random().toString(36).slice(2)),
    devId,
    name,
    status:       document.getElementById('projectStatus').value,
    type:         document.getElementById('projectType').value,
    location,
    unitMix:      document.getElementById('projectUnitMix').value.trim(),
    launchDate:   document.getElementById('projectLaunchDate').value,
    handoverDate: document.getElementById('projectHandoverDate').value,
    priceFrom:    Number(document.getElementById('projectPriceFrom').value) || null,
    priceTo:      Number(document.getElementById('projectPriceTo').value)   || null,
    paymentPlan:  document.getElementById('projectPaymentPlan').value.trim(),
    amenities:    document.getElementById('projectAmenities').value.trim(),
    description:  document.getElementById('projectDescription').value.trim(),
    photos:       finalPhotos,
    brochure:     finalBrochure,
    dataSource:   existing?.dataSource || 'manual',
    createdAt:    existing?.createdAt  || new Date().toISOString(),
    updatedAt:    new Date().toISOString()
  };
  const idx = projects.findIndex(p => p.id === record.id);
  if (idx > -1) projects[idx] = record; else projects.unshift(record);
  saveProjects(projects);
  closeProjectModal();
  showToast(existing ? 'Project updated' : 'Project added', 'success');
  if (_opView === 'developers') _opGo('projects', devId);
  else renderOffplan();
}

function deleteProject() {
  const id = document.getElementById('projectId').value;
  if (!id) return;
  if (!confirm('Delete this project? Photos and brochure will also be removed.')) return;
  saveProjects(loadProjects().filter(p => p.id !== id));
  closeProjectModal();
  if (_opCurrentProjectId === id) _opGo('projects', _opCurrentDevId);
  showToast('Project deleted', 'success');
  renderOffplan();
}

// ─── PDF export (uses ASG letterhead from proposals) ──
function downloadProjectPDF(id) {
  const p = loadProjects().find(x => x.id === id);
  if (!p) return;
  const dev = loadDevelopers().find(d => d.id === p.devId);
  const sm = PROJECT_STATUS_META[p.status] || PROJECT_STATUS_META.launched;
  const tm = PROJECT_TYPE_META[p.type] || PROJECT_TYPE_META.apartments;
  const amenities = (p.amenities || '').split(',').map(s => s.trim()).filter(Boolean);
  const fa = n => n ? 'AED ' + Number(n).toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:0}) : '—';
  const fd = s => s ? new Date(s+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const he = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const doc = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${he(p.name)} — ${he(dev?.name||'')}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#111;background:#fff;font-size:12.5px;line-height:1.55}
.page{max-width:820px;margin:0 auto;padding:0 44px 110px;position:relative;min-height:1100px}
.lh-header{position:relative;padding:22px 0 26px;margin-bottom:20px}
.lh-header-frame{border:2px solid #c9a84c;border-bottom:none;border-radius:70px 70px 0 0;height:130px;position:absolute;top:0;left:-44px;right:-44px;pointer-events:none}
.lh-logo-block{position:relative;padding:14px 0 0 6px;display:inline-block}
.lh-logo-icon{display:flex;align-items:flex-end;gap:2px;height:42px;margin-bottom:2px}
.lh-bar{background:#c9a84c;width:8px;border-radius:1px}
.lh-bar.b1{height:24px}.lh-bar.b2{height:36px}.lh-bar.b3{height:30px}.lh-bar.b4{height:42px;width:10px}
.lh-divider{height:2px;width:440px;background:#c9a84c;margin:8px 0 0}
.lh-asg{font-size:34px;font-weight:900;letter-spacing:6px;color:#7a5d1e;line-height:1}
.lh-sub{font-size:11.5px;letter-spacing:2.6px;color:#7a5d1e;font-weight:700;margin-top:3px}
.lh-doc-meta{position:absolute;right:0;top:34px;text-align:right;max-width:320px}
.doc-title{font-size:17px;font-weight:900;text-transform:uppercase;letter-spacing:.4px;color:#111}
.doc-dates{font-size:11px;color:#555;margin-top:4px}
.lh-watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);font-size:340px;font-weight:900;letter-spacing:30px;color:#f8efd5;z-index:0;pointer-events:none;user-select:none;white-space:nowrap}
.page > *{position:relative;z-index:1}
.lh-footer{position:fixed;left:0;right:0;bottom:0;background:#1a1f2e;color:#fff;padding:14px 44px;z-index:5}
.lh-footer-grid{display:grid;grid-template-columns:1.1fr 1.1fr 1.6fr;gap:22px;max-width:820px;margin:0 auto;font-size:10.5px;line-height:1.4}
.lh-fcol{display:flex;flex-direction:column;gap:6px}
.lh-fitem{display:flex;align-items:center;gap:8px;color:#fff}
.lh-icon{width:18px;height:18px;border:1.2px solid #c9a84c;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#c9a84c;font-size:9px;flex-shrink:0}

.proj-hero{margin-bottom:20px}
.proj-dev{font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:#7a5d1e;font-weight:700;margin-bottom:4px}
.proj-name{font-size:28px;font-weight:900;color:#111;letter-spacing:-0.01em}
.proj-meta-row{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font-size:12px;color:#555}
.proj-status-pill{display:inline-block;padding:4px 12px;border-radius:99px;font-size:11px;font-weight:700;background:#fef3c7;color:#92400e}

.proj-photos{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0}
.proj-photo{aspect-ratio:4/3;background-size:cover;background-position:center;border-radius:6px;border:1px solid #e5e7eb}

.proj-block{margin-top:18px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden}
.proj-block-h{background:#f9fafb;padding:10px 14px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;border-bottom:1px solid #e5e7eb}
.proj-rows{padding:10px 14px}
.proj-r{display:grid;grid-template-columns:160px 1fr;gap:14px;padding:5px 0;font-size:12.5px}
.proj-r span:first-child{color:#6b7280;font-weight:600}
.proj-r strong{color:#111}
.proj-text{padding:12px 14px;font-size:12.5px;color:#374151;line-height:1.6;white-space:pre-wrap}
.proj-amenities{display:flex;flex-wrap:wrap;gap:6px;padding:12px 14px}
.proj-amenity{padding:5px 10px;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;font-size:11.5px;color:#92400e;font-weight:600}

@media print{.page{padding:0 26px 110px}@page{size:A4;margin:10mm 10mm 0 10mm}}
</style></head><body>

<div class="lh-watermark">ASG</div>

<div class="page">

<div class="lh-header">
  <div class="lh-header-frame"></div>
  <div class="lh-logo-block">
    <div class="lh-logo-icon">
      <span class="lh-bar b1"></span><span class="lh-bar b2"></span><span class="lh-bar b3"></span><span class="lh-bar b4"></span>
    </div>
    <div class="lh-divider"></div>
    <div class="lh-asg">ASG</div>
    <div class="lh-sub">COMMERCIAL PROPERTIES L.L.C.</div>
  </div>
  <div class="lh-doc-meta">
    <div class="doc-title">Project Brief</div>
    <div class="doc-dates">${fd(new Date().toISOString().split('T')[0])}</div>
  </div>
</div>

<div class="proj-hero">
  ${dev ? `<div class="proj-dev">${he(dev.name)}</div>` : ''}
  <div class="proj-name">${he(p.name)}</div>
  <div class="proj-meta-row">
    <span class="proj-status-pill">${sm.icon} ${he(sm.label)}</span>
    <span>${tm.icon} ${he(tm.label)}</span>
    ${p.location ? `<span>📍 ${he(p.location)}</span>` : ''}
  </div>
</div>

${(p.photos && p.photos.length) ? `
  <div class="proj-photos">
    ${p.photos.slice(0,6).map(ph => `<div class="proj-photo" style="background-image:url('${ph.dataUrl}')"></div>`).join('')}
  </div>` : ''}

<div class="proj-block">
  <div class="proj-block-h">Pricing</div>
  <div class="proj-rows">
    ${p.priceFrom ? `<div class="proj-r"><span>Price From</span><strong>${fa(p.priceFrom)}</strong></div>` : ''}
    ${p.priceTo   ? `<div class="proj-r"><span>Price To</span><strong>${fa(p.priceTo)}</strong></div>`   : ''}
    ${p.unitMix   ? `<div class="proj-r"><span>Unit Mix</span><strong>${he(p.unitMix)}</strong></div>` : ''}
    ${p.paymentPlan ? `<div class="proj-r"><span>Payment Plan</span><strong>${he(p.paymentPlan)}</strong></div>` : ''}
  </div>
</div>

<div class="proj-block">
  <div class="proj-block-h">Timeline</div>
  <div class="proj-rows">
    ${p.launchDate   ? `<div class="proj-r"><span>Launch Date</span><strong>${fd(p.launchDate)}</strong></div>` : ''}
    ${p.handoverDate ? `<div class="proj-r"><span>Handover</span><strong>${fd(p.handoverDate)}</strong></div>` : ''}
  </div>
</div>

${p.description ? `
  <div class="proj-block">
    <div class="proj-block-h">About the Project</div>
    <div class="proj-text">${he(p.description)}</div>
  </div>` : ''}

${amenities.length ? `
  <div class="proj-block">
    <div class="proj-block-h">Amenities</div>
    <div class="proj-amenities">
      ${amenities.map(a => `<span class="proj-amenity">${he(a)}</span>`).join('')}
    </div>
  </div>` : ''}

</div>

<div class="lh-footer">
  <div class="lh-footer-grid">
    <div class="lh-fcol">
      <div class="lh-fitem"><span class="lh-icon">⌾</span>asg.commercial_properties</div>
      <div class="lh-fitem"><span class="lh-icon">⊕</span>www.asgholdings.ae</div>
    </div>
    <div class="lh-fcol">
      <div class="lh-fitem"><span class="lh-icon">✉</span>info@asggroup.ae</div>
      <div class="lh-fitem"><span class="lh-icon">☏</span>+971 4 264 2899</div>
    </div>
    <div class="lh-fcol">
      <div class="lh-fitem" style="align-items:flex-start;">
        <span class="lh-icon" style="margin-top:1px;">◉</span>
        <span>Office No. 1006, 10<sup>th</sup> Floor, Dubai National<br>Insurance Building, Port Saeed - Dubai</span>
      </div>
    </div>
  </div>
</div>

</body></html>`;

  const win = window.open('', '_blank');
  if (!win) { showToast('Allow pop-ups to download the PDF', 'error'); return; }
  win.document.write(doc); win.document.close(); win.focus();
  setTimeout(() => win.print(), 600);
}

function shareProject(id) {
  const p = loadProjects().find(x => x.id === id);
  if (!p) return;
  const dev = loadDevelopers().find(d => d.id === p.devId);
  const msg = `${p.name}${dev ? ' by ' + dev.name : ''}${p.location ? ' — ' + p.location : ''}${p.priceFrom ? ' — Starting AED ' + Number(p.priceFrom).toLocaleString() : ''}.\n\nLet me know if you want the full brochure.\n\n— ASG Commercial Properties`;
  // Open WhatsApp/email picker
  const wa = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  const mail = `mailto:?subject=${encodeURIComponent(p.name + ' — Off-Plan Project')}&body=${encodeURIComponent(msg)}`;
  if (confirm('Share this project?\n\nOK → WhatsApp\nCancel → Email')) window.open(wa, '_blank');
  else window.open(mail, '_blank');
  // Also open the PDF
  setTimeout(() => downloadProjectPDF(id), 200);
}

function _opLightbox(projectId, idx) {
  const p = loadProjects().find(x => x.id === projectId);
  if (!p || !p.photos[idx]) return;
  const photo = p.photos[idx];
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<html><head><title>${h(photo.name||p.name)}</title><style>body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh}img{max-width:100%;max-height:100%}</style></head><body><img src="${photo.dataUrl}"></body></html>`);
  w.document.close();
}

// ─── Excel import (projects) ──────────────────────
function openExcelImport(kind) {
  if (kind !== 'projects') return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.xlsx,.xls,.csv';
  inp.onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (typeof XLSX === 'undefined') { showToast('Excel library not loaded', 'error'); return; }
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type:'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    let added = 0;
    const devs = loadDevelopers();
    const projects = loadProjects();
    for (const row of rows) {
      const devName = String(row['Developer'] || row['developer'] || '').trim();
      const name    = String(row['Project'] || row['Name'] || row['name'] || '').trim();
      if (!devName || !name) continue;
      let dev = devs.find(d => d.name.toLowerCase() === devName.toLowerCase());
      if (!dev) {
        dev = {
          id:'dev_' + Math.random().toString(36).slice(2),
          name: devName, region: String(row['Region']||'Dubai'), website:'',
          brief:'', logo:null, dataSource:'import', createdAt:new Date().toISOString()
        };
        devs.push(dev);
      }
      projects.unshift({
        id: 'proj_' + Math.random().toString(36).slice(2),
        devId: dev.id,
        name,
        status:       String(row['Status']||'launched').toLowerCase(),
        type:         String(row['Type']||'apartments').toLowerCase(),
        location:     String(row['Location']||''),
        unitMix:      String(row['Unit Mix']||row['UnitMix']||''),
        launchDate:   String(row['Launch Date']||''),
        handoverDate: String(row['Handover Date']||row['Handover']||''),
        priceFrom:    Number(row['Price From']||row['PriceFrom']) || null,
        priceTo:      Number(row['Price To']  ||row['PriceTo'])   || null,
        paymentPlan:  String(row['Payment Plan']||''),
        amenities:    String(row['Amenities']||''),
        description:  String(row['Description']||''),
        photos: [], brochure: null,
        dataSource: 'import',
        createdAt: new Date().toISOString()
      });
      added++;
    }
    saveDevelopers(devs);
    saveProjects(projects);
    showToast(`Imported ${added} project${added===1?'':'s'}`, 'success');
    renderOffplan();
  };
  inp.click();
}

// ─── Wiring: showTab + showAgentTab ───────────────
const _origShowTab2 = (typeof showTab === 'function') ? showTab : null;
if (_origShowTab2) {
  showTab = function(tab) {
    _origShowTab2.apply(this, arguments);
    const opEl = document.getElementById('offplanView');
    if (opEl) opEl.style.display = tab === 'offplan' ? '' : 'none';
    const btn = document.getElementById('tabOffplan');
    if (btn) btn.classList.toggle('active', tab === 'offplan');
    if (tab === 'offplan') { _opView = 'developers'; renderOffplan(); }
  };
}
const _origShowAgentTab4 = (typeof showAgentTab === 'function') ? showAgentTab : null;
if (_origShowAgentTab4) {
  if (typeof AGENT_TABS !== 'undefined' && !AGENT_TABS.includes('offplan')) AGENT_TABS.push('offplan');
  showAgentTab = function(tab) {
    _origShowAgentTab4.apply(this, arguments);
    if (tab === 'offplan') { _opView = 'developers'; renderOffplan(); }
  };
}

// ═══════════════════════════════════════════════════════
//  SECONDARY (RESALE) LISTINGS
//  Properties owned by 3rd parties, marketed by ASG team
// ═══════════════════════════════════════════════════════

const SECONDARY_KEY = 'asg_secondary_listings';
function loadSecondary()  { return _api.secondary.load(); }
function saveSecondary(a) { _api.secondary.save(a); }

const SEC_TYPE_META = {
  apartment:  { icon:'🏢', label:'Apartment'  },
  villa:      { icon:'🏠', label:'Villa'      },
  townhouse:  { icon:'🏘️', label:'Townhouse'  },
  warehouse:  { icon:'🏭', label:'Warehouse'  },
  office:     { icon:'🏢', label:'Office'     },
  retail:     { icon:'🏬', label:'Retail'     },
  land:       { icon:'📐', label:'Land'       },
  other:      { icon:'📌', label:'Other'      }
};
const SEC_STATUS_META = {
  active:   { icon:'🟢', label:'Active',   cls:'sec-st-active'   },
  reserved: { icon:'🟡', label:'Reserved', cls:'sec-st-reserved' },
  sold:     { icon:'✅', label:'Sold',     cls:'sec-st-sold'     },
  rented:   { icon:'✅', label:'Rented',   cls:'sec-st-rented'   },
  inactive: { icon:'⚪', label:'Inactive', cls:'sec-st-inactive' }
};
const SEC_TXN_META = {
  sale: 'For Sale',
  rent: 'For Rent',
  both: 'Sale or Rent'
};

let _secView = 'list';   // 'list' | 'detail'
let _secCurrentId = '';
let _secFilters = { search:'', type:'', txn:'', status:'active' };

// In-flight modal photo state
let _secPendingPhotos = [];
let _secExistingPhotos = [];
let _secRemovedPhotos = [];

function _secMount() {
  if (isAgentUser()) return {
    list:   document.getElementById('secondaryListContentAgent'),
    detail: document.getElementById('secondaryDetailContentAgent')
  };
  return {
    list:   document.getElementById('secondaryListContent'),
    detail: document.getElementById('secondaryDetailContent')
  };
}

function _secCanEdit(listing) {
  const sess = getSession();
  if (!sess) return false;
  if (sess.type === 'admin') return true;
  return listing && listing.addedBy?.id === sess.agentId;
}

function renderSecondary() {
  if (_secView === 'detail') return _renderSecondaryDetail();
  return _renderSecondaryList();
}

// ─── List view ────────────────────────────────────
function _renderSecondaryList() {
  const { list, detail } = _secMount();
  if (!list) return;
  if (detail) detail.style.display = 'none';
  list.style.display = '';

  let items = loadSecondary();
  const f = _secFilters;
  if (f.type)   items = items.filter(x => x.type === f.type);
  if (f.txn)    items = items.filter(x => x.transaction === f.txn || x.transaction === 'both');
  if (f.status) items = items.filter(x => x.status === f.status);
  if (f.search) {
    const q = f.search.toLowerCase();
    items = items.filter(x =>
      (x.title||'').toLowerCase().includes(q) ||
      (x.location||'').toLowerCase().includes(q) ||
      (x.ownerName||'').toLowerCase().includes(q)
    );
  }
  items.sort((a,b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

  const all = loadSecondary();
  const counts = {
    total:    all.length,
    active:   all.filter(x => x.status === 'active').length,
    sale:     all.filter(x => x.transaction === 'sale' || x.transaction === 'both').length,
    rent:     all.filter(x => x.transaction === 'rent' || x.transaction === 'both').length
  };

  const typeOpts = Object.entries(SEC_TYPE_META).map(([k,m]) => `<option value="${k}"${f.type===k?' selected':''}>${m.icon} ${m.label}</option>`).join('');
  const statusOpts = Object.entries(SEC_STATUS_META).map(([k,m]) => `<option value="${k}"${f.status===k?' selected':''}>${m.icon} ${m.label}</option>`).join('');

  list.innerHTML = `
    <div class="tab-page-header">
      <div>
        <h1 class="tab-page-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
          Secondary Listings
        </h1>
        <p class="tab-page-sub">Resale properties listed on behalf of external owners — visible to the whole sales team</p>
      </div>
      <button class="btn-primary" onclick="openSecondaryModal()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Listing
      </button>
    </div>

    <div class="sec-stat-row">
      <span class="sec-stat-chip">📋 ${counts.total} total</span>
      <span class="sec-stat-chip sec-stat-green">🟢 ${counts.active} active</span>
      <span class="sec-stat-chip">💰 ${counts.sale} for sale</span>
      <span class="sec-stat-chip">🔑 ${counts.rent} for rent</span>
    </div>

    <div class="sec-filter-bar">
      <input type="text" class="filter-select" placeholder="Search title, location, owner…" value="${h(f.search)}" oninput="_secFilters.search=this.value;_renderSecondaryList();" style="flex:1;min-width:200px;">
      <select class="filter-select" onchange="_secFilters.type=this.value;_renderSecondaryList();" style="width:160px;">
        <option value="">All Types</option>${typeOpts}
      </select>
      <select class="filter-select" onchange="_secFilters.txn=this.value;_renderSecondaryList();" style="width:160px;">
        <option value="">Sale &amp; Rent</option>
        <option value="sale"${f.txn==='sale'?' selected':''}>For Sale</option>
        <option value="rent"${f.txn==='rent'?' selected':''}>For Rent</option>
      </select>
      <select class="filter-select" onchange="_secFilters.status=this.value;_renderSecondaryList();" style="width:160px;">
        <option value=""${f.status===''?' selected':''}>All Statuses</option>${statusOpts}
      </select>
    </div>

    ${items.length === 0 ? `
      <div class="team-empty">
        <div class="empty-icon">🏷️</div>
        <p>No listings match your filters. Click <strong>+ Add Listing</strong> to add one.</p>
      </div>
    ` : `
      <div class="sec-grid">
        ${items.map(x => {
          const tm = SEC_TYPE_META[x.type]   || SEC_TYPE_META.apartment;
          const sm = SEC_STATUS_META[x.status]|| SEC_STATUS_META.active;
          const cover = (x.photos && x.photos.length) ? x.photos[0].dataUrl : null;
          const priceLine = (() => {
            if (x.transaction === 'rent' && x.rent) return 'AED ' + num(x.rent) + ' / yr';
            if (x.transaction === 'sale' && x.price) return 'AED ' + num(x.price);
            if (x.transaction === 'both') {
              const a = x.price ? 'AED ' + num(x.price) : '';
              const b = x.rent  ? 'AED ' + num(x.rent) + '/yr' : '';
              return [a, b].filter(Boolean).join(' · ') || '—';
            }
            return x.price ? 'AED ' + num(x.price) : (x.rent ? 'AED ' + num(x.rent) + '/yr' : '—');
          })();
          return `
            <div class="sec-card" onclick="openSecondaryDetail('${x.id}')">
              <div class="sec-card-cover" ${cover ? `style="background-image:url('${cover}')"` : ''}>
                ${!cover ? `<span class="sec-card-cover-placeholder">${tm.icon}</span>` : ''}
                <span class="sec-card-status ${sm.cls}">${sm.icon} ${sm.label}</span>
                <span class="sec-card-txn">${SEC_TXN_META[x.transaction] || ''}</span>
              </div>
              <div class="sec-card-body">
                <div class="sec-card-title">${h(x.title || 'Untitled')}</div>
                <div class="sec-card-meta">${tm.icon} ${tm.label}${x.location ? ' · 📍 '+h(x.location) : ''}</div>
                <div class="sec-card-specs">
                  ${x.size  ? `<span>📐 ${num(x.size)} sqft</span>` : ''}
                  ${x.beds  ? `<span>🛏️ ${x.beds} BR</span>` : ''}
                  ${x.baths ? `<span>🛁 ${x.baths} BA</span>` : ''}
                </div>
                <div class="sec-card-price">${priceLine}</div>
                <div class="sec-card-foot">
                  ${(x.photos?.length || 0) ? `<span>📷 ${x.photos.length}</span>` : ''}
                  <span class="sec-card-by">by ${h(x.addedBy?.name || 'Admin')}</span>
                </div>
              </div>
            </div>`;
        }).join('')}
      </div>
    `}
  `;
}

// ─── Detail view ──────────────────────────────────
function openSecondaryDetail(id) {
  _secView = 'detail';
  _secCurrentId = id;
  renderSecondary();
}
function _backToSecondaryList() {
  _secView = 'list';
  _secCurrentId = '';
  renderSecondary();
}

function _renderSecondaryDetail() {
  const { list, detail } = _secMount();
  if (!detail) return;
  const x = loadSecondary().find(p => p.id === _secCurrentId);
  if (!x) { _backToSecondaryList(); return; }
  if (list) list.style.display = 'none';
  detail.style.display = '';

  const tm = SEC_TYPE_META[x.type]   || SEC_TYPE_META.apartment;
  const sm = SEC_STATUS_META[x.status]|| SEC_STATUS_META.active;
  const amenities = (x.amenities || '').split(',').map(s => s.trim()).filter(Boolean);
  const canEdit = _secCanEdit(x);

  detail.innerHTML = `
    <div class="op-breadcrumb">
      <a class="op-crumb-link" onclick="_backToSecondaryList()">Secondary Listings</a>
      <span class="op-crumb-sep">›</span>
      <span class="op-crumb-current">${h(x.title || 'Listing')}</span>
    </div>

    <div class="op-detail">
      <div class="op-detail-head">
        <div>
          <div class="op-detail-dev">${SEC_TXN_META[x.transaction] || ''}</div>
          <h1 class="op-detail-name">${h(x.title)}</h1>
          <div class="op-detail-meta">
            <span class="sec-card-status ${sm.cls}">${sm.icon} ${sm.label}</span>
            <span>${tm.icon} ${tm.label}</span>
            ${x.location ? `<span>📍 ${h(x.location)}</span>` : ''}
          </div>
        </div>
        <div class="op-detail-actions">
          <button class="btn-primary" onclick="downloadSecondaryPDF('${x.id}')">📄 Download PDF</button>
          <button class="btn-ghost" onclick="shareSecondary('${x.id}')">📤 Share with Client</button>
          ${canEdit ? `<button class="btn-ghost" onclick="openSecondaryModal('${x.id}')">✏️ Edit</button>` : ''}
        </div>
      </div>

      ${x.photos && x.photos.length ? `
        <div class="op-photo-gallery">
          ${x.photos.map((ph, i) => `<div class="op-photo-tile" onclick="_secLightbox('${x.id}',${i})"><img src="${ph.dataUrl}" alt=""></div>`).join('')}
        </div>` : ''}

      <div class="op-detail-grid">
        <div class="op-detail-block">
          <div class="op-detail-block-h">💰 Pricing &amp; Specs</div>
          <div class="op-detail-rows">
            ${x.price ? `<div class="op-row"><span>Sale Price</span><strong>AED ${num(x.price)}</strong></div>` : ''}
            ${x.rent  ? `<div class="op-row"><span>Annual Rent</span><strong>AED ${num(x.rent)}</strong></div>` : ''}
            ${x.size  ? `<div class="op-row"><span>Size</span><strong>${num(x.size)} sqft</strong></div>` : ''}
            ${x.beds  ? `<div class="op-row"><span>Bedrooms</span><strong>${x.beds}</strong></div>` : ''}
            ${x.baths ? `<div class="op-row"><span>Bathrooms</span><strong>${x.baths}</strong></div>` : ''}
          </div>
        </div>
        <div class="op-detail-block">
          <div class="op-detail-block-h">👤 Owner</div>
          <div class="op-detail-rows">
            ${x.ownerName  ? `<div class="op-row"><span>Name</span><strong>${h(x.ownerName)}</strong></div>` : ''}
            ${x.ownerPhone ? `<div class="op-row"><span>Phone</span><strong><a href="tel:${h(x.ownerPhone)}" style="color:var(--gold);">${h(x.ownerPhone)}</a></strong></div>` : ''}
            ${x.ownerEmail ? `<div class="op-row"><span>Email</span><strong><a href="mailto:${h(x.ownerEmail)}" style="color:var(--gold);">${h(x.ownerEmail)}</a></strong></div>` : ''}
            <div class="op-row"><span>Added by</span><strong>${h(x.addedBy?.name || 'Admin')}</strong></div>
          </div>
        </div>
      </div>

      ${x.description ? `
        <div class="op-detail-block">
          <div class="op-detail-block-h">📝 Description</div>
          <div class="op-detail-text">${h(x.description)}</div>
        </div>` : ''}

      ${amenities.length ? `
        <div class="op-detail-block">
          <div class="op-detail-block-h">✨ Amenities</div>
          <div class="op-amenity-grid">${amenities.map(a => `<span class="op-amenity">${h(a)}</span>`).join('')}</div>
        </div>` : ''}
    </div>
  `;
}

// ─── Modal ────────────────────────────────────────
function openSecondaryModal(id) {
  const x = id ? loadSecondary().find(p => p.id === id) : null;
  document.getElementById('secondaryModalTitle').textContent = x ? 'Edit Secondary Listing' : 'Add Secondary Listing';
  document.getElementById('secondaryId').value = x ? x.id : '';

  const set = (sel, v) => { const el = document.getElementById(sel); if (el) el.value = (v != null ? v : ''); };
  set('secondaryTitle',       x?.title);
  set('secondaryType',        x?.type        || 'apartment');
  set('secondaryTransaction', x?.transaction || 'sale');
  set('secondaryLocation',    x?.location);
  set('secondaryStatus',      x?.status      || 'active');
  set('secondarySize',        x?.size);
  set('secondaryBeds',        x?.beds);
  set('secondaryBaths',       x?.baths);
  set('secondaryPrice',       x?.price);
  set('secondaryRent',        x?.rent);
  set('secondaryOwnerName',   x?.ownerName);
  set('secondaryOwnerPhone',  x?.ownerPhone);
  set('secondaryOwnerEmail',  x?.ownerEmail);
  set('secondaryDescription', x?.description);
  set('secondaryAmenities',   x?.amenities);

  _secPendingPhotos = [];
  _secExistingPhotos = (x?.photos || []).slice();
  _secRemovedPhotos = [];
  renderSecondaryPhotoGrid();

  _secToggleFields();

  document.getElementById('secondaryDeleteBtn').style.display = x ? '' : 'none';
  document.getElementById('secondaryModalOverlay').classList.add('active');
}

function closeSecondaryModal() {
  document.getElementById('secondaryModalOverlay').classList.remove('active');
  _secPendingPhotos = [];
  _secExistingPhotos = [];
  _secRemovedPhotos = [];
}

function _secToggleFields() {
  const txn = document.getElementById('secondaryTransaction')?.value || 'sale';
  const saleLbl = document.getElementById('secondarySaleLabel');
  const rentLbl = document.getElementById('secondaryRentLabel');
  if (saleLbl) saleLbl.textContent = (txn === 'rent') ? '(not used)' : '';
  if (rentLbl) rentLbl.textContent = (txn === 'sale') ? '(not used)' : '';
  // Beds/baths only relevant for residential types
  const type = document.getElementById('secondaryType')?.value;
  const isRes = ['apartment','villa','townhouse'].includes(type);
  const bg = document.getElementById('secondaryBedsGroup');
  const bgB = document.getElementById('secondaryBathsGroup');
  if (bg)  bg.style.display  = isRes ? '' : 'none';
  if (bgB) bgB.style.display = isRes ? '' : 'none';
}
// Re-evaluate the residential-only fields when type changes
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'secondaryType') _secToggleFields();
});

function handleSecondaryPhotos(e) {
  const files = Array.from(e.target.files || []);
  files.forEach(file => {
    if (file.size > 10 * 1024 * 1024) { showToast(`${file.name} too large (max 10 MB)`, 'error'); return; }
    const r = new FileReader();
    r.onload = ev => {
      _secPendingPhotos.push({ tempId: 'tmp_' + Math.random().toString(36).slice(2), dataUrl: ev.target.result, name: file.name });
      renderSecondaryPhotoGrid();
    };
    r.readAsDataURL(file);
  });
  e.target.value = '';
}

function renderSecondaryPhotoGrid() {
  const grid = document.getElementById('secondaryPhotoGrid');
  const count = document.getElementById('secondaryPhotoCount');
  if (!grid) return;
  const tiles = [];
  _secExistingPhotos.forEach((ph, i) => {
    if (_secRemovedPhotos.includes(i)) return;
    tiles.push(`
      <div class="meeting-photo-tile">
        <img src="${ph.dataUrl}" alt="">
        <button type="button" class="meeting-photo-remove" onclick="event.stopPropagation();_removeSecondaryPhoto(${i},true)">×</button>
      </div>`);
  });
  _secPendingPhotos.forEach(ph => {
    tiles.push(`
      <div class="meeting-photo-tile meeting-photo-tile-pending">
        <img src="${ph.dataUrl}" alt="">
        <button type="button" class="meeting-photo-remove" onclick="event.stopPropagation();_removeSecondaryPhoto('${ph.tempId}',false)">×</button>
      </div>`);
  });
  grid.innerHTML = tiles.join('');
  const total = _secExistingPhotos.filter((_,i) => !_secRemovedPhotos.includes(i)).length + _secPendingPhotos.length;
  if (count) count.textContent = total ? `${total} photo${total>1?'s':''}` : 'No photos yet';
}
function _removeSecondaryPhoto(idx, existing) {
  if (existing) _secRemovedPhotos.push(idx);
  else _secPendingPhotos = _secPendingPhotos.filter(p => p.tempId !== idx);
  renderSecondaryPhotoGrid();
}

function saveSecondaryListing() {
  const id = document.getElementById('secondaryId').value;
  const title = document.getElementById('secondaryTitle').value.trim();
  const location = document.getElementById('secondaryLocation').value.trim();
  const ownerName = document.getElementById('secondaryOwnerName').value.trim();
  const ownerPhone = document.getElementById('secondaryOwnerPhone').value.trim();
  if (!title)      { showToast('Title is required', 'error'); return; }
  if (!location)   { showToast('Location is required', 'error'); return; }
  if (!ownerName)  { showToast('Owner name is required', 'error'); return; }
  if (!ownerPhone) { showToast('Owner phone is required', 'error'); return; }

  const items = loadSecondary();
  const existing = id ? items.find(p => p.id === id) : null;
  if (existing && !_secCanEdit(existing)) {
    showToast('You can only edit your own listings', 'error');
    return;
  }

  const finalPhotos = _secExistingPhotos.filter((_, i) => !_secRemovedPhotos.includes(i)).concat(
    _secPendingPhotos.map(ph => ({ name: ph.name, dataUrl: ph.dataUrl }))
  );

  const sess = getSession();
  const author = sess?.type === 'agent'
    ? { id: sess.agentId, name: sess.name, type: 'agent' }
    : { id: '', name: 'Admin', type: 'admin' };

  const record = {
    id: id || ('sec_' + Math.random().toString(36).slice(2)),
    title,
    type:        document.getElementById('secondaryType').value,
    transaction: document.getElementById('secondaryTransaction').value,
    location,
    status:      document.getElementById('secondaryStatus').value,
    size:        Number(document.getElementById('secondarySize').value)  || null,
    beds:        Number(document.getElementById('secondaryBeds').value)  || null,
    baths:       Number(document.getElementById('secondaryBaths').value) || null,
    price:       Number(document.getElementById('secondaryPrice').value) || null,
    rent:        Number(document.getElementById('secondaryRent').value)  || null,
    ownerName,
    ownerPhone,
    ownerEmail:  document.getElementById('secondaryOwnerEmail').value.trim(),
    description: document.getElementById('secondaryDescription').value.trim(),
    amenities:   document.getElementById('secondaryAmenities').value.trim(),
    photos:      finalPhotos,
    addedBy:     existing?.addedBy || author,
    createdAt:   existing?.createdAt || new Date().toISOString(),
    updatedAt:   new Date().toISOString()
  };
  const idx = items.findIndex(p => p.id === record.id);
  if (idx > -1) items[idx] = record; else items.unshift(record);
  saveSecondary(items);
  closeSecondaryModal();
  showToast(existing ? 'Listing updated' : 'Listing added', 'success');
  if (_secView === 'detail' && _secCurrentId === record.id) renderSecondary();
  else { _secView = 'list'; renderSecondary(); }
}

function deleteSecondaryListing() {
  const id = document.getElementById('secondaryId').value;
  if (!id) return;
  const x = loadSecondary().find(p => p.id === id);
  if (x && !_secCanEdit(x)) { showToast('You can only delete your own listings', 'error'); return; }
  if (!confirm('Delete this listing? Photos will also be removed.')) return;
  saveSecondary(loadSecondary().filter(p => p.id !== id));
  closeSecondaryModal();
  if (_secCurrentId === id) _backToSecondaryList();
  showToast('Listing deleted', 'success');
}

function _secLightbox(id, idx) {
  const x = loadSecondary().find(p => p.id === id);
  if (!x || !x.photos[idx]) return;
  const photo = x.photos[idx];
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<html><head><title>${h(photo.name||x.title)}</title><style>body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh}img{max-width:100%;max-height:100%}</style></head><body><img src="${photo.dataUrl}"></body></html>`);
  w.document.close();
}

// ─── PDF export (ASG letterhead) ──────────────────
function downloadSecondaryPDF(id) {
  const x = loadSecondary().find(p => p.id === id);
  if (!x) return;
  const tm = SEC_TYPE_META[x.type]   || SEC_TYPE_META.apartment;
  const sm = SEC_STATUS_META[x.status]|| SEC_STATUS_META.active;
  const amenities = (x.amenities || '').split(',').map(s => s.trim()).filter(Boolean);
  const fa = n => n ? 'AED ' + Number(n).toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:0}) : '—';
  const fd = s => s ? new Date(s).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const he = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const doc = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${he(x.title)} — Secondary Listing</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}
body{font-family:'Helvetica Neue',Arial,sans-serif;color:#111;background:#fff;font-size:12.5px;line-height:1.55}
.page{max-width:820px;margin:0 auto;padding:0 44px 110px;position:relative;min-height:1100px}
.lh-header{position:relative;padding:22px 0 26px;margin-bottom:20px}
.lh-header-frame{border:2px solid #c9a84c;border-bottom:none;border-radius:70px 70px 0 0;height:130px;position:absolute;top:0;left:-44px;right:-44px;pointer-events:none}
.lh-logo-block{position:relative;padding:14px 0 0 6px;display:inline-block}
.lh-logo-icon{display:flex;align-items:flex-end;gap:2px;height:42px;margin-bottom:2px}
.lh-bar{background:#c9a84c;width:8px;border-radius:1px}
.lh-bar.b1{height:24px}.lh-bar.b2{height:36px}.lh-bar.b3{height:30px}.lh-bar.b4{height:42px;width:10px}
.lh-divider{height:2px;width:440px;background:#c9a84c;margin:8px 0 0}
.lh-asg{font-size:34px;font-weight:900;letter-spacing:6px;color:#7a5d1e;line-height:1}
.lh-sub{font-size:11.5px;letter-spacing:2.6px;color:#7a5d1e;font-weight:700;margin-top:3px}
.lh-doc-meta{position:absolute;right:0;top:34px;text-align:right;max-width:320px}
.doc-title{font-size:17px;font-weight:900;text-transform:uppercase;letter-spacing:.4px;color:#111}
.doc-dates{font-size:11px;color:#555;margin-top:4px}
.lh-watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);font-size:340px;font-weight:900;letter-spacing:30px;color:#f8efd5;z-index:0;pointer-events:none;user-select:none;white-space:nowrap}
.page > *{position:relative;z-index:1}
.lh-footer{position:fixed;left:0;right:0;bottom:0;background:#1a1f2e;color:#fff;padding:14px 44px;z-index:5}
.lh-footer-grid{display:grid;grid-template-columns:1.1fr 1.1fr 1.6fr;gap:22px;max-width:820px;margin:0 auto;font-size:10.5px;line-height:1.4}
.lh-fcol{display:flex;flex-direction:column;gap:6px}
.lh-fitem{display:flex;align-items:center;gap:8px;color:#fff}
.lh-icon{width:18px;height:18px;border:1.2px solid #c9a84c;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#c9a84c;font-size:9px;flex-shrink:0}

.proj-hero{margin-bottom:20px}
.proj-dev{font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:#7a5d1e;font-weight:700;margin-bottom:4px}
.proj-name{font-size:26px;font-weight:900;color:#111;letter-spacing:-0.01em}
.proj-meta-row{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font-size:12px;color:#555}
.proj-status-pill{display:inline-block;padding:4px 12px;border-radius:99px;font-size:11px;font-weight:700;background:#dcfce7;color:#166534}

.proj-photos{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0}
.proj-photo{aspect-ratio:4/3;background-size:cover;background-position:center;border-radius:6px;border:1px solid #e5e7eb}

.proj-block{margin-top:18px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden}
.proj-block-h{background:#f9fafb;padding:10px 14px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;border-bottom:1px solid #e5e7eb}
.proj-rows{padding:10px 14px}
.proj-r{display:grid;grid-template-columns:160px 1fr;gap:14px;padding:5px 0;font-size:12.5px}
.proj-r span:first-child{color:#6b7280;font-weight:600}
.proj-r strong{color:#111}
.proj-text{padding:12px 14px;font-size:12.5px;color:#374151;line-height:1.6;white-space:pre-wrap}
.proj-amenities{display:flex;flex-wrap:wrap;gap:6px;padding:12px 14px}
.proj-amenity{padding:5px 10px;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;font-size:11.5px;color:#92400e;font-weight:600}

@media print{.page{padding:0 26px 110px}@page{size:A4;margin:10mm 10mm 0 10mm}}
</style></head><body>

<div class="lh-watermark">ASG</div>
<div class="page">

<div class="lh-header">
  <div class="lh-header-frame"></div>
  <div class="lh-logo-block">
    <div class="lh-logo-icon">
      <span class="lh-bar b1"></span><span class="lh-bar b2"></span><span class="lh-bar b3"></span><span class="lh-bar b4"></span>
    </div>
    <div class="lh-divider"></div>
    <div class="lh-asg">ASG</div>
    <div class="lh-sub">COMMERCIAL PROPERTIES L.L.C.</div>
  </div>
  <div class="lh-doc-meta">
    <div class="doc-title">Property Listing</div>
    <div class="doc-dates">${fd(new Date().toISOString().split('T')[0])}</div>
  </div>
</div>

<div class="proj-hero">
  <div class="proj-dev">${he(SEC_TXN_META[x.transaction] || '')}</div>
  <div class="proj-name">${he(x.title)}</div>
  <div class="proj-meta-row">
    <span class="proj-status-pill">${sm.icon} ${he(sm.label)}</span>
    <span>${tm.icon} ${he(tm.label)}</span>
    ${x.location ? `<span>📍 ${he(x.location)}</span>` : ''}
  </div>
</div>

${(x.photos && x.photos.length) ? `
  <div class="proj-photos">
    ${x.photos.slice(0,6).map(ph => `<div class="proj-photo" style="background-image:url('${ph.dataUrl}')"></div>`).join('')}
  </div>` : ''}

<div class="proj-block">
  <div class="proj-block-h">Pricing &amp; Specs</div>
  <div class="proj-rows">
    ${x.price ? `<div class="proj-r"><span>Sale Price</span><strong>${fa(x.price)}</strong></div>` : ''}
    ${x.rent  ? `<div class="proj-r"><span>Annual Rent</span><strong>${fa(x.rent)}</strong></div>` : ''}
    ${x.size  ? `<div class="proj-r"><span>Size</span><strong>${num(x.size)} sqft</strong></div>` : ''}
    ${x.beds  ? `<div class="proj-r"><span>Bedrooms</span><strong>${x.beds}</strong></div>` : ''}
    ${x.baths ? `<div class="proj-r"><span>Bathrooms</span><strong>${x.baths}</strong></div>` : ''}
  </div>
</div>

${x.description ? `
  <div class="proj-block">
    <div class="proj-block-h">About</div>
    <div class="proj-text">${he(x.description)}</div>
  </div>` : ''}

${amenities.length ? `
  <div class="proj-block">
    <div class="proj-block-h">Amenities</div>
    <div class="proj-amenities">${amenities.map(a => `<span class="proj-amenity">${he(a)}</span>`).join('')}</div>
  </div>` : ''}

</div>

<div class="lh-footer">
  <div class="lh-footer-grid">
    <div class="lh-fcol">
      <div class="lh-fitem"><span class="lh-icon">⌾</span>asg.commercial_properties</div>
      <div class="lh-fitem"><span class="lh-icon">⊕</span>www.asgholdings.ae</div>
    </div>
    <div class="lh-fcol">
      <div class="lh-fitem"><span class="lh-icon">✉</span>info@asggroup.ae</div>
      <div class="lh-fitem"><span class="lh-icon">☏</span>+971 4 264 2899</div>
    </div>
    <div class="lh-fcol">
      <div class="lh-fitem" style="align-items:flex-start;">
        <span class="lh-icon" style="margin-top:1px;">◉</span>
        <span>Office No. 1006, 10<sup>th</sup> Floor, Dubai National<br>Insurance Building, Port Saeed - Dubai</span>
      </div>
    </div>
  </div>
</div>

</body></html>`;

  const win = window.open('', '_blank');
  if (!win) { showToast('Allow pop-ups to download the PDF', 'error'); return; }
  win.document.write(doc); win.document.close(); win.focus();
  setTimeout(() => win.print(), 600);
}

function shareSecondary(id) {
  const x = loadSecondary().find(p => p.id === id);
  if (!x) return;
  const priceLine = x.price ? 'AED ' + Number(x.price).toLocaleString() : (x.rent ? 'AED ' + Number(x.rent).toLocaleString() + ' / yr' : '');
  const msg = `${x.title}${x.location ? ' — ' + x.location : ''}${priceLine ? ' — ' + priceLine : ''}.\n\nLet me know if you want photos or a viewing.\n\n— ASG Commercial Properties`;
  const wa = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  const mail = `mailto:?subject=${encodeURIComponent(x.title + ' — Listing')}&body=${encodeURIComponent(msg)}`;
  if (confirm('Share this listing?\n\nOK → WhatsApp\nCancel → Email')) window.open(wa, '_blank');
  else window.open(mail, '_blank');
  setTimeout(() => downloadSecondaryPDF(id), 200);
}

// ─── Wiring: showTab + showAgentTab ───────────────
const _origShowTab3 = (typeof showTab === 'function') ? showTab : null;
if (_origShowTab3) {
  showTab = function(tab) {
    _origShowTab3.apply(this, arguments);
    const v = document.getElementById('secondaryView');
    if (v) v.style.display = tab === 'secondary' ? '' : 'none';
    const btn = document.getElementById('tabSecondary');
    if (btn) btn.classList.toggle('active', tab === 'secondary');
    if (tab === 'secondary') { _secView = 'list'; renderSecondary(); }
  };
}
const _origShowAgentTab5 = (typeof showAgentTab === 'function') ? showAgentTab : null;
if (_origShowAgentTab5) {
  if (typeof AGENT_TABS !== 'undefined' && !AGENT_TABS.includes('secondary')) AGENT_TABS.push('secondary');
  showAgentTab = function(tab) {
    _origShowAgentTab5.apply(this, arguments);
    if (tab === 'secondary') { _secView = 'list'; renderSecondary(); }
  };
}

// ─── Mobile sidebar toggle ────────────────────────
function toggleSidebar() {
  document.body.classList.toggle('sidebar-open');
}
function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}
// Auto-close the sidebar after a tab is selected on mobile (better UX)
(function autoCloseSidebarOnNavigation() {
  document.addEventListener('click', (e) => {
    const navItem = e.target.closest('.nav-item');
    if (!navItem) return;
    if (window.innerWidth > 900) return;  // desktop: don't auto-close
    closeSidebar();
  });
})();

// Probe backend health and update the status indicator on the login screen.
async function _probeBackend() {
  const el = document.getElementById('loginBackendStatus');
  if (!el) return;
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      el.style.display = 'block';
      el.innerHTML = `<span class="lbs-dot lbs-ok"></span> Backend connected · v${data.version || '?'} · ${data.users || 0} user${data.users === 1 ? '' : 's'}`;
      el.className = 'login-backend-status lbs-state-ok';
    } else {
      throw new Error('HTTP ' + res.status);
    }
  } catch (e) {
    el.style.display = 'block';
    el.innerHTML = `<span class="lbs-dot lbs-off"></span> Offline mode (backend unreachable — using localStorage)`;
    el.className = 'login-backend-status lbs-state-off';
  }
}

// ─── Start ────────────────────────────────────────
// Phase C: try to resume session from backend cookie before showing login screen.
// If sessionStorage already has a session (current tab), boot immediately.
// If not, ask /api/auth/me — if a valid cookie exists from a previous tab/visit,
// restore the session without making the user log in again.
(async function bootGate() {
  // Always validate the cookie against the backend, even if sessionStorage
  // claims we're logged in. Without this, an expired cookie + still-cached
  // sessionStorage shows the dashboard but every API call returns 401.
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.user) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(_sessionFromApiUser(data.user)));
        document.getElementById('loginScreen').style.display = 'none';
        boot();
        return;
      }
    }
    // 401 / no user → cookie is stale. Clear sessionStorage so we don't loop.
    sessionStorage.removeItem(SESSION_KEY);
  } catch (e) {
    // Backend unreachable. If sessionStorage has a session, do a best-effort
    // boot (probably read-only since API calls will fail too).
    if (isLoggedIn()) {
      document.getElementById('loginScreen').style.display = 'none';
      boot();
      return;
    }
  }
  // No valid session — show login screen.
  _probeBackend();
})();

