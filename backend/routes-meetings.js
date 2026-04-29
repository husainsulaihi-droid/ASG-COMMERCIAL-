/**
 * Meetings & Viewings.
 *
 *   GET    /api/meetings                        — list (own / team / all)
 *   GET    /api/meetings/:id
 *   POST   /api/meetings                        — any user, defaults agentId to self
 *   PATCH  /api/meetings/:id                    — agent of meeting / leader / admin
 *   DELETE /api/meetings/:id                    — admin / leader-of-agent
 *
 *   GET    /api/meetings/:id/notes              — conversation thread
 *   POST   /api/meetings/:id/notes              — add a note
 *
 * Visibility rules mirror tasks/leads (admin all; team leader self+team; agent self).
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const MEETING_FIELDS = [
  'type', 'status', 'agent_id', 'agent_name', 'lead_id', 'property_id',
  'meeting_date', 'meeting_time', 'location'
];

function teamOf(leaderId) {
  return getDb().prepare('SELECT id FROM users WHERE team_leader_id = ?').all(leaderId).map(r => r.id);
}

function canSee(user, m) {
  if (user.role === 'admin') return true;
  if (user.id === m.agent_id) return true;
  if (user.isTeamLeader) return teamOf(user.id).includes(m.agent_id);
  return false;
}
function canAssignTo(user, agentId) {
  if (user.role === 'admin') return true;
  if (agentId == null || agentId === user.id) return true;
  if (!user.isTeamLeader) return false;
  return teamOf(user.id).includes(parseInt(agentId, 10));
}

router.get('/', requireAuth, (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = getDb().prepare('SELECT * FROM meetings ORDER BY meeting_date DESC, meeting_time DESC').all();
  } else if (req.user.isTeamLeader) {
    rows = getDb().prepare(`
      SELECT * FROM meetings
      WHERE agent_id = ? OR agent_id IN (SELECT id FROM users WHERE team_leader_id = ?)
      ORDER BY meeting_date DESC, meeting_time DESC
    `).all(req.user.id, req.user.id);
  } else {
    rows = getDb().prepare('SELECT * FROM meetings WHERE agent_id = ? ORDER BY meeting_date DESC').all(req.user.id);
  }
  res.json({ meetings: rows.map(rowToApi) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const m = getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  if (!canSee(req.user, m)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ meeting: rowToApi(m) });
});

router.post('/', requireAuth, (req, res) => {
  const data = bodyToDb(req.body, MEETING_FIELDS);
  if (!data.type) return res.status(400).json({ error: 'type required' });
  if (data.agent_id == null) {
    data.agent_id = req.user.id;
    data.agent_name = req.user.name;
  } else if (!canAssignTo(req.user, data.agent_id)) {
    return res.status(403).json({ error: 'Cannot assign to that agent' });
  }
  if (!data.status) data.status = 'scheduled';

  const cols = Object.keys(data);
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO meetings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ meeting: rowToApi(row) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const m = getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  if (!canSee(req.user, m)) return res.status(403).json({ error: 'Forbidden' });

  const data = bodyToDb(req.body, MEETING_FIELDS);
  if (data.agent_id !== undefined && data.agent_id !== m.agent_id && !canAssignTo(req.user, data.agent_id)) {
    return res.status(403).json({ error: 'Cannot reassign' });
  }
  if (!Object.keys(data).length) return res.json({ meeting: rowToApi(m) });

  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(`UPDATE meetings SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const updated = getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  res.json({ meeting: rowToApi(updated) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const m = getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  if (req.user.role !== 'admin' && !canAssignTo(req.user, m.agent_id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  getDb().prepare('DELETE FROM meetings WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── Meeting notes ───────────────────────────────

router.get('/:id/notes', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const m = getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  if (!canSee(req.user, m)) return res.status(403).json({ error: 'Forbidden' });
  const rows = getDb().prepare('SELECT * FROM meeting_notes WHERE meeting_id = ? ORDER BY created_at ASC').all(id);
  res.json({ notes: rows.map(rowToApi) });
});

router.post('/:id/notes', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const m = getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  if (!canSee(req.user, m)) return res.status(403).json({ error: 'Forbidden' });

  const text = (req.body && req.body.text) ? String(req.body.text).trim() : '';
  if (!text) return res.status(400).json({ error: 'text required' });

  const result = getDb().prepare(`
    INSERT INTO meeting_notes (meeting_id, text, author_id, author_name)
    VALUES (?, ?, ?, ?)
  `).run(id, text, req.user.id, req.user.name);
  getDb().prepare('UPDATE meetings SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  const row = getDb().prepare('SELECT * FROM meeting_notes WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ note: rowToApi(row) });
});

module.exports = router;
