/**
 * Secondary (resale) listings.
 *
 *   GET    /api/secondary                — any user
 *   GET    /api/secondary/:id            — any user
 *   POST   /api/secondary                — any user (creates with addedBy = self)
 *   PATCH  /api/secondary/:id            — admin or original creator
 *   DELETE /api/secondary/:id            — admin or original creator
 *
 * Per the original product decision: both admin and agent can add directly,
 * the whole sales team sees every listing, but only the creator (or admin) edits it.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const SEC_FIELDS = [
  'title', 'type', 'txn_type', 'status', 'location', 'size',
  'beds', 'baths', 'price', 'rent',
  'owner_name', 'owner_phone', 'owner_email',
  'description', 'amenities',
  'added_by_id', 'added_by_name', 'added_by_type'
];

function canEdit(user, listing) {
  if (user.role === 'admin') return true;
  return user.id === listing.added_by_id;
}

router.get('/', requireAuth, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM secondary_listings ORDER BY updated_at DESC').all();
  res.json({ listings: rows.map(rowToApi) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM secondary_listings WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Listing not found' });
  res.json({ listing: rowToApi(row) });
});

router.post('/', requireAuth, (req, res) => {
  const data = bodyToDb(req.body, SEC_FIELDS);
  if (!data.title)    return res.status(400).json({ error: 'title required' });
  if (!data.location) return res.status(400).json({ error: 'location required' });

  // Override author fields — never trust the client
  data.added_by_id   = req.user.id;
  data.added_by_name = req.user.name;
  data.added_by_type = req.user.role;

  const cols = Object.keys(data);
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO secondary_listings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM secondary_listings WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ listing: rowToApi(row) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM secondary_listings WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Listing not found' });
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: 'Forbidden' });

  const data = bodyToDb(req.body, SEC_FIELDS);
  // Don't let people rewrite who created it
  delete data.added_by_id; delete data.added_by_name; delete data.added_by_type;
  if (!Object.keys(data).length) return res.json({ listing: rowToApi(existing) });

  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(`UPDATE secondary_listings SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const row = getDb().prepare('SELECT * FROM secondary_listings WHERE id = ?').get(id);
  res.json({ listing: rowToApi(row) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM secondary_listings WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Listing not found' });
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: 'Forbidden' });
  getDb().prepare('DELETE FROM secondary_listings WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
