/**
 * Tasks (to-do items, optionally tied to a property).
 *
 *   GET    /api/tasks
 *   GET    /api/tasks/:id
 *   POST   /api/tasks
 *   PATCH  /api/tasks/:id
 *   DELETE /api/tasks/:id
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const FIELDS = [
  'title', 'property_id', 'priority', 'status', 'due_date',
  'notes', 'assigned_to',
];

router.get('/', requireAuth, (req, res) => {
  const rows = getDb().prepare(`
    SELECT * FROM tasks
    ORDER BY
      CASE status WHEN 'done' THEN 1 ELSE 0 END,       -- open first
      CASE priority
        WHEN 'urgent' THEN 0
        WHEN 'high'   THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low'    THEN 3
        ELSE 4
      END,
      due_date ASC,
      created_at DESC
  `).all();
  res.json({ tasks: rows.map(rowToApi) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Task not found' });
  res.json({ task: rowToApi(row) });
});

router.post('/', requireAuth, (req, res) => {
  const data = bodyToDb(req.body, FIELDS);
  if (!data.title) return res.status(400).json({ error: 'title required' });
  if (!data.status)   data.status   = 'pending';
  if (!data.priority) data.priority = 'medium';
  const cols = Object.keys(data);
  const ph = cols.map(() => '?').join(', ');
  const result = getDb().prepare(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${ph})`
  ).run(...cols.map(c => data[c]));
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ task: rowToApi(row) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const data = bodyToDb(req.body, FIELDS);
  if (!Object.keys(data).length) return res.json({ task: rowToApi(existing) });

  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(
    `UPDATE tasks SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.json({ task: rowToApi(row) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true });
});

module.exports = router;
