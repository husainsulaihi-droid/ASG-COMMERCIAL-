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
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const rows = getDb().prepare(`
    SELECT id, user_id AS userId, username, ip, user_agent AS userAgent,
           success, reason, created_at AS createdAt
      FROM login_audit
     ORDER BY id DESC
     LIMIT ?
  `).all(limit);
  res.json({ logins: rows });
});

module.exports = router;
