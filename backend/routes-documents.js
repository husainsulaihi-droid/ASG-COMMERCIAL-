/**
 * Shared documents — exactly two editable slots, visible to every
 * logged-in user. Used by the Documents tab.
 *
 *   GET    /api/documents          — returns both slots (shared)
 *   PUT    /api/documents/:slot    — upsert html + name + filename
 *   DELETE /api/documents/:slot    — clear the slot
 *
 * No per-user scoping. Last-write-wins.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth } = require('./middleware');
const { rowToApi } = require('./utils');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const rows = getDb().prepare(
    'SELECT * FROM documents ORDER BY slot ASC'
  ).all();
  res.json({ documents: rows.map(rowToApi) });
});

router.put('/:slot', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (slot !== 1 && slot !== 2) {
    return res.status(400).json({ error: 'slot must be 1 or 2' });
  }
  const { name, filename, html } = req.body || {};
  const db = getDb();

  const existing = db.prepare('SELECT id FROM documents WHERE slot = ?').get(slot);
  if (existing) {
    db.prepare(`
      UPDATE documents
         SET name = ?, filename = ?, html = ?,
             updated_by_id = ?, updated_by_name = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(name ?? null, filename ?? null, html ?? null,
           req.user.id, req.user.name, existing.id);
  } else {
    db.prepare(`
      INSERT INTO documents (slot, name, filename, html, updated_by_id, updated_by_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(slot, name ?? null, filename ?? null, html ?? null,
           req.user.id, req.user.name);
  }

  const row = db.prepare('SELECT * FROM documents WHERE slot = ?').get(slot);
  res.json({ document: rowToApi(row) });
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
