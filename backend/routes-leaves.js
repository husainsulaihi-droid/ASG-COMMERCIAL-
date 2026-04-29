/**
 * Agent leaves (time off).
 *
 *   GET    /api/leaves                — admin: all; team leader: own + reports; agent: own
 *   GET    /api/leaves/:id            — same visibility as list
 *   POST   /api/leaves                — admin / leader / agent (self only for agents)
 *   PATCH  /api/leaves/:id            — admin / leader / owner
 *   DELETE /api/leaves/:id            — admin / leader / owner
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const LEAVE_FIELDS = ['agent_id', 'start_date', 'end_date', 'reason'];

function teamOf(leaderId) {
  return getDb().prepare('SELECT id FROM users WHERE team_leader_id = ?').all(leaderId).map(r => r.id);
}

function canSee(user, leave) {
  if (user.role === 'admin') return true;
  if (user.id === leave.agent_id) return true;
  if (user.isTeamLeader) return teamOf(user.id).includes(leave.agent_id);
  return false;
}

function canCreateFor(user, agentId) {
  if (user.role === 'admin') return true;
  if (agentId == null || agentId === user.id) return true;
  if (!user.isTeamLeader) return false;
  return teamOf(user.id).includes(parseInt(agentId, 10));
}

router.get('/', requireAuth, (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = getDb().prepare('SELECT * FROM leaves ORDER BY start_date DESC').all();
  } else if (req.user.isTeamLeader) {
    rows = getDb().prepare(`
      SELECT * FROM leaves WHERE agent_id = ? OR agent_id IN (SELECT id FROM users WHERE team_leader_id = ?)
      ORDER BY start_date DESC
    `).all(req.user.id, req.user.id);
  } else {
    rows = getDb().prepare('SELECT * FROM leaves WHERE agent_id = ? ORDER BY start_date DESC').all(req.user.id);
  }
  res.json({ leaves: rows.map(rowToApi) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM leaves WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Leave not found' });
  if (!canSee(req.user, row)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ leave: rowToApi(row) });
});

router.post('/', requireAuth, (req, res) => {
  const data = bodyToDb(req.body, LEAVE_FIELDS);
  if (data.agent_id == null) data.agent_id = req.user.id;
  if (!canCreateFor(req.user, data.agent_id)) return res.status(403).json({ error: 'Cannot create leave for that agent' });
  if (!data.start_date) return res.status(400).json({ error: 'startDate required' });
  if (!data.end_date)   return res.status(400).json({ error: 'endDate required' });

  const cols = Object.keys(data);
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO leaves (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM leaves WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ leave: rowToApi(row) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM leaves WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Leave not found' });
  if (!canSee(req.user, existing)) return res.status(403).json({ error: 'Forbidden' });

  const data = bodyToDb(req.body, LEAVE_FIELDS);
  if (data.agent_id !== undefined && data.agent_id !== existing.agent_id && !canCreateFor(req.user, data.agent_id)) {
    return res.status(403).json({ error: 'Cannot reassign leave to that agent' });
  }
  if (!Object.keys(data).length) return res.json({ leave: rowToApi(existing) });
  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(`UPDATE leaves SET ${sets} WHERE id = ?`).run(...values);
  const row = getDb().prepare('SELECT * FROM leaves WHERE id = ?').get(id);
  res.json({ leave: rowToApi(row) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM leaves WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Leave not found' });
  if (!canSee(req.user, existing)) return res.status(403).json({ error: 'Forbidden' });
  getDb().prepare('DELETE FROM leaves WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
