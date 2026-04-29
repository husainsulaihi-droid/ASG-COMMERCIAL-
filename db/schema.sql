-- ═══════════════════════════════════════════════════════════════
--  ASG Commercial CRM — Backend Database Schema
--  SQLite (we can migrate to Postgres later if scale demands it)
--
--  Conventions:
--    - All tables have created_at; mutable tables also have updated_at
--    - Foreign keys with ON DELETE CASCADE for child rows
--    - Author/provenance fields stored on records that can be edited
--      by multiple users (admin vs agent)
--    - Photos/files are NOT stored as base64 — they live on disk under
--      /var/asg/uploads/ and the `media` table holds the metadata.
--    - JSON columns avoided in favor of proper relational tables, except
--      for `permissions` on users which is a small fixed set of booleans.
-- ═══════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- ─── USERS (admin + agents + team leaders in one table) ────────
CREATE TABLE users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT    UNIQUE NOT NULL,
  password_hash    TEXT    NOT NULL,
  role             TEXT    NOT NULL CHECK(role IN ('admin', 'agent')),
  name             TEXT    NOT NULL,
  email            TEXT,
  phone            TEXT,
  agent_role       TEXT,    -- sales, leasing, property_management, accounts, general (only for agents)
  permissions      TEXT,    -- JSON: { viewFinancials, viewTenant, updateStatus, addNotes }
  availability     TEXT    DEFAULT 'available',  -- available, in_meeting, at_viewing, off_duty, on_leave
  -- Team hierarchy
  is_team_leader   INTEGER DEFAULT 0,            -- 1 if this user manages a team of agents
  team_leader_id   INTEGER,                      -- FK -> users(id). The team leader this agent reports to
  active           INTEGER DEFAULT 1,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (team_leader_id) REFERENCES users(id)
);
CREATE INDEX idx_users_username       ON users(username);
CREATE INDEX idx_users_role           ON users(role);
CREATE INDEX idx_users_team_leader    ON users(team_leader_id);

-- ─── SESSIONS (cookie-based auth) ───────────────────────────────
CREATE TABLE sessions (
  token       TEXT     PRIMARY KEY,
  user_id     INTEGER  NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ─── PROPERTIES (owned portfolio) ───────────────────────────────
CREATE TABLE properties (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  type                TEXT,    -- warehouse, office, residential
  name                TEXT     NOT NULL,
  unit_no             TEXT,
  trade_license       TEXT,
  usage               TEXT,
  location            TEXT,
  map_link            TEXT,
  size                REAL,
  area                REAL,
  compound            TEXT,    -- yes, no
  mezzanine           TEXT,    -- yes, no
  -- Ownership
  ownership           TEXT,    -- own, partnership, management
  partner_name        TEXT,
  our_share           REAL,
  owner_name          TEXT,
  owner_phone         TEXT,
  mgmt_fee            REAL,
  mgmt_date           DATE,
  purchase_price      REAL,
  purchase_date       DATE,
  market_value        REAL,
  -- Rental
  status              TEXT,    -- vacant, rented
  annual_rent         REAL,
  service_charges     REAL,
  maintenance_fees    REAL,
  vat                 REAL,
  tenant_name         TEXT,
  tenant_phone        TEXT,
  tenant_email        TEXT,
  reminder_days       INTEGER  DEFAULT 60,
  lease_start         DATE,
  lease_end           DATE,
  num_cheques         INTEGER,
  notes               TEXT,
  coords              TEXT,
  -- Provenance
  added_by_id         INTEGER,
  added_by_name       TEXT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (added_by_id) REFERENCES users(id)
);
CREATE INDEX idx_properties_type   ON properties(type);
CREATE INDEX idx_properties_status ON properties(status);

-- drive_folder_id and folder_name are added by ALTER TABLE on existing
-- databases (see deploy migration scripts). Listed here as comments for
-- documentation; the live schema includes them.
-- ALTER TABLE properties ADD COLUMN drive_folder_id TEXT;
-- ALTER TABLE properties ADD COLUMN folder_name TEXT;

-- ─── PROPERTY CHEQUES ────────────────────────────────────────────
CREATE TABLE property_cheques (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL,
  cheque_num  INTEGER,
  cheque_date DATE,
  amount      REAL,
  status      TEXT DEFAULT 'pending',  -- pending, received, bounced
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);
CREATE INDEX idx_cheques_property ON property_cheques(property_id);

-- ─── PROPERTY FILES (Drive-mirrored attachments) ─────────────────
-- Files uploaded for each property: Ejari, tenancy contract, affection
-- plan, photos, etc. Each file is stored under /var/asg/uploads/ AND
-- mirrored to a Google Drive folder so the user has a backup view.
CREATE TABLE property_files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id     INTEGER NOT NULL,
  category        TEXT,        -- 'ijari' | 'tenancy' | 'affection' | 'drec' | 'photo' | 'other'
  filename        TEXT,        -- original upload filename
  local_path      TEXT,        -- '/var/asg/uploads/property-N/uuid-original.pdf'
  drive_id        TEXT,        -- Google Drive file id
  drive_url       TEXT,        -- web URL to view in Drive
  mime            TEXT,
  size            INTEGER,
  uploaded_by_id  INTEGER,
  uploaded_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id)    REFERENCES properties(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by_id) REFERENCES users(id)
);
CREATE INDEX idx_property_files_property ON property_files(property_id);
CREATE INDEX idx_property_files_category ON property_files(category);

-- ─── DISPUTES (legal cases / disputes per property) ─────────────
CREATE TABLE disputes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT     NOT NULL,
  property_id       INTEGER,
  type              TEXT,
  status            TEXT,
  case_no           TEXT,
  court             TEXT,
  opponent          TEXT,
  filing_date       DATE,
  next_hearing_date DATE,
  amount_disputed   REAL,
  lawyer            TEXT,
  lawyer_phone      TEXT,
  notes             TEXT,
  folder_name       TEXT,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL
);
CREATE INDEX idx_disputes_property ON disputes(property_id);
CREATE INDEX idx_disputes_status   ON disputes(status);

-- ─── CONSTRUCTION PROJECTS ──────────────────────────────────────
CREATE TABLE construction_projects (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT     NOT NULL,
  property_id         INTEGER,
  location            TEXT,
  type                TEXT,
  status              TEXT,
  contractor          TEXT,
  contractor_phone    TEXT,
  start_date          DATE,
  expected_completion DATE,
  budget              REAL,
  spent_to_date       REAL,
  progress            INTEGER,
  notes               TEXT,
  folder_name         TEXT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL
);
CREATE INDEX idx_construction_property ON construction_projects(property_id);
CREATE INDEX idx_construction_status   ON construction_projects(status);

-- ─── PENDING SUBMISSIONS (agent-submitted, awaiting approval) ───
CREATE TABLE pending_properties (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT     NOT NULL,
  type                TEXT,
  location            TEXT,
  size                REAL,
  annual_rent         REAL,
  ownership           TEXT     DEFAULT 'sole',
  description         TEXT,
  client_name         TEXT,
  client_phone        TEXT,
  status              TEXT     DEFAULT 'pending',  -- pending, approved, rejected
  admin_note          TEXT,
  added_by_id         INTEGER,
  added_by_name       TEXT,
  submitted_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (added_by_id) REFERENCES users(id)
);

-- ─── TASKS ───────────────────────────────────────────────────────
CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  type         TEXT,    -- find-tenant, follow-up, site-visit, maintenance, documents, negotiation, other
  description  TEXT,
  agent_id     INTEGER,
  property_id  INTEGER,
  priority     TEXT    DEFAULT 'medium',  -- low, medium, high
  status       TEXT    DEFAULT 'pending', -- pending, in-progress, done, cancelled
  deadline     DATE,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id)    REFERENCES users(id),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);
CREATE INDEX idx_tasks_agent  ON tasks(agent_id);
CREATE INDEX idx_tasks_status ON tasks(status);

-- ─── TASK NOTES (conversation thread) ──────────────────────────
CREATE TABLE task_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL,
  text         TEXT    NOT NULL,
  author_id    INTEGER,
  author_name  TEXT,
  author_type  TEXT,   -- admin, agent
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id)   REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
);
CREATE INDEX idx_task_notes_task ON task_notes(task_id);

-- ─── LEADS ───────────────────────────────────────────────────────
CREATE TABLE leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  phone         TEXT    NOT NULL,
  email         TEXT,
  company       TEXT,
  source        TEXT,    -- meta-ads, instagram, google, referral, walk-in, website, other
  prop_type     TEXT,
  budget        REAL,
  requirements  TEXT,
  stage         TEXT    DEFAULT 'new',  -- new, contacted, meeting, qualified, proposal, negotiation, won, lost
  assigned_to   INTEGER,
  assigned_at   DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES users(id)
);
CREATE INDEX idx_leads_stage    ON leads(stage);
CREATE INDEX idx_leads_assigned ON leads(assigned_to);

-- ─── LEAD ACTIVITIES ─────────────────────────────────────────────
CREATE TABLE lead_activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER NOT NULL,
  type          TEXT,    -- call, meeting, email, note, proposal
  potential     TEXT,    -- high, medium, low
  stage_changed TEXT,    -- the new stage if this activity changed the lead's stage
  note          TEXT,
  author_id     INTEGER,
  author_name   TEXT,
  author_type   TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id)   REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
);
CREATE INDEX idx_lead_activities_lead ON lead_activities(lead_id);

-- ─── MEETINGS & VIEWINGS ─────────────────────────────────────────
CREATE TABLE meetings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL,                 -- meeting, viewing
  status        TEXT    DEFAULT 'scheduled',       -- scheduled, completed, cancelled, noshow
  agent_id      INTEGER NOT NULL,
  agent_name    TEXT,
  lead_id       INTEGER,
  property_id   INTEGER,
  meeting_date  DATE,
  meeting_time  TIME,
  location      TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id)    REFERENCES users(id),
  FOREIGN KEY (lead_id)     REFERENCES leads(id),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);
CREATE INDEX idx_meetings_agent  ON meetings(agent_id);
CREATE INDEX idx_meetings_lead   ON meetings(lead_id);
CREATE INDEX idx_meetings_status ON meetings(status);

-- ─── MEETING NOTES (conversation thread per meeting) ────────────
CREATE TABLE meeting_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id   INTEGER NOT NULL,
  text         TEXT,
  author_id    INTEGER,
  author_name  TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

-- ─── ANNOUNCEMENTS ────────────────────────────────────────────────
CREATE TABLE announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  pinned      INTEGER DEFAULT 0,
  expires_at  DATE,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─── ANNOUNCEMENT READS (per-user read tracking) ────────────────
CREATE TABLE announcement_reads (
  announcement_id  INTEGER NOT NULL,
  user_id          INTEGER NOT NULL,
  read_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (announcement_id, user_id),
  FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)         REFERENCES users(id) ON DELETE CASCADE
);

-- ─── LEAVES (agent time-off) ─────────────────────────────────────
CREATE TABLE leaves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL,
  start_date  DATE    NOT NULL,
  end_date    DATE    NOT NULL,
  reason      TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_leaves_agent ON leaves(agent_id);

-- ─── PROPOSALS ────────────────────────────────────────────────────
CREATE TABLE proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  ref             TEXT,
  proposal_date   DATE,
  valid_until     DATE,
  prep_by         TEXT,
  -- Property context
  prop_id         INTEGER,
  prop_name       TEXT,
  prop_type       TEXT,
  prop_location   TEXT,
  prop_size       REAL,
  -- Client
  client_name     TEXT,
  client_company  TEXT,
  client_phone    TEXT,
  client_email    TEXT,
  -- Financial
  rent            REAL,
  lessor          TEXT,
  tenancy_from    DATE,
  tenancy_to      DATE,
  num_cheques     INTEGER,
  vat_amount      REAL,
  service_amount  REAL,
  maint_amount    REAL,
  admin_amount    REAL,
  drec_amount     REAL,
  terms_raw       TEXT,
  notes           TEXT,
  -- Provenance
  created_by_id    INTEGER,
  created_by_name  TEXT,
  created_by_type  TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (prop_id)       REFERENCES properties(id),
  FOREIGN KEY (created_by_id) REFERENCES users(id)
);

-- ─── PROPOSAL CHEQUES ────────────────────────────────────────────
CREATE TABLE proposal_cheques (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id  INTEGER NOT NULL,
  ord_label    TEXT,
  cheque_date  DATE,
  amount       REAL,
  payable      TEXT,
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
);

-- ─── OFF-PLAN: DEVELOPERS ────────────────────────────────────────
CREATE TABLE developers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  region       TEXT,
  website      TEXT,
  brief        TEXT,
  data_source  TEXT    DEFAULT 'manual',  -- manual, seed, import, rera, dld, propertyfinder, bayut
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─── OFF-PLAN: PROJECTS ──────────────────────────────────────────
CREATE TABLE offplan_projects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  developer_id   INTEGER NOT NULL,
  name           TEXT    NOT NULL,
  status         TEXT    DEFAULT 'launched',     -- prelaunch, launched, construction, ready, soldout
  type           TEXT    DEFAULT 'apartments',   -- apartments, villas, townhouses, offices, mixed, hotel
  location       TEXT    NOT NULL,
  unit_mix       TEXT,
  launch_date    DATE,
  handover_date  DATE,
  price_from     REAL,
  price_to       REAL,
  payment_plan   TEXT,
  amenities      TEXT,
  description    TEXT,
  data_source    TEXT    DEFAULT 'manual',
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (developer_id) REFERENCES developers(id) ON DELETE CASCADE
);
CREATE INDEX idx_projects_developer ON offplan_projects(developer_id);

-- ─── SECONDARY (RESALE) LISTINGS ────────────────────────────────
CREATE TABLE secondary_listings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  type            TEXT    DEFAULT 'apartment',
  txn_type        TEXT    DEFAULT 'sale',     -- sale, rent, both (renamed from `transaction`, which is reserved in SQLite)
  status          TEXT    DEFAULT 'active',   -- active, reserved, sold, rented, inactive
  location        TEXT    NOT NULL,
  size            REAL,
  beds            INTEGER,
  baths           INTEGER,
  price           REAL,
  rent            REAL,
  owner_name      TEXT,
  owner_phone     TEXT,
  owner_email     TEXT,
  description     TEXT,
  amenities       TEXT,
  added_by_id     INTEGER,
  added_by_name   TEXT,
  added_by_type   TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (added_by_id) REFERENCES users(id)
);

-- ─── MEDIA / FILES (universal — used by every entity) ───────────
-- Files are stored on disk under /var/asg/uploads/<owner_type>/<owner_id>/<filename>
-- Database stores only metadata + the on-disk path.
CREATE TABLE media (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type      TEXT    NOT NULL,  -- property, meeting, project, listing, proposal, etc.
  owner_id        INTEGER NOT NULL,
  category        TEXT,    -- photo, video, document
  doc_type        TEXT,    -- ijari, drec, affection, tenancy, brochure, photo, etc.
  filename        TEXT    NOT NULL,
  mime            TEXT,
  file_path       TEXT    NOT NULL,
  size            INTEGER,
  uploaded_by_id  INTEGER,
  uploaded_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (uploaded_by_id) REFERENCES users(id)
);
CREATE INDEX idx_media_owner ON media(owner_type, owner_id);

-- ─── DISPUTES ─────────────────────────────────────────────────────
CREATE TABLE disputes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id     INTEGER,
  tenant_name     TEXT,
  type            TEXT,    -- non-payment, damage, lease-violation, etc.
  status          TEXT    DEFAULT 'open',    -- open, in-progress, resolved, escalated
  description     TEXT,
  filed_date      DATE    DEFAULT CURRENT_DATE,
  resolved_date   DATE,
  notes           TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

-- ─── CONSTRUCTION PROJECTS ───────────────────────────────────────
CREATE TABLE construction_projects (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  property_id         INTEGER,
  type                TEXT,    -- new-build, extension, renovation, fit-out
  status              TEXT,    -- planning, in-progress, on-hold, completed
  start_date          DATE,
  target_completion   DATE,
  budget              REAL,
  spent               REAL,
  contractor          TEXT,
  notes               TEXT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id) REFERENCES properties(id)
);
