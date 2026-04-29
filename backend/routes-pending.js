/**
 * Pending property submissions — agents submit, admin approves/rejects.
 *
 *   GET    /api/pending-properties           — admin: all; agent: own
 *   GET    /api/pending-properties/:id       — admin or own
 *   POST   /api/pending-properties           — agent submits
 *   PATCH  /api/pending-properties/:id       — admin only (approve/reject + admin_note)
 *   DELETE /api/pending-properties/:id       — admin or owner
 *
 * Approval moves the record into the `properties` table (admin pulls
 * the trigger). For now, that copy step lives client-side in the
 * existing approve flow — backend just owns the queue.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const FIELDS = [
  'name', 'type', 'location', 'size', 'annual_rent', 'ownership',
  'description', 'client_name', 'client_phone',
  'status', 'admin_note',
  'added_by_id', 'added_by_name'
];

router.get('/', requireAuth, (req, res) => {
  const rows = req.user.role === 'admin'
    ? getDb().prepare('SELECT * FROM pending_properties ORDER BY submitted_at DESC').all()
    : getDb().prepare('SELECT * FROM pending_properties WHERE added_by_id = ? ORDER BY submitted_at DESC').all(req.user.id);
  res.json({ submissions: rows.map(rowToApi) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM pending_properties WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Submission not found' });
  if (req.user.role !== 'admin' && row.added_by_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ submission: rowToApi(row) });
});

router.post('/', requireAuth, (req, res) => {
  const data = bodyToDb(req.body, FIELDS);
  if (!data.name) return res.status(400).json({ error: 'name required' });

  data.added_by_id   = req.user.id;
  data.added_by_name = req.user.name;
  if (!data.status)  data.status = 'pending';

  const cols = Object.keys(data);
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO pending_properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM pending_properties WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ submission: rowToApi(row) });
});

router.patch('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM pending_properties WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Submission not found' });

  const data = bodyToDb(req.body, FIELDS);
  if (!Object.keys(data).length) return res.json({ submission: rowToApi(existing) });
  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(`UPDATE pending_properties SET ${sets} WHERE id = ?`).run(...values);
  const row = getDb().prepare('SELECT * FROM pending_properties WHERE id = ?').get(id);
  res.json({ submission: rowToApi(row) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM pending_properties WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Submission not found' });
  if (req.user.role !== 'admin' && req.user.id !== existing.added_by_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  getDb().prepare('DELETE FROM pending_properties WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
