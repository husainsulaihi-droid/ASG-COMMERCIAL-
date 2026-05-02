/**
 * Idempotent migration: ensures the login_audit table exists on the
 * production DB so the Logins tab can show login history.
 *
 * Safe to re-run.
 *
 *   node backend/migrate-add-login-audit.js
 */
const path = require('path');
const DB_PATH = process.env.DB_PATH || '/var/asg/data/asg.db';
const db = require('better-sqlite3')(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS login_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    username    TEXT,
    ip          TEXT,
    user_agent  TEXT,
    success     INTEGER NOT NULL DEFAULT 0,
    reason      TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_login_audit_created ON login_audit(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_login_audit_user    ON login_audit(user_id);
`);

const cnt = db.prepare('SELECT COUNT(*) AS n FROM login_audit').get().n;
console.log(`[migrate-add-login-audit] login_audit rows: ${cnt}`);
console.log('[migrate-add-login-audit] Done.');
