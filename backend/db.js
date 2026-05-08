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

  // Tenancy contracts generated from the Contract Builder (admin) and Agent
  // Contract Builder. Mirrors the proposals table — flat record with provenance.
  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      title             TEXT,
      contract_date     DATE,
      prop_id           INTEGER,
      prop_name         TEXT,
      property_type     TEXT,
      property_area     REAL,
      location          TEXT,
      plot_no           TEXT,
      makani_no         TEXT,
      building_name     TEXT,
      property_no       TEXT,
      dewa_no           TEXT,
      prop_usage        TEXT,
      owner_name        TEXT,
      lessor_name       TEXT,
      lessor_eid        TEXT,
      lessor_license    TEXT,
      lessor_authority  TEXT,
      lessor_phone      TEXT,
      lessor_email      TEXT,
      tenant_name       TEXT,
      tenant_eid        TEXT,
      tenant_license    TEXT,
      tenant_authority  TEXT,
      tenant_phone      TEXT,
      tenant_email      TEXT,
      co_occupants      TEXT,
      contract_from     DATE,
      contract_to       DATE,
      contract_value    REAL,
      annual_rent       REAL,
      security_deposit  REAL,
      payment_mode      TEXT,
      term1             TEXT,
      term2             TEXT,
      term3             TEXT,
      term4             TEXT,
      term5             TEXT,
      term6             TEXT,
      term7             TEXT,
      term8             TEXT,
      term9             TEXT,
      term10            TEXT,
      created_by_id     INTEGER,
      created_by_name   TEXT,
      created_by_type   TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_contracts_created_by ON contracts(created_by_id);
    CREATE INDEX IF NOT EXISTS idx_contracts_prop       ON contracts(prop_id);
  `);

  // Idempotent column adds. SQLite has no "ADD COLUMN IF NOT EXISTS",
  // so we try and swallow the duplicate-column error.
  for (const [tbl, col, type] of [
    ['properties', 'management_fees', 'REAL'],
    ['properties', 'compound_id',     'INTEGER'],
    ['contracts',  'term6',           'TEXT'],
    ['contracts',  'term7',           'TEXT'],
    ['contracts',  'term8',           'TEXT'],
    ['contracts',  'term9',           'TEXT'],
    ['contracts',  'term10',          'TEXT'],
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
