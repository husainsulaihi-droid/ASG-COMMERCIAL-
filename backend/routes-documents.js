/**
 * Per-user persistent documents — two editable slots per user.
 *
 *   GET  /api/documents          — returns the caller's two slots
 *   PUT  /api/documents/:slot    — upsert html + name + filename for slot
 *
 * Used by the Documents tab. There's no "list everyone" endpoint — each
 * user only sees their own. Admins are users too.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth } = require('./middleware');
const { rowToApi } = require('./utils');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const rows = getDb().prepare(
    'SELECT * FROM documents WHERE owner_id = ? ORDER BY slot ASC'
  ).all(req.user.id);
  res.json({ documents: rows.map(rowToApi) });
});

router.put('/:slot', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (slot !== 1 && slot !== 2) {
    return res.status(400).json({ error: 'slot must be 1 or 2' });
  }
  const { name, filename, html } = req.body || {};
  const db = getDb();

  const existing = db.prepare(
    'SELECT id FROM documents WHERE owner_id = ? AND slot = ?'
  ).get(req.user.id, slot);

  if (existing) {
    db.prepare(`
      UPDATE documents
         SET name = ?, filename = ?, html = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(name ?? null, filename ?? null, html ?? null, existing.id);
  } else {
    db.prepare(`
      INSERT INTO documents (owner_id, slot, name, filename, html)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, slot, name ?? null, filename ?? null, html ?? null);
  }

  const row = db.prepare(
    'SELECT * FROM documents WHERE owner_id = ? AND slot = ?'
  ).get(req.user.id, slot);
  res.json({ document: rowToApi(row) });
});

router.delete('/:slot', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (slot !== 1 && slot !== 2) {
    return res.status(400).json({ error: 'slot must be 1 or 2' });
  }
  getDb().prepare(
    'DELETE FROM documents WHERE owner_id = ? AND slot = ?'
  ).run(req.user.id, slot);
  res.json({ ok: true });
});

module.exports = router;
