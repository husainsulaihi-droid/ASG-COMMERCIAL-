/**
 * Construction projects (warehouse builds, extensions, renovations).
 *
 *   GET    /api/construction
 *   GET    /api/construction/:id
 *   POST   /api/construction
 *   PATCH  /api/construction/:id
 *   DELETE /api/construction/:id
 *
 * Each record's snapshot is written to /var/asg/uploads/_projects/<name>/.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');
const { writeRecordFolder, renameFolderIfNameChanged, deleteRecordFolder } = require('./record-folder-export');

const router = express.Router();

const FIELDS = [
  'name', 'property_id', 'location', 'type', 'status', 'contractor',
  'contractor_phone', 'start_date', 'expected_completion', 'budget',
  'spent_to_date', 'progress', 'notes',
];

router.get('/', requireAuth, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM construction_projects ORDER BY created_at DESC').all();
  res.json({ projects: rows.map(rowToApi) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM construction_projects WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: rowToApi(row) });
});

router.post('/', requireAdmin, (req, res) => {
  const data = bodyToDb(req.body, FIELDS);
  if (!data.name) return res.status(400).json({ error: 'name required' });
  const cols = Object.keys(data);
  const ph = cols.map(() => '?').join(', ');
  const result = getDb().prepare(
    `INSERT INTO construction_projects (${cols.join(', ')}) VALUES (${ph})`
  ).run(...cols.map(c => data[c]));
  const row = getDb().prepare('SELECT * FROM construction_projects WHERE id = ?').get(result.lastInsertRowid);
  writeRecordFolder('projects', row.id);
  res.status(201).json({ project: rowToApi(row) });
});

router.patch('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM construction_projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const data = bodyToDb(req.body, FIELDS);
  if (!Object.keys(data).length) return res.json({ project: rowToApi(existing) });

  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(
    `UPDATE construction_projects SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM construction_projects WHERE id = ?').get(id);

  if (data.name && data.name !== existing.name) renameFolderIfNameChanged('projects', id);
  writeRecordFolder('projects', id);
  res.json({ project: rowToApi(row) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT folder_name FROM construction_projects WHERE id = ?').get(id);
  const r = getDb().prepare('DELETE FROM construction_projects WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Project not found' });
  if (existing) deleteRecordFolder('projects', existing.folder_name);
  res.json({ ok: true });
});

module.exports = router;
