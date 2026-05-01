/**
 * Wipe all property + cheque data. Preserves users, tasks, leads, etc.
 *
 * Usage:
 *   DB_PATH=/var/asg/data/asg.db node wipe-properties.js          # dry-run
 *   DB_PATH=/var/asg/data/asg.db node wipe-properties.js --commit
 *
 * Auto-backs up the DB to <DB_PATH>.before-wipe-<ts> before deleting.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'asg.db');
const COMMIT  = process.argv.includes('--commit');

if (!fs.existsSync(DB_PATH)) {
  console.error(`DB not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);

const counts = {
  properties:        db.prepare('SELECT COUNT(*) c FROM properties').get().c,
  property_cheques:  db.prepare('SELECT COUNT(*) c FROM property_cheques').get().c,
  property_files:    (() => { try { return db.prepare('SELECT COUNT(*) c FROM property_files').get().c; } catch { return 0; } })(),
};

console.log(`DB:                ${DB_PATH}`);
console.log(`properties:        ${counts.properties}`);
console.log(`property_cheques:  ${counts.property_cheques}`);
console.log(`property_files:    ${counts.property_files}`);

if (!COMMIT) {
  console.log('\n[dry-run] Pass --commit to actually wipe.');
  process.exit(0);
}

const backupPath = `${DB_PATH}.before-wipe-${Date.now()}`;
fs.copyFileSync(DB_PATH, backupPath);
console.log(`\nBackup written to ${backupPath}`);

const tx = db.transaction(() => {
  db.prepare('DELETE FROM property_cheques').run();
  try { db.prepare('DELETE FROM property_files').run(); } catch (_) {}
  db.prepare('DELETE FROM properties').run();
  try {
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('properties','property_cheques','property_files')").run();
  } catch (_) {}
});
tx();

console.log('Wiped properties + cheques + property_files.');
console.log(`Now: ${db.prepare('SELECT COUNT(*) c FROM properties').get().c} properties, ${db.prepare('SELECT COUNT(*) c FROM property_cheques').get().c} cheques.`);
db.close();
