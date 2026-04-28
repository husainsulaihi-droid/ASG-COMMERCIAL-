/**
 * Leads endpoints.
 *
 *   GET    /api/leads                       — list (filtered by role/team)
 *   GET    /api/leads/:id
 *   POST   /api/leads                       — anyone can create; assignedTo defaults to self
 *   PATCH  /api/leads/:id                   — admin / team-leader-of-assignee / assignee
 *   DELETE /api/leads/:id                   — admin only
 *
 *   GET    /api/leads/:id/activities
 *   POST   /api/leads/:id/activities
 *
 * Visibility:
 *   admin              → all
 *   team leader        → leads assigned to self or to anyone reporting to them
 *   plain agent        → only leads assigned to themselves
 *
 * Assignment rules on POST/PATCH:
 *   admin              → can assign to anyone
 *   team leader        → can assign to self or anyone in their team
 *   plain agent        → can only assign to self
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const LEAD_FIELDS = [
  'name', 'phone', 'email', 'company', 'source', 'prop_type',
  'budget', 'requirements', 'stage', 'assigned_to'
];

function teamOf(leaderId) {
  return getDb().prepare('SELECT id FROM users WHERE team_leader_id = ?').all(leaderId).map(r => r.id);
}

function canSeeLead(user, lead) {
  if (user.role === 'admin') return true;
  if (user.id === lead.assigned_to) return true;
  if (user.isTeamLeader) return teamOf(user.id).includes(lead.assigned_to);
  return false;
}

function canEditLead(user, lead) {
  // Same as canSee — admin / leader of assignee / assignee themselves
  return canSeeLead(user, lead);
}

function canAssignTo(user, targetId) {
  if (user.role === 'admin') return true;
  if (targetId == null || targetId === user.id) return true;
  if (!user.isTeamLeader) return false;
  return teamOf(user.id).includes(parseInt(targetId, 10));
}

// ─── Leads CRUD ────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = getDb().prepare('SELECT * FROM leads ORDER BY updated_at DESC').all();
  } else if (req.user.isTeamLeader) {
    rows = getDb().prepare(`
      SELECT * FROM leads
      WHERE assigned_to = ?
         OR assigned_to IN (SELECT id FROM users WHERE team_leader_id = ?)
      ORDER BY updated_at DESC
    `).all(req.user.id, req.user.id);
  } else {
    rows = getDb().prepare('SELECT * FROM leads WHERE assigned_to = ? ORDER BY updated_at DESC').all(req.user.id);
  }
  res.json({ leads: rows.map(rowToApi) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });
  if (!canSeeLead(req.user, row)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ lead: rowToApi(row) });
});

router.post('/', requireAuth, (req, res) => {
  const data = bodyToDb(req.body, LEAD_FIELDS);
  if (!data.name)  return res.status(400).json({ error: 'name required' });
  if (!data.phone) return res.status(400).json({ error: 'phone required' });

  if (data.assigned_to !== undefined && !canAssignTo(req.user, data.assigned_to)) {
    return res.status(403).json({ error: 'Cannot assign to that user' });
  }
  if (data.assigned_to == null) data.assigned_to = req.user.id;
  data.assigned_at = new Date().toISOString();

  const cols = Object.keys(data);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(`INSERT INTO leads (${cols.join(', ')}) VALUES (${placeholders})`).run(...values);
  const row = getDb().prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ lead: rowToApi(row) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const lead = getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!canEditLead(req.user, lead)) return res.status(403).json({ error: 'Forbidden' });

  const data = bodyToDb(req.body, LEAD_FIELDS);
  if (data.assigned_to !== undefined && data.assigned_to !== lead.assigned_to) {
    if (!canAssignTo(req.user, data.assigned_to)) return res.status(403).json({ error: 'Cannot reassign there' });
    data.assigned_at = new Date().toISOString();
  }
  if (!Object.keys(data).length) return res.json({ lead: rowToApi(lead) });

  const sets   = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(`UPDATE leads SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const updated = getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id);
  res.json({ lead: rowToApi(updated) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = getDb().prepare('DELETE FROM leads WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Lead not found' });
  res.json({ ok: true });
});

// ─── Activities (sub-resource) ─────────────────

router.get('/:id/activities', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const lead = getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!canSeeLead(req.user, lead)) return res.status(403).json({ error: 'Forbidden' });
  const rows = getDb().prepare(
    'SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY created_at ASC'
  ).all(id);
  res.json({ activities: rows.map(rowToApi) });
});

router.post('/:id/activities', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const lead = getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!canEditLead(req.user, lead)) return res.status(403).json({ error: 'Forbidden' });

  const b = req.body || {};
  if (!b.note || !String(b.note).trim()) return res.status(400).json({ error: 'note required' });

  const result = getDb().prepare(`
    INSERT INTO lead_activities (lead_id, type, potential, stage_changed, note,
                                 author_id, author_name, author_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, b.type || 'note', b.potential || null, b.stageChanged || null, String(b.note).trim(),
    req.user.id, req.user.name, req.user.role
  );

  // Mirror stage change to the lead row
  if (b.stageChanged) {
    getDb().prepare(
      'UPDATE leads SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(b.stageChanged, id);
  } else {
    getDb().prepare('UPDATE leads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }

  const row = getDb().prepare('SELECT * FROM lead_activities WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ activity: rowToApi(row) });
});

module.exports = router;
