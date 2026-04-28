/**
 * User CRUD routes.
 *
 *   GET    /api/users                 — admin: all users; team leader: self + their team
 *   GET    /api/users/:id             — admin or self
 *   POST   /api/users                 — admin only — create new agent or admin
 *   PATCH  /api/users/:id             — admin (any field) or self (limited fields)
 *   DELETE /api/users/:id             — admin only — soft-delete (sets active = 0)
 *
 * Field naming: API uses camelCase, DB uses snake_case. We translate both ways.
 */

const express = require('express');
const { getDb } = require('./db');
const {
  hashPassword,
  sanitizeUser
} = require('./auth');
const {
  requireAuth,
  requireAdmin,
  requireAdminOrSelf
} = require('./middleware');

const router = express.Router();

// ─── helpers ──────────────────────────────────────

function findUser(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function usernameTaken(username, exceptId = null) {
  const row = exceptId
    ? getDb().prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, exceptId)
    : getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
  return !!row;
}

// ─── GET /api/users ───────────────────────────────
// Admin → all users. Team leader → self + agents reporting to them.
// Plain agent → just self.
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  let rows;
  if (req.user.role === 'admin') {
    rows = db.prepare('SELECT * FROM users ORDER BY name').all();
  } else if (req.user.isTeamLeader) {
    rows = db.prepare(
      'SELECT * FROM users WHERE id = ? OR team_leader_id = ? ORDER BY name'
    ).all(req.user.id, req.user.id);
  } else {
    rows = db.prepare('SELECT * FROM users WHERE id = ?').all(req.user.id);
  }
  res.json({ users: rows.map(sanitizeUser) });
});

// ─── GET /api/users/:id ───────────────────────────
router.get('/:id', requireAdminOrSelf, (req, res) => {
  const u = findUser(parseInt(req.params.id, 10));
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ user: sanitizeUser(u) });
});

// ─── POST /api/users ──────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const name     = String(b.name || '').trim();
  const role     = b.role === 'admin' ? 'admin' : 'agent';

  if (!username) return res.status(400).json({ error: 'username required' });
  if (!name)     return res.status(400).json({ error: 'name required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (usernameTaken(username)) return res.status(409).json({ error: 'Username taken' });

  const password_hash = await hashPassword(password);
  const permissions = b.permissions ? JSON.stringify(b.permissions) : null;

  const result = getDb().prepare(`
    INSERT INTO users (username, password_hash, role, name, email, phone,
                       agent_role, permissions, availability,
                       is_team_leader, team_leader_id, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    username, password_hash, role, name,
    b.email || null, b.phone || null,
    b.agentRole || null, permissions,
    b.availability || 'available',
    b.isTeamLeader ? 1 : 0,
    b.teamLeaderId || null
  );

  const created = findUser(result.lastInsertRowid);
  res.status(201).json({ user: sanitizeUser(created) });
});

// ─── PATCH /api/users/:id ─────────────────────────
// Admin can edit any field. A regular user can only edit their own
// limited fields (name, phone, email, password, availability).
router.patch('/:id', requireAdminOrSelf, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = findUser(id);
  if (!u) return res.status(404).json({ error: 'User not found' });

  const isAdmin = req.user.role === 'admin';
  const b = req.body || {};
  const updates = [];
  const values = [];

  // Self-editable fields (anyone can edit on themselves)
  if (b.name != null)         { updates.push('name = ?');         values.push(String(b.name).trim()); }
  if (b.email != null)        { updates.push('email = ?');        values.push(b.email || null); }
  if (b.phone != null)        { updates.push('phone = ?');        values.push(b.phone || null); }
  if (b.availability != null) { updates.push('availability = ?'); values.push(b.availability); }

  // Password change — anyone can change their own (admin can reset for any user)
  if (b.password) {
    if (String(b.password).length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    updates.push('password_hash = ?');
    values.push(await hashPassword(b.password));
  }

  // Admin-only fields
  if (isAdmin) {
    if (b.username != null) {
      if (!b.username) return res.status(400).json({ error: 'username required' });
      if (usernameTaken(b.username, id))
        return res.status(409).json({ error: 'Username taken' });
      updates.push('username = ?');
      values.push(String(b.username).trim());
    }
    if (b.role != null)         { updates.push('role = ?');         values.push(b.role === 'admin' ? 'admin' : 'agent'); }
    if (b.agentRole != null)    { updates.push('agent_role = ?');   values.push(b.agentRole || null); }
    if (b.permissions != null)  { updates.push('permissions = ?');  values.push(JSON.stringify(b.permissions)); }
    if (b.isTeamLeader != null) { updates.push('is_team_leader = ?'); values.push(b.isTeamLeader ? 1 : 0); }
    if (b.teamLeaderId != null) { updates.push('team_leader_id = ?'); values.push(b.teamLeaderId || null); }
    if (b.active != null)       { updates.push('active = ?');       values.push(b.active ? 1 : 0); }
  }

  if (!updates.length) return res.json({ user: sanitizeUser(u) });

  updates.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  getDb().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ user: sanitizeUser(findUser(id)) });
});

// ─── DELETE /api/users/:id ────────────────────────
// Soft-delete: sets active = 0 so the user can't log in but historical
// records (their leads, tasks, etc.) keep referring to a real row.
router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: "Can't delete yourself" });
  const u = findUser(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  getDb().prepare("UPDATE users SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  // Also kill any active sessions for this user
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
