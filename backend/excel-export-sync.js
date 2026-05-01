/**
 * Auto-sync the live Excel export. Triggered after every property/cheque
 * mutation:
 *
 *   1. Build an .xlsx from the current DB (Properties + Cheques sheets).
 *   2. Write it to /var/asg/exports/asg-export.xlsx (single rolling file).
 *   3. Upload/replace the same file in the Google Drive root folder.
 *
 * Debounced so a burst of saves results in one regeneration. The Drive
 * file ID is cached on disk so subsequent uploads update in place rather
 * than creating a new file each time.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { getDb } = require('./db');

let google = null;
try { google = require('googleapis').google; } catch (e) {}

const EXPORTS_DIR     = process.env.ASG_EXPORTS_DIR || '/var/asg/exports';
const EXPORT_PATH     = path.join(EXPORTS_DIR, 'asg-export.xlsx');
const FILE_ID_CACHE   = path.join(EXPORTS_DIR, '.asg-export-drive-id');
const ROOT_FOLDER_ID  = process.env.ASG_DRIVE_ROOT || '1xFnOXiUkeGIoO5FVYwaChD52AwEjp5Zy';
const CREDS_PATH      = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/var/asg/sa-creds.json';
const DISABLED        = process.env.ASG_DRIVE_DISABLED === '1';
const FILENAME        = 'asg-export.xlsx';
const MIME_XLSX       = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DEBOUNCE_MS     = 2000;

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

let _drive = null;
function driveClient() {
  if (DISABLED || !google) return null;
  if (_drive) return _drive;
  if (!fs.existsSync(CREDS_PATH)) return null;
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

async function uploadToDrive(localPath) {
  const drive = driveClient();
  if (!drive) return null;

  let fileId = null;
  try { fileId = fs.readFileSync(FILE_ID_CACHE, 'utf8').trim() || null; } catch (_) {}

  if (fileId) {
    try {
      await drive.files.update({
        fileId,
        media: { mimeType: MIME_XLSX, body: fs.createReadStream(localPath) },
      });
      return fileId;
    } catch (e) {
      if (e.code !== 404) console.warn('[excel-sync] cached fileId update failed:', e.message);
      fileId = null;
    }
  }

  const escaped = FILENAME.replace(/'/g, "\\'");
  const found = await drive.files.list({
    q: `name='${escaped}' and '${ROOT_FOLDER_ID}' in parents and trashed=false`,
    fields: 'files(id)',
    pageSize: 1,
  });
  if (found.data.files && found.data.files.length) {
    fileId = found.data.files[0].id;
    await drive.files.update({
      fileId,
      media: { mimeType: MIME_XLSX, body: fs.createReadStream(localPath) },
    });
  } else {
    const created = await drive.files.create({
      requestBody: { name: FILENAME, parents: [ROOT_FOLDER_ID] },
      media: { mimeType: MIME_XLSX, body: fs.createReadStream(localPath) },
      fields: 'id',
    });
    fileId = created.data.id;
  }
  try { fs.writeFileSync(FILE_ID_CACHE, fileId); } catch (_) {}
  return fileId;
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
    try {
      await uploadToDrive(EXPORT_PATH);
    } catch (e) {
      console.warn('[excel-sync] drive upload failed:', e.message);
    }
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
