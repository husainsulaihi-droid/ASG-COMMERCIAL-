/**
 * Disputes (legal cases per property).
 *
 *   GET    /api/disputes
 *   GET    /api/disputes/:id
 *   POST   /api/disputes
 *   PATCH  /api/disputes/:id
 *   DELETE /api/disputes/:id
 *
 * Each record's snapshot is also written to /var/asg/uploads/_disputes/<title>/.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');
const { writeRecordFolder, renameFolderIfNameChanged, deleteRecordFolder } = require('./record-folder-export');

const router = express.Router();

const FIELDS = [
  'title', 'property_id', 'type', 'status', 'case_no', 'court', 'opponent',
  'filing_date', 'next_hearing_date', 'amount_disputed', 'lawyer',
  'lawyer_phone', 'notes',
];

router.get('/', requireAuth, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM disputes ORDER BY created_at DESC').all();
  res.json({ disputes: rows.map(rowToApi) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Dispute not found' });
  res.json({ dispute: rowToApi(row) });
});

router.post('/', requireAdmin, (req, res) => {
  const data = bodyToDb(req.body, FIELDS);
  if (!data.title) return res.status(400).json({ error: 'title required' });
  const cols = Object.keys(data);
  const ph = cols.map(() => '?').join(', ');
  const result = getDb().prepare(
    `INSERT INTO disputes (${cols.join(', ')}) VALUES (${ph})`
  ).run(...cols.map(c => data[c]));
  const row = getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(result.lastInsertRowid);
  writeRecordFolder('disputes', row.id);
  res.status(201).json({ dispute: rowToApi(row) });
});

router.patch('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Dispute not found' });

  const data = bodyToDb(req.body, FIELDS);
  if (!Object.keys(data).length) return res.json({ dispute: rowToApi(existing) });

  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(
    `UPDATE disputes SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(id);

  if (data.title && data.title !== existing.title) renameFolderIfNameChanged('disputes', id);
  writeRecordFolder('disputes', id);
  res.json({ dispute: rowToApi(row) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT folder_name FROM disputes WHERE id = ?').get(id);
  const r = getDb().prepare('DELETE FROM disputes WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Dispute not found' });
  if (existing) deleteRecordFolder('disputes', existing.folder_name);
  res.json({ ok: true });
});

module.exports = router;
