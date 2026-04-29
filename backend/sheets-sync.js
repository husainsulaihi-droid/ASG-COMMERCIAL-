/**
 * Google Sheets ↔ Properties two-way sync.
 *
 * Direction 1 (DB → Sheet, real-time):
 *   pushPropertyToSheet(id) — called from routes-properties.js after every
 *   POST/PATCH/DELETE. Updates the matching row in the sheet, or appends a
 *   new row, or removes the row.
 *
 * Direction 2 (Sheet → DB, polled):
 *   pollSheetIntoDb()       — called every POLL_INTERVAL_MS by the worker
 *   started in server.js. Compares sheet rows to DB rows by ID, applies
 *   inserts/updates. Rows added directly in the sheet (no ID) are inserted
 *   into the DB, then the new ID is written back to the sheet.
 *
 * Loop prevention:
 *   When direction 2 mutates the DB, it sets a per-property flag in
 *   `inFlightFromSheet` so the property route's afterWrite hook skips
 *   pushing back. Cleared after the next poll.
 *
 * Configuration via env vars (or fallback constants below):
 *   ASG_SHEET_ID        — Spreadsheet ID
 *   ASG_SHEET_TAB       — Tab name (default "Sheet1")
 *   GOOGLE_APPLICATION_CREDENTIALS — Service-account JSON path
 *   ASG_SHEETS_DISABLED — "1" to disable sync entirely
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');

let google = null;
try {
  google = require('googleapis').google;
} catch (e) {
  console.warn('[sheets-sync] googleapis not installed — sync disabled');
}

// ─── Config ────────────────────────────────────────────────────────
const SHEET_ID  = process.env.ASG_SHEET_ID  || '1IMOUHEN6P1K0rBXd4lNRm00a_U3xSALJtbGph0gBZ0w';
const SHEET_TAB = process.env.ASG_SHEET_TAB || 'Sheet1';
const CREDS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/var/asg/sa-creds.json';
const DISABLED  = process.env.ASG_SHEETS_DISABLED === '1';
const POLL_INTERVAL_MS = parseInt(process.env.ASG_SHEETS_POLL_MS || '60000', 10);

// Loop-prevention: ids currently being applied from sheet → DB.
const inFlightFromSheet = new Set();

// ─── Column schema ─────────────────────────────────────────────────
// Defines, in order, the columns of the sheet. Each entry maps the sheet
// header to the DB column. Order matters — it determines the cell range.
//
// SCHEMA[i].header  : exact header text in row 1 of the sheet
// SCHEMA[i].col     : DB column name (snake_case)
// SCHEMA[i].toDb    : optional transform sheetValue → dbValue
// SCHEMA[i].toSheet : optional transform dbValue → sheetValue
const SCHEMA = [
  { header: 'Property Name *',   col: 'holding_company' },
  { header: 'Type *',             col: '__type__',  // computed in transform; not a real DB col
                                   toDb: () => null, toSheet: () => 'Commercial' },
  { header: 'Unit Number',        col: 'unit_no' },
  { header: 'Property Usage',     col: 'usage' },
  { header: 'Trade License',      col: 'trade_license' },
  { header: 'Status',             col: 'status',
    toDb:    v => normalizeStatus(v),
    toSheet: v => v ? String(v).toUpperCase() : '' },
  { header: 'Location',           col: 'location' },
  { header: 'Plot No.',           col: 'plot_no' },
  { header: 'Size (sq ft)',       col: 'size',
    toDb:    v => parseNum(String(v).replace(/sq\.?\s*ft|sqft/i, '')),
    toSheet: v => v == null ? '' : `${v} sq.ft` },
  { header: 'Area (sq m)',        col: 'area',
    toDb:    v => parseNum(String(v).replace(/sqm|sq\.?\s*m/i, '')),
    toSheet: v => v == null ? '' : String(v) },
  { header: 'Compound',           col: 'compound' },
  { header: 'Mezzanine',          col: 'mezzanine' },
  { header: 'Ownership',          col: 'ownership',
    toDb:    v => v ? String(v).trim().toLowerCase() : null,
    toSheet: v => v || '' },
  { header: 'Partner Name',       col: 'partner_name' },
  { header: 'Our Share (%)',      col: 'our_share',
    toDb:    v => parseNum(String(v).replace('%', '')),
    toSheet: v => v == null ? '' : `${v}%` },
  { header: 'Property Owner',     col: 'owner_name' },
  { header: 'Owner Phone',        col: 'owner_phone' },
  { header: 'Management Fee',     col: 'mgmt_fee', toDb: parseNum },
  { header: 'Purchase Price',     col: 'purchase_price', toDb: parseNum },
  { header: 'Purchase Date',      col: 'purchase_date',
    toDb: parseDate, toSheet: v => v || '' },
  { header: 'Market Value',       col: 'market_value', toDb: parseNum },
  { header: 'Annual Rent',        col: 'annual_rent', toDb: parseNum,
    toSheet: v => v == null ? '' : String(v) },
  { header: 'Tenant Name',        col: 'tenant_name' },
  { header: 'Tenant Phone',       col: 'tenant_phone' },
  { header: 'Tenant Email',       col: 'tenant_email' },
  { header: 'Lease Start',        col: 'lease_start',
    toDb: parseDate, toSheet: v => v || '' },
  { header: 'Lease End',          col: 'lease_end',
    toDb: parseDate, toSheet: v => v || '' },
  { header: 'Reminder Days',      col: 'reminder_days', toDb: parseNum },
  { header: 'Map Link',           col: 'map_link' },
  { header: 'Coordinates',        col: 'coords' },
  { header: 'Notes',              col: 'notes' },
  // Sync-managed columns added at the end.
  { header: 'ID',                 col: 'id', toDb: v => parseInt(v, 10) || null,
                                  toSheet: v => v == null ? '' : String(v) },
  { header: 'Last Updated',       col: '__last_updated__',
                                  toDb: () => null,
                                  toSheet: () => new Date().toISOString() },
];

// ─── Helpers ───────────────────────────────────────────────────────
function parseNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/[,_\s]/g, '').replace(/[^0-9.+-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    let [_, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  return null;
}

function normalizeStatus(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase();
  if (s === 'VACANT') return 'vacant';
  if (s === 'ACTIVE' || s === 'RENTED') return 'rented';
  return 'rented';
}

function colLetter(idx) {
  // 0 → A, 25 → Z, 26 → AA, etc.
  let s = '';
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

const LAST_COL = colLetter(SCHEMA.length - 1);

// ─── Auth + client (lazy-initialized, cached) ─────────────────────
let _sheetsClient = null;
function sheetsClient() {
  if (DISABLED || !google) return null;
  if (_sheetsClient) return _sheetsClient;
  if (!fs.existsSync(CREDS_PATH)) {
    console.warn(`[sheets-sync] creds not found at ${CREDS_PATH} — sync disabled`);
    return null;
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

function isEnabled() { return !!sheetsClient(); }

// ─── Header alignment ──────────────────────────────────────────────
async function ensureSheetHeaders() {
  const sheets = sheetsClient();
  if (!sheets) return false;
  const range = `${SHEET_TAB}!A1:${LAST_COL}1`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const existing = (res.data.values && res.data.values[0]) || [];
  const desired = SCHEMA.map(s => s.header);
  const same = desired.length === existing.length &&
               desired.every((h, i) => h === existing[i]);
  if (!same) {
    console.log(`[sheets-sync] aligning headers (existing=${existing.length}, desired=${desired.length})`);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [desired] },
    });
  }
  return true;
}

// ─── Row ↔ DB record conversion ───────────────────────────────────
function rowToDb(row) {
  const out = {};
  SCHEMA.forEach((s, i) => {
    if (s.col.startsWith('__')) return; // computed-only column
    const raw = row[i];
    const v = s.toDb ? s.toDb(raw) : (raw === '' ? null : raw);
    out[s.col] = v == null || v === '' ? null : v;
  });
  return out;
}

function dbToRow(rec) {
  return SCHEMA.map(s => {
    if (s.col.startsWith('__')) {
      return s.toSheet ? s.toSheet() : '';
    }
    const v = rec[s.col];
    if (s.toSheet) return s.toSheet(v);
    return v == null ? '' : v;
  });
}

// ─── Find row index by ID column ──────────────────────────────────
const ID_COL_IDX = SCHEMA.findIndex(s => s.col === 'id');
const ID_COL_LETTER = colLetter(ID_COL_IDX);

async function findRowByPropertyId(id) {
  const sheets = sheetsClient();
  if (!sheets) return null;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!${ID_COL_LETTER}2:${ID_COL_LETTER}10000`,
  });
  const ids = (res.data.values || []).map(r => r[0]);
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i]) === String(id)) return i + 2;  // 1-indexed + header row
  }
  return null;
}

// ─── Direction 1: DB → Sheet ──────────────────────────────────────
async function pushPropertyToSheet(id) {
  const sheets = sheetsClient();
  if (!sheets) return;
  if (inFlightFromSheet.has(String(id))) return;  // loop prevention
  try {
    await ensureSheetHeaders();
    const row = getDb().prepare('SELECT * FROM properties WHERE id = ?').get(id);
    if (!row) {
      // Property deleted in DB — remove the matching sheet row
      const sheetRow = await findRowByPropertyId(id);
      if (sheetRow) {
        // Clearing the row content rather than deleting the row to preserve row stability.
        await sheets.spreadsheets.values.clear({
          spreadsheetId: SHEET_ID,
          range: `${SHEET_TAB}!A${sheetRow}:${LAST_COL}${sheetRow}`,
        });
        console.log(`[sheets-sync] cleared sheet row ${sheetRow} for deleted property ${id}`);
      }
      return;
    }
    const values = dbToRow(row);
    let sheetRow = await findRowByPropertyId(id);
    if (!sheetRow) {
      // Append new row
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_TAB}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] },
      });
      console.log(`[sheets-sync] appended row for property ${id}`);
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_TAB}!A${sheetRow}:${LAST_COL}${sheetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [values] },
      });
      console.log(`[sheets-sync] updated sheet row ${sheetRow} for property ${id}`);
    }
  } catch (e) {
    console.warn(`[sheets-sync] push failed for property ${id}:`, e.message);
  }
}

function pushPropertyToSheetAsync(id) {
  // Fire-and-forget. Errors logged inside.
  pushPropertyToSheet(id).catch(() => {});
}

// ─── Direction 2: Sheet → DB ──────────────────────────────────────
async function pollSheetIntoDb() {
  const sheets = sheetsClient();
  if (!sheets) return;
  try {
    await ensureSheetHeaders();
    const range = `${SHEET_TAB}!A2:${LAST_COL}10000`;
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
    const rows = res.data.values || [];

    // Pad short rows so all have SCHEMA.length entries
    const padded = rows.map(r => {
      const out = r.slice();
      while (out.length < SCHEMA.length) out.push('');
      return out;
    });

    // Skip blank rows (row with no content)
    const nonEmpty = padded.filter(r => r.some(c => c != null && String(c).trim() !== ''));

    const db = getDb();
    const dbRows = db.prepare('SELECT * FROM properties').all();
    const dbById = new Map(dbRows.map(r => [r.id, r]));

    let inserts = 0, updates = 0, idWritebacks = [];

    for (let i = 0; i < nonEmpty.length; i++) {
      const sheetIdx = i;        // 0-based among non-empty
      const rowVals  = nonEmpty[i];
      const parsed   = rowToDb(rowVals);
      const id       = parsed.id;
      delete parsed.id;          // never overwrite id from sheet content

      // Skip rows with no holding_company AND no unit_no — empty data row
      if (!parsed.holding_company && !parsed.unit_no) continue;

      // Compose name as "{holding} — {unit}" if both, or whichever exists
      if (parsed.holding_company && parsed.unit_no) {
        parsed.name = `${parsed.holding_company} — ${parsed.unit_no}`;
      } else {
        parsed.name = parsed.unit_no || parsed.holding_company;
      }

      // Type defaults to warehouse if not derivable
      const usage = (parsed.usage || '').toLowerCase();
      if (parsed.holding_company && /Schon Business Park|Empire Heights/i.test(parsed.holding_company)) {
        parsed.type = 'office';
      } else if (usage.includes('office') || usage.includes('retail')) {
        parsed.type = 'office';
      } else {
        parsed.type = 'warehouse';
      }

      if (id && dbById.has(id)) {
        // Update existing
        const existing = dbById.get(id);
        const changed = Object.keys(parsed).filter(k => {
          const a = existing[k] == null ? '' : String(existing[k]);
          const b = parsed[k]   == null ? '' : String(parsed[k]);
          return a !== b;
        });
        if (changed.length) {
          inFlightFromSheet.add(String(id));
          const sets = changed.map(k => `${k} = @${k}`).join(', ');
          db.prepare(`UPDATE properties SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`)
            .run({ ...parsed, id });
          updates++;
        }
        dbById.delete(id); // mark as seen
      } else {
        // New row from sheet — INSERT
        const cols = Object.keys(parsed).filter(k => parsed[k] != null);
        const placeholders = cols.map(c => `@${c}`).join(', ');
        const result = db.prepare(
          `INSERT INTO properties (${cols.join(', ')}) VALUES (${placeholders})`
        ).run(parsed);
        inserts++;
        // Record id-writeback so we update sheet column ID with the new DB id
        const newRowNumber = padded.indexOf(rowVals) + 2;  // 1-indexed + header
        idWritebacks.push({ rowNumber: newRowNumber, id: result.lastInsertRowid });
      }
    }

    // Clear the inFlight flags after a short delay
    setTimeout(() => inFlightFromSheet.clear(), 5000);

    // Write back IDs for new rows
    if (idWritebacks.length) {
      for (const { rowNumber, id } of idWritebacks) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${SHEET_TAB}!${ID_COL_LETTER}${rowNumber}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[id]] },
        }).catch(e => console.warn(`[sheets-sync] id-writeback failed row ${rowNumber}:`, e.message));
      }
    }

    if (inserts || updates) {
      console.log(`[sheets-sync] poll: ${inserts} inserts, ${updates} updates`);
    }
  } catch (e) {
    console.warn('[sheets-sync] poll failed:', e.message);
  }
}

// ─── Worker startup ───────────────────────────────────────────────
let pollTimer = null;

function startPoller() {
  if (DISABLED || pollTimer) return;
  if (!sheetsClient()) return;
  console.log(`[sheets-sync] starting poller every ${POLL_INTERVAL_MS}ms (sheet=${SHEET_ID})`);
  // Run once on startup, then on interval
  pollSheetIntoDb();
  pollTimer = setInterval(pollSheetIntoDb, POLL_INTERVAL_MS);
}

function stopPoller() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = {
  isEnabled,
  pushPropertyToSheetAsync,
  pollSheetIntoDb,
  startPoller,
  stopPoller,
  SCHEMA,
};
