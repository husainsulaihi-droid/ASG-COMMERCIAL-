/**
 * Database module — SQLite via better-sqlite3.
 *
 * On first run, creates the database file from db/schema.sql in the repo root.
 * On subsequent runs, opens the existing file.
 *
 * DB path is configurable via env var DB_PATH; defaults to ./asg.db
 * (in production we'll set DB_PATH=/var/asg/data/asg.db so the DB survives
 *  redeploys of the code).
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'asg.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

let db;

function initDb() {
  // Make sure the directory exists if DB_PATH is in /var/asg/data/...
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const isNew = !fs.existsSync(DB_PATH);
  db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  if (isNew) {
    console.log(`[db] Initializing fresh database at ${DB_PATH}...`);
    if (!fs.existsSync(SCHEMA_PATH)) {
      throw new Error(`Schema file not found at ${SCHEMA_PATH}`);
    }
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);
    console.log('[db] Schema loaded. Database ready.');
  } else {
    console.log(`[db] Opened existing database at ${DB_PATH}.`);
  }

  // Idempotent: ensure login_audit exists on every boot.
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

  // Compounds: groups of warehouses sharing one set of land/service/license/civil-defense charges.
  db.exec(`
    CREATE TABLE IF NOT EXISTS compounds (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      name                   TEXT NOT NULL UNIQUE,
      location               TEXT,
      land_charges           REAL DEFAULT 0,
      service_charges        REAL DEFAULT 0,
      license_fees           REAL DEFAULT 0,
      civil_defense_charges  REAL DEFAULT 0,
      notes                  TEXT,
      created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Idempotent column adds. SQLite has no "ADD COLUMN IF NOT EXISTS",
  // so we try and swallow the duplicate-column error.
  for (const [tbl, col, type] of [
    ['properties', 'management_fees', 'REAL'],
    ['properties', 'compound_id',     'INTEGER'],
  ]) {
    try { db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${type}`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) console.warn('[db] add-col failed:', e.message); }
  }
  return db;
}

function getDb() {
  if (!db) initDb();
  return db;
}

module.exports = { initDb, getDb };
