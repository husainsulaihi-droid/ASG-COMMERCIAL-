/**
 * Audit routes — admin-only read access to login history.
 *
 *   GET /api/audit/logins?limit=200
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAdmin } = require('./middleware');

const router = express.Router();

router.get('/logins', requireAdmin, (req, res) => {
  const limit  = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
  let rows;
  if (Number.isFinite(userId)) {
    // Match either by user_id (success rows) or by username belonging to that
    // user (failed login attempts where user_id is null but the username matches).
    const u = getDb().prepare('SELECT username FROM users WHERE id = ?').get(userId);
    const uname = u ? u.username : null;
    rows = getDb().prepare(`
      SELECT id, user_id AS userId, username, ip, user_agent AS userAgent,
             success, reason, created_at AS createdAt
        FROM login_audit
       WHERE user_id = ? OR (user_id IS NULL AND username = ?)
       ORDER BY id DESC
       LIMIT ?
    `).all(userId, uname, limit);
  } else {
    rows = getDb().prepare(`
      SELECT id, user_id AS userId, username, ip, user_agent AS userAgent,
             success, reason, created_at AS createdAt
        FROM login_audit
       ORDER BY id DESC
       LIMIT ?
    `).all(limit);
  }
  res.json({ logins: rows });
});

module.exports = router;
