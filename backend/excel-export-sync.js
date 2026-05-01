/**
 * Auto-regenerate the rolling Excel export.
 *
 * Triggered after every property/cheque mutation. Builds an .xlsx from
 * the current DB (Properties + Cheques sheets) and writes it to a single
 * rolling file at /var/asg/exports/asg-export.xlsx. Debounced 2s so a
 * burst of saves results in one regeneration.
 *
 * The dashboard's "Export to Excel" button (GET /api/export/xlsx) is the
 * download path. The full backup endpoint can also archive this file.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { getDb } = require('./db');

const EXPORTS_DIR = process.env.ASG_EXPORTS_DIR || '/var/asg/exports';
const EXPORT_PATH = path.join(EXPORTS_DIR, 'asg-export.xlsx');
const DEBOUNCE_MS = 2000;

function ensureDir() {
  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

function buildBuffer() {
  const db = getDb();
  const properties = db.prepare('SELECT * FROM properties ORDER BY id').all();
  const cheques = db.prepare(`
    SELECT c.*, p.name AS property_name, p.unit_no AS property_unit_no
      FROM property_cheques c
      LEFT JOIN properties p ON p.id = c.property_id
     ORDER BY c.property_id, c.cheque_num
  `).all();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(properties), 'Properties');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cheques),    'Cheques');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

let _inflight = false;
let _pending  = false;
let _timer    = null;

async function runSync() {
  if (_inflight) { _pending = true; return; }
  _inflight = true;
  try {
    ensureDir();
    fs.writeFileSync(EXPORT_PATH, buildBuffer());
  } catch (e) {
    console.error('[excel-sync] regeneration failed:', e.message);
  } finally {
    _inflight = false;
    if (_pending) { _pending = false; setImmediate(runSync); }
  }
}

function trigger() {
  clearTimeout(_timer);
  _timer = setTimeout(runSync, DEBOUNCE_MS);
}

module.exports = { trigger, runSync, EXPORT_PATH };
