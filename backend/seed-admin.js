/**
 * One-shot script to create the initial admin user.
 *
 * Usage:
 *   npm run seed-admin
 *
 * Or with custom credentials:
 *   ADMIN_USERNAME=husain ADMIN_PASSWORD='choose-a-strong-one' npm run seed-admin
 *
 * Defaults to username=admin, password=asg2024 (CHANGE THIS IMMEDIATELY in production).
 *
 * Safe to run multiple times — skips if an admin already exists.
 */

const { initDb, getDb } = require('./db');
const { hashPassword } = require('./auth');

async function main() {
  initDb();
  const db = getDb();

  const existingAdmin = db.prepare(
    "SELECT id FROM users WHERE role = 'admin' AND active = 1"
  ).get();

  if (existingAdmin) {
    console.log(`[seed-admin] An admin user already exists (id=${existingAdmin.id}). Skipping.`);
    console.log('[seed-admin] To reset the password, use: PATCH /api/users/' + existingAdmin.id);
    return;
  }

  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD || 'asg2024';
  const name     = process.env.ADMIN_NAME     || 'Administrator';

  if (password.length < 6) {
    console.error('[seed-admin] ADMIN_PASSWORD must be at least 6 characters.');
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, role, name, active)
    VALUES (?, ?, 'admin', ?, 1)
  `).run(username, hash, name);

  console.log('[seed-admin] ✅ Admin created.');
  console.log(`              id:       ${result.lastInsertRowid}`);
  console.log(`              username: ${username}`);
  console.log(`              password: ${process.env.ADMIN_PASSWORD ? '(from $ADMIN_PASSWORD)' : 'asg2024 (default — CHANGE IT NOW)'}`);
}

main().catch(err => {
  console.error('[seed-admin] Failed:', err.message);
  process.exit(1);
});
