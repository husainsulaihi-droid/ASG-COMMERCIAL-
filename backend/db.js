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
  return db;
}

function getDb() {
  if (!db) initDb();
  return db;
}

module.exports = { initDb, getDb };
