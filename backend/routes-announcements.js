/**
 * Announcements.
 *
 *   GET    /api/announcements           — any user (returns active by default; pass ?all=1 for all)
 *   GET    /api/announcements/:id       — any user (404 if expired & no admin override)
 *   POST   /api/announcements           — admin only
 *   PATCH  /api/announcements/:id       — admin only
 *   DELETE /api/announcements/:id       — admin only
 *
 *   POST   /api/announcements/:id/read  — current user marks the announcement as read
 *   GET    /api/announcements/:id/reads — admin only — list of users who've read it
 *
 * Each announcement carries a readBy array on response (user IDs that have read it).
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const ANN_FIELDS = ['title', 'body', 'pinned', 'expires_at'];

function withReadBy(row) {
  if (!row) return null;
  const readers = getDb().prepare(
    'SELECT user_id FROM announcement_reads WHERE announcement_id = ?'
  ).all(row.id).map(r => r.user_id);
  const api = rowToApi(row);
  api.readBy = readers;
  return api;
}

router.get('/', requireAuth, (req, res) => {
  const showAll = req.query.all === '1';
  const rows = getDb().prepare(`
    SELECT * FROM announcements
    ${showAll ? '' : "WHERE expires_at IS NULL OR expires_at >= date('now')"}
    ORDER BY pinned DESC, created_at DESC
  `).all();
  res.json({ announcements: rows.map(withReadBy) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Announcement not found' });
  res.json({ announcement: withReadBy(row) });
});

router.post('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title required' });
  if (!b.body)  return res.status(400).json({ error: 'body required' });

  const data = bodyToDb(b, ANN_FIELDS);
  data.pinned = data.pinned ? 1 : 0;

  const cols = Object.keys(data);
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO announcements (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM announcements WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ announcement: withReadBy(row) });
});

router.patch('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Announcement not found' });

  const data = bodyToDb(req.body, ANN_FIELDS);
  if ('pinned' in data) data.pinned = data.pinned ? 1 : 0;
  if (!Object.keys(data).length) return res.json({ announcement: withReadBy(existing) });

  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(`UPDATE announcements SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const updated = getDb().prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  res.json({ announcement: withReadBy(updated) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = getDb().prepare('DELETE FROM announcements WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Announcement not found' });
  res.json({ ok: true });
});

// ─── Reads ─────────────────────────────────────

router.post('/:id/read', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ann = getDb().prepare('SELECT id FROM announcements WHERE id = ?').get(id);
  if (!ann) return res.status(404).json({ error: 'Announcement not found' });
  // Idempotent — INSERT OR IGNORE
  getDb().prepare(
    'INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)'
  ).run(id, req.user.id);
  res.json({ ok: true });
});

router.get('/:id/reads', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = getDb().prepare(`
    SELECT u.id, u.name, u.username, r.read_at
    FROM announcement_reads r
    JOIN users u ON u.id = r.user_id
    WHERE r.announcement_id = ?
    ORDER BY r.read_at DESC
  `).all(id);
  res.json({ reads: rows });
});

module.exports = router;
