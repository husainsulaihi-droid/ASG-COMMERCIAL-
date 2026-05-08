/**
 * Tenancy contracts generated from the Contract Builder.
 *
 *   GET    /api/contracts            — admin: all; agents: own
 *   GET    /api/contracts/:id        — admin or creator
 *   POST   /api/contracts            — any user (creator = self)
 *   PATCH  /api/contracts/:id        — admin or creator
 *   DELETE /api/contracts/:id        — admin or creator
 *
 * Mirrors routes-proposals.js. Contracts have no child rows, so the payload
 * is a flat record.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const FIELDS = [
  'title', 'contract_date',
  'prop_id', 'prop_name', 'property_type', 'property_area', 'location',
  'plot_no', 'makani_no', 'building_name', 'property_no', 'dewa_no', 'prop_usage',
  'owner_name',
  'lessor_name', 'lessor_eid', 'lessor_license', 'lessor_authority',
  'lessor_phone', 'lessor_email',
  'tenant_name', 'tenant_eid', 'tenant_license', 'tenant_authority',
  'tenant_phone', 'tenant_email', 'co_occupants',
  'contract_from', 'contract_to', 'contract_value', 'annual_rent',
  'security_deposit', 'payment_mode',
  'term1', 'term2', 'term3', 'term4', 'term5',
  'term6', 'term7', 'term8', 'term9', 'term10'
];

function canEdit(user, c) {
  if (user.role === 'admin') return true;
  return user.id === c.created_by_id;
}

router.get('/', requireAuth, (req, res) => {
  const rows = req.user.role === 'admin'
    ? getDb().prepare('SELECT * FROM contracts ORDER BY created_at DESC').all()
    : getDb().prepare('SELECT * FROM contracts WHERE created_by_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ contracts: rows.map(rowToApi) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM contracts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Contract not found' });
  if (!canEdit(req.user, row)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ contract: rowToApi(row) });
});

router.post('/', requireAuth, (req, res) => {
  const data = bodyToDb(req.body, FIELDS);

  data.created_by_id   = req.user.id;
  data.created_by_name = req.user.name;
  data.created_by_type = req.user.role;

  const cols = Object.keys(data);
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO contracts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...values);

  const row = getDb().prepare('SELECT * FROM contracts WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ contract: rowToApi(row) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM contracts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Contract not found' });
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: 'Forbidden' });

  const data = bodyToDb(req.body, FIELDS);
  if (Object.keys(data).length) {
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(data), id];
    getDb().prepare(`UPDATE contracts SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  }

  const row = getDb().prepare('SELECT * FROM contracts WHERE id = ?').get(id);
  res.json({ contract: rowToApi(row) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM contracts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Contract not found' });
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: 'Forbidden' });
  getDb().prepare('DELETE FROM contracts WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
