/**
 * Compounds — groups of warehouses that share one set of charges.
 *
 *   GET    /api/compounds          — list all
 *   GET    /api/compounds/:id      — single
 *   POST   /api/compounds          — admin only
 *   PATCH  /api/compounds/:id      — admin only
 *   DELETE /api/compounds/:id      — admin only (only if no linked properties)
 *
 * A compound holds the land/service/license/civil-defense charges that are
 * paid once for the whole compound. Properties linked via properties.compound_id
 * inherit those deductions at the compound level (counted once, not per unit).
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const COMPOUND_FIELDS = [
  'name', 'location', 'notes',
  'land_charges', 'service_charges', 'license_fees', 'civil_defense_charges',
];

router.get('/', requireAuth, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM compounds ORDER BY name COLLATE NOCASE').all();
  // Annotate with property count so the UI can show "3 warehouses linked".
  const counts = getDb().prepare(
    'SELECT compound_id, COUNT(*) AS n FROM properties WHERE compound_id IS NOT NULL GROUP BY compound_id'
  ).all().reduce((m, r) => (m[r.compound_id] = r.n, m), {});
  res.json({
    compounds: rows.map(r => ({ ...rowToApi(r), propertyCount: counts[r.id] || 0 })),
  });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM compounds WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Compound not found' });
  const linked = getDb().prepare(
    'SELECT id FROM properties WHERE compound_id = ? ORDER BY name'
  ).all(id).map(r => r.id);
  res.json({ compound: { ...rowToApi(row), propertyIds: linked } });
});

// Sync the set of properties linked to this compound. Anything in `ids` that
// isn't already linked gets compound_id = compoundId; anything currently
// linked but not in `ids` gets compound_id = NULL.
function syncCompoundProperties(compoundId, ids) {
  const db = getDb();
  const want = new Set((ids || []).map(n => parseInt(n, 10)).filter(Number.isFinite));
  const current = new Set(
    db.prepare('SELECT id FROM properties WHERE compound_id = ?').all(compoundId).map(r => r.id)
  );
  const toAdd    = [...want].filter(id => !current.has(id));
  const toRemove = [...current].filter(id => !want.has(id));
  const setStmt   = db.prepare('UPDATE properties SET compound_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const clearStmt = db.prepare('UPDATE properties SET compound_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const tx = db.transaction(() => {
    for (const id of toAdd)    setStmt.run(compoundId, id);
    for (const id of toRemove) clearStmt.run(id);
  });
  tx();
  return { added: toAdd.length, removed: toRemove.length };
}

router.post('/', requireAdmin, (req, res) => {
  const data = bodyToDb(req.body, COMPOUND_FIELDS);
  if (!data.name) return res.status(400).json({ error: 'name required' });

  const exists = getDb().prepare(
    'SELECT id FROM compounds WHERE name = ? COLLATE NOCASE LIMIT 1'
  ).get(data.name);
  if (exists) return res.status(409).json({ error: `A compound named "${data.name}" already exists.` });

  const cols = Object.keys(data);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO compounds (${cols.join(', ')}) VALUES (${placeholders})`
  ).run(...values);
  if (Array.isArray(req.body.propertyIds)) {
    syncCompoundProperties(result.lastInsertRowid, req.body.propertyIds);
  }
  const row = getDb().prepare('SELECT * FROM compounds WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ compound: rowToApi(row) });
});

router.patch('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM compounds WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Compound not found' });

  const data = bodyToDb(req.body, COMPOUND_FIELDS);
  const hasIds = Array.isArray(req.body.propertyIds);
  if (!Object.keys(data).length && !hasIds) return res.json({ compound: rowToApi(existing) });

  if (data.name && data.name !== existing.name) {
    const dup = getDb().prepare(
      'SELECT id FROM compounds WHERE name = ? COLLATE NOCASE AND id != ? LIMIT 1'
    ).get(data.name, id);
    if (dup) return res.status(409).json({ error: `A compound named "${data.name}" already exists.` });
  }

  if (Object.keys(data).length) {
    const sets   = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(data), id];
    getDb().prepare(
      `UPDATE compounds SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(...values);
  }
  if (hasIds) syncCompoundProperties(id, req.body.propertyIds);

  const row = getDb().prepare('SELECT * FROM compounds WHERE id = ?').get(id);
  res.json({ compound: rowToApi(row) });
});

// Atomically unlink any linked properties (compound_id → NULL) and delete the
// compound row. The four compound-level charges those properties used to
// inherit (land, service, license, civil-defense) will simply not be deducted
// from financials anymore — admin can re-enter them per-property if needed.
router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const existing = db.prepare('SELECT id FROM compounds WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Compound not found' });

  const linkedCount = db.prepare(
    'SELECT COUNT(*) AS n FROM properties WHERE compound_id = ?'
  ).get(id).n;

  const tx = db.transaction(() => {
    db.prepare('UPDATE properties SET compound_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE compound_id = ?').run(id);
    db.prepare('DELETE FROM compounds WHERE id = ?').run(id);
  });
  tx();
  res.json({ ok: true, unlinked: linkedCount });
});

module.exports = router;
