// One-shot migration: add columns that may be missing on older databases.
// Idempotent — re-running is safe (errors are caught and skipped).
const db = require('better-sqlite3')('/var/asg/data/asg.db');
const stmts = [
  'ALTER TABLE property_cheques ADD COLUMN late_fees REAL',
  'ALTER TABLE property_cheques ADD COLUMN cheque_no_text TEXT',
  'ALTER TABLE properties ADD COLUMN brokerage_amount REAL',
  'ALTER TABLE properties ADD COLUMN cash_amount REAL',
];
for (const s of stmts) {
  try { db.exec(s); console.log('OK:  ', s); }
  catch (e) { console.log('SKIP:', e.message); }
}
const cols = db.prepare('PRAGMA table_info(property_cheques)').all()
  .filter(c => /late_fees|cheque_no_text/.test(c.name))
  .map(c => c.name);
console.log('property_cheques has:', cols.join(', ') || '(none — failed)');
