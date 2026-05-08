/**
 * Seed the two shared document slots from files dropped on the VPS.
 *
 * Drop your originals at:
 *
 *   /var/asg/documents/slot1.pdf   (or slot1.docx)
 *   /var/asg/documents/slot2.pdf   (or slot2.docx)
 *
 * On server startup, this scans that directory and ingests any file
 * for a slot that's currently empty. Already-populated slots are left
 * alone (call /api/documents/reload to force-replace them).
 *
 * The directory path is configurable via SEED_DOCS_DIR; defaults to
 * /var/asg/documents which lives outside the git checkout so redeploys
 * never touch it.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');

const DOCS_DIR = process.env.SEED_DOCS_DIR || '/var/asg/documents';

const MIME_BY_EXT = {
  '.pdf':  'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function findFileForSlot(slot) {
  if (!fs.existsSync(DOCS_DIR)) return null;
  for (const ext of ['.pdf', '.docx']) {
    const p = path.join(DOCS_DIR, `slot${slot}${ext}`);
    if (fs.existsSync(p)) return { path: p, ext, mime: MIME_BY_EXT[ext] };
  }
  return null;
}

function ingestSlot(slot, opts = {}) {
  const { force = false } = opts;
  const file = findFileForSlot(slot);
  if (!file) return { slot, status: 'no_file' };

  const db = getDb();
  const existing = db.prepare(
    'SELECT id, file_data, html FROM documents WHERE slot = ?'
  ).get(slot);

  if (existing && !force) {
    return { slot, status: 'exists', skipped: true };
  }

  const buf = fs.readFileSync(file.path);
  const filename = path.basename(file.path);

  if (existing) {
    db.prepare(`
      UPDATE documents
         SET filename = ?, mime = ?, file_data = ?,
             html = NULL,
             updated_by_id = NULL,
             updated_by_name = 'VPS seed',
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(filename, file.mime, buf, existing.id);
  } else {
    db.prepare(`
      INSERT INTO documents (slot, name, filename, mime, file_data, updated_by_name)
      VALUES (?, ?, ?, ?, ?, 'VPS seed')
    `).run(slot, null, filename, file.mime, buf);
  }
  return { slot, status: 'ingested', filename, size: buf.length };
}

function seedAll(opts = {}) {
  const results = [];
  for (const slot of [1, 2]) {
    try { results.push(ingestSlot(slot, opts)); }
    catch (e) {
      console.warn(`[seed-documents] slot ${slot} failed:`, e.message);
      results.push({ slot, status: 'error', error: e.message });
    }
  }
  return results;
}

module.exports = { seedAll, ingestSlot, DOCS_DIR };

// Allow running directly: `node backend/seed-documents.js [--force]`
if (require.main === module) {
  const force = process.argv.includes('--force');
  const { initDb } = require('./db');
  initDb();
  const results = seedAll({ force });
  console.log(`[seed-documents] dir=${DOCS_DIR} force=${force}`);
  for (const r of results) console.log(JSON.stringify(r));
}
