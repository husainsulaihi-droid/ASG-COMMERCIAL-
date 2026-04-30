/**
 * Tasks endpoints.
 *
 *   GET    /api/tasks                       — list (filtered by role/team)
 *   GET    /api/tasks/:id
 *   POST   /api/tasks                       — admin / team-leader (assign within team)
 *   PATCH  /api/tasks/:id                   — admin / leader / assignee
 *   DELETE /api/tasks/:id                   — admin / leader-of-assignee
 *
 *   GET    /api/tasks/:id/notes             — conversation thread
 *   POST   /api/tasks/:id/notes             — add a note
 *
 * Visibility:
 *   admin              → all
 *   team leader        → tasks assigned to self or to anyone reporting to them
 *   plain agent        → only tasks assigned to themselves
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const TASK_FIELDS = [
  'title', 'type', 'description', 'agent_id', 'property_id',
  'priority', 'status', 'deadline'
];

// Attach a notesCount field so the frontend can show "Reply (N)" badges
// without making one API call per task.
function withNotesCount(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const counts = getDb().prepare(
    `SELECT task_id AS id, COUNT(*) AS n FROM task_notes WHERE task_id IN (${ids.map(()=>'?').join(',')}) GROUP BY task_id`
  ).all(...ids);
  const byId = new Map(counts.map(c => [c.id, c.n]));
  return rows.map(r => ({ ...r, notes_count: byId.get(r.id) || 0 }));
}

function teamOf(leaderId) {
  return getDb().prepare('SELECT id FROM users WHERE team_leader_id = ?').all(leaderId).map(r => r.id);
}

function canSeeTask(user, task) {
  if (user.role === 'admin') return true;
  if (user.id === task.agent_id) return true;
  if (user.isTeamLeader) return teamOf(user.id).includes(task.agent_id);
  return false;
}

function canAssignTo(user, agentId) {
  if (user.role === 'admin') return true;
  if (agentId == null) return true;
  agentId = parseInt(agentId, 10);
  if (!user.isTeamLeader) return false;
  if (agentId === user.id) return true;
  return teamOf(user.id).includes(agentId);
}

function canDelete(user, task) {
  // Admins can delete only tasks they created (or any task if they're the
  // primary admin user 'admin'). Other admins/agents cannot delete tasks
  // they didn't create.
  if (user.role === 'admin') {
    if (user.username === 'admin') return true;            // primary admin can always delete
    return task.created_by_id === user.id;                 // other admins: only own
  }
  if (user.isTeamLeader) {
    if (task.agent_id === user.id) return true;
    return teamOf(user.id).includes(task.agent_id);
  }
  return false;
}

// ─── Tasks CRUD ──────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = getDb().prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all();
  } else if (req.user.isTeamLeader) {
    rows = getDb().prepare(`
      SELECT * FROM tasks
      WHERE agent_id = ?
         OR agent_id IN (SELECT id FROM users WHERE team_leader_id = ?)
      ORDER BY updated_at DESC
    `).all(req.user.id, req.user.id);
  } else {
    rows = getDb().prepare('SELECT * FROM tasks WHERE agent_id = ? ORDER BY updated_at DESC').all(req.user.id);
  }
  res.json({ tasks: withNotesCount(rows).map(rowToApi) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canSeeTask(req.user, t)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ task: rowToApi(t) });
});

router.post('/', requireAuth, (req, res) => {
  const data = bodyToDb(req.body, TASK_FIELDS);
  if (!data.title) return res.status(400).json({ error: 'title required' });

  // Plain agents can't create tasks (only admin / team leader)
  if (req.user.role !== 'admin' && !req.user.isTeamLeader) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (data.agent_id != null && !canAssignTo(req.user, data.agent_id)) {
    return res.status(403).json({ error: 'Cannot assign to that agent' });
  }

  data.created_by_id   = req.user.id;
  data.created_by_name = req.user.name;

  const cols = Object.keys(data);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders})`).run(...values);
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ task: rowToApi(row) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canSeeTask(req.user, t)) return res.status(403).json({ error: 'Forbidden' });

  const data = bodyToDb(req.body, TASK_FIELDS);
  if (data.agent_id !== undefined && data.agent_id !== t.agent_id) {
    if (!canAssignTo(req.user, data.agent_id)) return res.status(403).json({ error: 'Cannot reassign' });
  }
  if (!Object.keys(data).length) return res.json({ task: rowToApi(t) });

  const sets   = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(`UPDATE tasks SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const updated = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.json({ task: rowToApi(updated) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canDelete(req.user, t)) return res.status(403).json({ error: 'Forbidden' });
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── Notes (sub-resource) ────────────────────────

router.get('/:id/notes', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canSeeTask(req.user, t)) return res.status(403).json({ error: 'Forbidden' });
  const rows = getDb().prepare(
    'SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC'
  ).all(id);
  res.json({ notes: rows.map(rowToApi) });
});

router.post('/:id/notes', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!canSeeTask(req.user, t)) return res.status(403).json({ error: 'Forbidden' });

  const text = (req.body && req.body.text) ? String(req.body.text).trim() : '';
  if (!text) return res.status(400).json({ error: 'text required' });

  const result = getDb().prepare(`
    INSERT INTO task_notes (task_id, text, author_id, author_name, author_type)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, text, req.user.id, req.user.name, req.user.role);

  // Bump task's updated_at so it floats to the top of lists
  getDb().prepare('UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

  const row = getDb().prepare('SELECT * FROM task_notes WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ note: rowToApi(row) });
});

module.exports = router;
