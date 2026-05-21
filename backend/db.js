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

  // Property ↔ partner-user link table. Each row says "partner-user U has
  // a stake of share_pct in property P". Created lazily on every boot so
  // the table exists for the new partner role even on long-lived databases.
  db.exec(`
    CREATE TABLE IF NOT EXISTS property_partners (
      property_id  INTEGER NOT NULL,
      user_id      INTEGER NOT NULL,
      share_pct    REAL DEFAULT 0,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (property_id, user_id),
      FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)     REFERENCES users(id)      ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_property_partners_user ON property_partners(user_id);
    CREATE INDEX IF NOT EXISTS idx_property_partners_prop ON property_partners(property_id);
  `);

  // Property ↔ owner-user link table. Owner accounts are independent of
  // partners — they're customers whose properties ASG manages. Each row
  // links an owner-user to a property with an optional management note
  // (e.g. fee/share field — kept generic as a number for now).
  db.exec(`
    CREATE TABLE IF NOT EXISTS property_owners (
      property_id  INTEGER NOT NULL,
      user_id      INTEGER NOT NULL,
      share_pct    REAL DEFAULT 0,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (property_id, user_id),
      FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)     REFERENCES users(id)      ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_property_owners_user ON property_owners(user_id);
    CREATE INDEX IF NOT EXISTS idx_property_owners_prop ON property_owners(property_id);
  `);

  // Tasks: a user-managed to-do list. Each task may reference a property.
  // Idempotent so existing production DBs (which were created before tasks
  // existed) pick up the table on boot.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL,
      property_id  INTEGER,
      priority     TEXT    DEFAULT 'medium',
      status       TEXT    DEFAULT 'pending',
      due_date     DATE,
      notes        TEXT,
      assigned_to  INTEGER,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_to) REFERENCES users(id)      ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_property ON tasks(property_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due      ON tasks(due_date);
  `);

  // One-time migration: the original users table has CHECK(role IN ('admin','agent'))
  // which blocks role='partner'. SQLite can't ALTER a CHECK, so we rebuild the
  // table when we detect the old shape. Runs once per database.
  //
  // FK note: per https://www.sqlite.org/lang_altertable.html, schema-rebuild
  // migrations must run with foreign_keys=OFF — otherwise DROP TABLE users
  // fails because sessions / properties / etc. still reference users(id) via
  // the old rowids. We turn FKs off only for the migration window, then run
  // foreign_key_check before committing to make sure no row was orphaned.
  try {
    const sqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (sqlRow && /CHECK\s*\(\s*role\s+IN\s*\(\s*'admin'\s*,\s*'agent'\s*\)\s*\)/i.test(sqlRow.sql)) {
      console.log('[db] Migrating users table to allow role=partner...');
      db.pragma('foreign_keys = OFF');
      try {
        db.exec(`
          BEGIN;
          CREATE TABLE users_new (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            username         TEXT    UNIQUE NOT NULL,
            password_hash    TEXT    NOT NULL,
            role             TEXT    NOT NULL CHECK(role IN ('admin', 'agent', 'partner')),
            name             TEXT    NOT NULL,
            email            TEXT,
            phone            TEXT,
            agent_role       TEXT,
            permissions      TEXT,
            availability     TEXT    DEFAULT 'available',
            is_team_leader   INTEGER DEFAULT 0,
            team_leader_id   INTEGER,
            active           INTEGER DEFAULT 1,
            created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (team_leader_id) REFERENCES users(id)
          );
          INSERT INTO users_new (id, username, password_hash, role, name, email, phone,
                                 agent_role, permissions, availability,
                                 is_team_leader, team_leader_id, active,
                                 created_at, updated_at)
            SELECT id, username, password_hash, role, name, email, phone,
                   agent_role, permissions, availability,
                   is_team_leader, team_leader_id, active,
                   created_at, updated_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
          CREATE INDEX IF NOT EXISTS idx_users_username    ON users(username);
          CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role);
          CREATE INDEX IF NOT EXISTS idx_users_team_leader ON users(team_leader_id);
          COMMIT;
        `);
        // Sanity check: every row that references users(id) must still resolve.
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) {
          console.warn('[db] users migration: FK violations after rebuild, rolling back:', violations);
          throw new Error('foreign_key_check found ' + violations.length + ' violations');
        }
        console.log('[db] users role migration complete.');
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
  } catch (e) {
    console.warn('[db] users role migration check failed:', e.message);
  }

  // Second-pass migration: when the table already allows partner but not
  // owner, rebuild once more so role='owner' inserts pass the CHECK.
  // Idempotent — only runs when the current CHECK clause exactly matches
  // (admin, agent, partner).
  try {
    const sqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (sqlRow && /CHECK\s*\(\s*role\s+IN\s*\(\s*'admin'\s*,\s*'agent'\s*,\s*'partner'\s*\)\s*\)/i.test(sqlRow.sql)) {
      console.log('[db] Migrating users table to allow role=owner...');
      db.pragma('foreign_keys = OFF');
      try {
        db.exec(`
          BEGIN;
          CREATE TABLE users_new (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            username         TEXT    UNIQUE NOT NULL,
            password_hash    TEXT    NOT NULL,
            role             TEXT    NOT NULL CHECK(role IN ('admin', 'agent', 'partner', 'owner')),
            name             TEXT    NOT NULL,
            email            TEXT,
            phone            TEXT,
            agent_role       TEXT,
            permissions      TEXT,
            availability     TEXT    DEFAULT 'available',
            is_team_leader   INTEGER DEFAULT 0,
            team_leader_id   INTEGER,
            active           INTEGER DEFAULT 1,
            created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (team_leader_id) REFERENCES users(id)
          );
          INSERT INTO users_new (id, username, password_hash, role, name, email, phone,
                                 agent_role, permissions, availability,
                                 is_team_leader, team_leader_id, active,
                                 created_at, updated_at)
            SELECT id, username, password_hash, role, name, email, phone,
                   agent_role, permissions, availability,
                   is_team_leader, team_leader_id, active,
                   created_at, updated_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
          CREATE INDEX IF NOT EXISTS idx_users_username    ON users(username);
          CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role);
          CREATE INDEX IF NOT EXISTS idx_users_team_leader ON users(team_leader_id);
          COMMIT;
        `);
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) {
          console.warn('[db] users owner migration: FK violations, rolling back:', violations);
          throw new Error('foreign_key_check found ' + violations.length + ' violations');
        }
        console.log('[db] users owner role migration complete.');
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
  } catch (e) {
    console.warn('[db] users owner role migration failed:', e.message);
  }

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

  // Shared persistent documents — exactly two editable slots, visible to
  // and editable by every logged-in user (admin + agents). Last write wins.
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slot          INTEGER NOT NULL UNIQUE,
      name          TEXT,
      filename      TEXT,
      html          TEXT,
      updated_by_id   INTEGER,
      updated_by_name TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // One-time migration: earlier deploys created `documents` with an
  // owner_id column (per-user). If we find that shape, collapse it to
  // shared by keeping the most-recently-updated row per slot.
  try {
    const cols = db.prepare("PRAGMA table_info(documents)").all();
    if (cols.some(c => c.name === 'owner_id')) {
      console.log('[db] Migrating documents table from per-user to shared...');
      db.exec(`
        CREATE TABLE documents_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          slot          INTEGER NOT NULL UNIQUE,
          name          TEXT,
          filename      TEXT,
          html          TEXT,
          updated_by_id   INTEGER,
          updated_by_name TEXT,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO documents_new (slot, name, filename, html, updated_by_id, created_at, updated_at)
          SELECT d.slot, d.name, d.filename, d.html, d.owner_id, d.created_at, d.updated_at
            FROM documents d
            JOIN (
              SELECT slot, MAX(updated_at) AS mx
                FROM documents GROUP BY slot
            ) m ON m.slot = d.slot AND m.mx = d.updated_at;
        DROP TABLE documents;
        ALTER TABLE documents_new RENAME TO documents;
      `);
      console.log('[db] documents migration complete.');
    }
  } catch (e) {
    console.warn('[db] documents migration check failed:', e.message);
  }

  // Idempotent column adds. SQLite has no "ADD COLUMN IF NOT EXISTS",
  // so we try and swallow the duplicate-column error.
  for (const [tbl, col, type] of [
    ['properties', 'management_fees', 'REAL'],
    ['properties', 'compound_id',     'INTEGER'],
    // Rent figure shown to linked partner users. Independent of annual_rent
    // (which stays admin-private). All partners on the property see the same
    // value; their individual share % is on property_partners.share_pct.
    ['properties', 'partner_rent',    'REAL DEFAULT 0'],
    ['contracts',  'term6',           'TEXT'],
    ['contracts',  'term7',           'TEXT'],
    ['contracts',  'term8',           'TEXT'],
    ['contracts',  'term9',           'TEXT'],
    ['contracts',  'term10',          'TEXT'],
    ['documents',  'file_data',       'BLOB'],
    ['documents',  'mime',            'TEXT'],
    // Compound flagged as managed-for-an-outside-owner — its land/service/
    // license/civil-defense charges are paid by that owner and must NOT
    // appear in ASG's financial deductions. 0 = ASG owns the compound (default).
    ['compounds',  'is_managed',      'INTEGER DEFAULT 0'],
    // Total compound purchase price (AED). Used to compute per-unit rental
    // yield by splitting this total across linked warehouses by area.
    ['compounds',  'purchase_price',  'REAL DEFAULT 0'],
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
