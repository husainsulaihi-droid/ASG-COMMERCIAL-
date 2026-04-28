/**
 * Initialize the database — run this once on a fresh VPS or to reset.
 *
 * Usage:
 *   npm run init-db
 *
 * This will create the SQLite file at $DB_PATH if it doesn't exist
 * and run db/schema.sql to set up all tables.
 *
 * Safe to run if the DB already exists — it just opens it without
 * re-creating tables.
 */

const { initDb } = require('./db');
initDb();
console.log('[init-db] Done.');
