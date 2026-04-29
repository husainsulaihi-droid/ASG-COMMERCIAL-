/**
 * Off-plan: developers + projects.
 *
 * Developers:
 *   GET    /api/offplan/developers              — any user
 *   GET    /api/offplan/developers/:id          — any user
 *   POST   /api/offplan/developers              — admin only
 *   PATCH  /api/offplan/developers/:id          — admin only
 *   DELETE /api/offplan/developers/:id          — admin only (cascades to projects)
 *
 * Projects:
 *   GET    /api/offplan/projects                — any user; supports ?developerId=
 *   GET    /api/offplan/projects/:id            — any user
 *   POST   /api/offplan/projects                — admin only
 *   PATCH  /api/offplan/projects/:id            — admin only
 *   DELETE /api/offplan/projects/:id            — admin only
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const DEV_FIELDS = ['name', 'region', 'website', 'brief', 'data_source'];
const PROJ_FIELDS = [
  'developer_id', 'name', 'status', 'type', 'location', 'unit_mix',
  'launch_date', 'handover_date', 'price_from', 'price_to',
  'payment_plan', 'amenities', 'description', 'data_source'
];

// ─── Developers ──────────────────────────────────

router.get('/developers', requireAuth, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM developers ORDER BY name').all();
  res.json({ developers: rows.map(rowToApi) });
});

router.get('/developers/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM developers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Developer not found' });
  res.json({ developer: rowToApi(row) });
});

router.post('/developers', requireAdmin, (req, res) => {
  const data = bodyToDb(req.body, DEV_FIELDS);
  if (!data.name) return res.status(400).json({ error: 'name required' });
  if (!data.data_source) data.data_source = 'manual';
  const cols = Object.keys(data);
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO developers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM developers WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ developer: rowToApi(row) });
});

router.patch('/developers/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM developers WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Developer not found' });
  const data = bodyToDb(req.body, DEV_FIELDS);
  if (!Object.keys(data).length) return res.json({ developer: rowToApi(existing) });
  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(`UPDATE developers SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const row = getDb().prepare('SELECT * FROM developers WHERE id = ?').get(id);
  res.json({ developer: rowToApi(row) });
});

router.delete('/developers/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Schema has ON DELETE CASCADE for offplan_projects.developer_id
  const r = getDb().prepare('DELETE FROM developers WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Developer not found' });
  res.json({ ok: true });
});

// ─── Projects ────────────────────────────────────

router.get('/projects', requireAuth, (req, res) => {
  const devId = req.query.developerId ? parseInt(req.query.developerId, 10) : null;
  const rows = devId
    ? getDb().prepare('SELECT * FROM offplan_projects WHERE developer_id = ? ORDER BY name').all(devId)
    : getDb().prepare('SELECT * FROM offplan_projects ORDER BY name').all();
  res.json({ projects: rows.map(rowToApi) });
});

router.get('/projects/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM offplan_projects WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: rowToApi(row) });
});

router.post('/projects', requireAdmin, (req, res) => {
  const data = bodyToDb(req.body, PROJ_FIELDS);
  if (!data.developer_id) return res.status(400).json({ error: 'developerId required' });
  if (!data.name)         return res.status(400).json({ error: 'name required' });
  if (!data.location)     return res.status(400).json({ error: 'location required' });
  if (!data.data_source)  data.data_source = 'manual';

  const cols = Object.keys(data);
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO offplan_projects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM offplan_projects WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ project: rowToApi(row) });
});

router.patch('/projects/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM offplan_projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  const data = bodyToDb(req.body, PROJ_FIELDS);
  if (!Object.keys(data).length) return res.json({ project: rowToApi(existing) });
  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(`UPDATE offplan_projects SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const row = getDb().prepare('SELECT * FROM offplan_projects WHERE id = ?').get(id);
  res.json({ project: rowToApi(row) });
});

router.delete('/projects/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = getDb().prepare('DELETE FROM offplan_projects WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

module.exports = router;
