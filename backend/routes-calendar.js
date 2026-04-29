/**
 * Calendar events (custom standalone events on the calendar tab).
 *
 *   GET    /api/calendar
 *   POST   /api/calendar
 *   PATCH  /api/calendar/:id
 *   DELETE /api/calendar/:id
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();
const FIELDS = ['date', 'title', 'event_type', 'time', 'note'];

router.get('/', requireAuth, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM calendar_events ORDER BY date').all();
  res.json({ events: rows.map(rowToApi) });
});

router.post('/', requireAdmin, (req, res) => {
  const data = bodyToDb(req.body, FIELDS);
  if (!data.date || !data.title) return res.status(400).json({ error: 'date and title required' });
  const cols = Object.keys(data);
  const ph = cols.map(() => '?').join(', ');
  const result = getDb().prepare(
    `INSERT INTO calendar_events (${cols.join(', ')}) VALUES (${ph})`
  ).run(...cols.map(c => data[c]));
  const row = getDb().prepare('SELECT * FROM calendar_events WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ event: rowToApi(row) });
});

router.patch('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const data = bodyToDb(req.body, FIELDS);
  if (!Object.keys(data).length) {
    const row = getDb().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Event not found' });
    return res.json({ event: rowToApi(row) });
  }
  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  const r = getDb().prepare(`UPDATE calendar_events SET ${sets} WHERE id = ?`).run(...values);
  if (r.changes === 0) return res.status(404).json({ error: 'Event not found' });
  const row = getDb().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  res.json({ event: rowToApi(row) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = getDb().prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Event not found' });
  res.json({ ok: true });
});

module.exports = router;
