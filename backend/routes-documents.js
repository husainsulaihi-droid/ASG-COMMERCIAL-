/**
 * Shared documents — exactly two editable slots, visible to every
 * logged-in user. Used by the Documents tab.
 *
 *   GET    /api/documents             — list both slots (no binary in body)
 *   PUT    /api/documents/:slot       — upsert html / name / filename
 *                                       and (optionally) the original
 *                                       file (base64-encoded under
 *                                       fileData + mime).
 *   GET    /api/documents/:slot/file  — raw original file (PDF/docx)
 *   DELETE /api/documents/:slot       — clear the slot (binary + html)
 *
 * Last-write-wins. No per-user scoping.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth } = require('./middleware');
const { rowToApi } = require('./utils');
const { seedAll, DOCS_DIR } = require('./seed-documents');

const router = express.Router();

// Force-reload from VPS seed directory. Admin only — replaces any
// existing slot content with the file currently on disk.
router.post('/reload', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const results = seedAll({ force: true });
  res.json({ dir: DOCS_DIR, results });
});

// Strip the heavy BLOB before serializing — we don't ship binaries in
// list responses; the dedicated /:slot/file endpoint is for that.
function withoutBlob(row) {
  if (!row) return null;
  const api = rowToApi(row);
  if (api.fileData) {
    api.hasFile  = true;
    api.fileSize = api.fileData.length || 0;
    delete api.fileData;
  } else {
    api.hasFile = false;
  }
  return api;
}

router.get('/', requireAuth, (req, res) => {
  const rows = getDb().prepare(
    'SELECT id, slot, name, filename, mime, html, updated_by_id, updated_by_name, created_at, updated_at, length(file_data) AS file_size FROM documents ORDER BY slot ASC'
  ).all();
  res.json({
    documents: rows.map(r => {
      const api = rowToApi(r);
      api.hasFile = !!api.fileSize;
      return api;
    })
  });
});

router.put('/:slot', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (slot !== 1 && slot !== 2) {
    return res.status(400).json({ error: 'slot must be 1 or 2' });
  }
  const { name, filename, mime, html, fileData } = req.body || {};
  const db = getDb();

  // Decode base64 file if provided. Empty string means "leave unchanged",
  // null means "clear the binary".
  let blob;
  let blobProvided = false;
  if (fileData === null) {
    blob = null;
    blobProvided = true;
  } else if (typeof fileData === 'string' && fileData.length) {
    try {
      blob = Buffer.from(fileData, 'base64');
      blobProvided = true;
    } catch (e) {
      return res.status(400).json({ error: 'fileData is not valid base64' });
    }
  }

  const existing = db.prepare('SELECT id FROM documents WHERE slot = ?').get(slot);

  if (existing) {
    if (blobProvided) {
      db.prepare(`
        UPDATE documents
           SET name = ?, filename = ?, mime = ?, file_data = ?, html = ?,
               updated_by_id = ?, updated_by_name = ?,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(name ?? null, filename ?? null, mime ?? null, blob, html ?? null,
             req.user.id, req.user.name, existing.id);
    } else {
      db.prepare(`
        UPDATE documents
           SET name = ?, filename = ?, html = ?,
               updated_by_id = ?, updated_by_name = ?,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(name ?? null, filename ?? null, html ?? null,
             req.user.id, req.user.name, existing.id);
    }
  } else {
    db.prepare(`
      INSERT INTO documents (slot, name, filename, mime, file_data, html, updated_by_id, updated_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(slot, name ?? null, filename ?? null, mime ?? null,
           blobProvided ? blob : null, html ?? null,
           req.user.id, req.user.name);
  }

  // Return the row WITHOUT the blob — keeps the response light.
  const row = db.prepare(
    'SELECT id, slot, name, filename, mime, html, updated_by_id, updated_by_name, created_at, updated_at, length(file_data) AS file_size FROM documents WHERE slot = ?'
  ).get(slot);
  const api = rowToApi(row);
  api.hasFile = !!api.fileSize;
  res.json({ document: api });
});

router.get('/:slot/file', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (slot !== 1 && slot !== 2) {
    return res.status(400).json({ error: 'slot must be 1 or 2' });
  }
  const row = getDb().prepare(
    'SELECT filename, mime, file_data FROM documents WHERE slot = ?'
  ).get(slot);
  if (!row || !row.file_data) {
    return res.status(404).json({ error: 'No original file stored for this slot' });
  }
  res.set('Content-Type', row.mime || 'application/octet-stream');
  // inline so PDFs render in the browser; the user clicks Print from there.
  // For .docx the browser will offer to download — that's fine.
  if (row.filename) {
    res.set('Content-Disposition', `inline; filename="${row.filename.replace(/"/g, '')}"`);
  }
  res.send(row.file_data);
});

router.delete('/:slot', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (slot !== 1 && slot !== 2) {
    return res.status(400).json({ error: 'slot must be 1 or 2' });
  }
  getDb().prepare('DELETE FROM documents WHERE slot = ?').run(slot);
  res.json({ ok: true });
});

module.exports = router;
