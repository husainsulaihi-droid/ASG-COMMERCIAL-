/**
 * Properties (owned portfolio) endpoints.
 *
 *   GET    /api/properties              — list (filtered by viewer's role)
 *   GET    /api/properties/:id          — single (403 if viewer can't see it)
 *   POST   /api/properties              — admin only
 *   PATCH  /api/properties/:id          — admin only
 *   DELETE /api/properties/:id          — admin only
 *
 * Cheques (sub-resource):
 *   GET    /api/properties/:id/cheques
 *   POST   /api/properties/:id/cheques
 *   PATCH  /api/properties/:id/cheques/:cid
 *   DELETE /api/properties/:id/cheques/:cid
 *
 * Visibility rules (server-enforced):
 *   admin              → all
 *   sales / general    → vacant only
 *   leasing            → rented only
 *   property_management → managed only
 *   accounts           → none
 *
 *   Non-admin viewers always have rent/financial fields stripped from
 *   the API response. Tenant info is hidden unless the viewer's role is
 *   leasing or property_management.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const PROP_FIELDS = [
  'type', 'name', 'unit_no', 'trade_license', 'usage', 'location', 'map_link',
  'size', 'area', 'compound', 'mezzanine',
  'ownership', 'partner_name', 'our_share', 'owner_name', 'owner_phone',
  'mgmt_fee', 'mgmt_date', 'purchase_price', 'purchase_date', 'market_value',
  'status', 'annual_rent', 'service_charges', 'maintenance_fees', 'vat',
  'tenant_name', 'tenant_phone', 'tenant_email', 'reminder_days',
  'lease_start', 'lease_end', 'num_cheques', 'notes', 'coords',
  'holding_company', 'plot_no', 'ejari_number', 'deposit'
];

const FINANCIAL_FIELDS = [
  'annualRent', 'purchasePrice', 'marketValue', 'serviceCharges',
  'maintenanceFees', 'vat', 'mgmtFee', 'purchaseDate', 'mgmtDate',
  'ourShare', 'partnerName'
];
const TENANT_FIELDS = [
  'tenantName', 'tenantPhone', 'tenantEmail', 'leaseStart', 'leaseEnd', 'numCheques'
];

function visibleByRole(rows, user) {
  if (user.role === 'admin') return rows;
  const r = user.agentRole || 'general';
  if (r === 'sales' || r === 'general')   return rows.filter(p => p.status === 'vacant');
  if (r === 'leasing')                    return rows.filter(p => p.status === 'rented');
  if (r === 'property_management')        return rows.filter(p => p.ownership === 'management');
  if (r === 'accounts')                   return [];
  return rows;
}

function canSeeTenantInfo(user) {
  if (user.role === 'admin') return true;
  return user.agentRole === 'leasing' || user.agentRole === 'property_management';
}

function shapeForViewer(row, user) {
  let api = rowToApi(row);
  if (user.role === 'admin') return api;
  for (const f of FINANCIAL_FIELDS) delete api[f];
  if (!canSeeTenantInfo(user))    for (const f of TENANT_FIELDS) delete api[f];
  return api;
}

// ─── Properties CRUD ───────────────────────────

router.get('/', requireAuth, (req, res) => {
  const all = getDb().prepare('SELECT * FROM properties ORDER BY created_at DESC').all();
  const visible = visibleByRole(all, req.user);
  res.json({ properties: visible.map(p => shapeForViewer(p, req.user)) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Property not found' });
  const visible = visibleByRole([row], req.user);
  if (!visible.length) return res.status(403).json({ error: 'Forbidden' });
  res.json({ property: shapeForViewer(row, req.user) });
});

router.post('/', requireAdmin, (req, res) => {
  const data = bodyToDb(req.body, PROP_FIELDS);
  if (!data.name) return res.status(400).json({ error: 'name required' });
  data.added_by_id   = req.user.id;
  data.added_by_name = req.user.name;

  const cols = Object.keys(data);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO properties (${cols.join(', ')}) VALUES (${placeholders})`
  ).run(...values);
  const row = getDb().prepare('SELECT * FROM properties WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ property: rowToApi(row) });
});

router.patch('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Property not found' });

  const data = bodyToDb(req.body, PROP_FIELDS);
  if (!Object.keys(data).length) return res.json({ property: rowToApi(existing) });

  const sets   = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), id];
  getDb().prepare(
    `UPDATE properties SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...values);

  const row = getDb().prepare('SELECT * FROM properties WHERE id = ?').get(id);
  res.json({ property: rowToApi(row) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = getDb().prepare('DELETE FROM properties WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Property not found' });
  res.json({ ok: true });
});

// ─── Cheques (sub-resource) ──────────────────

router.get('/:id/cheques', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = getDb().prepare(
    'SELECT * FROM property_cheques WHERE property_id = ? ORDER BY cheque_num'
  ).all(id);
  res.json({ cheques: rows.map(rowToApi) });
});

router.post('/:id/cheques', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const result = getDb().prepare(
    'INSERT INTO property_cheques (property_id, cheque_num, cheque_date, amount, status) VALUES (?, ?, ?, ?, ?)'
  ).run(id, b.chequeNum || null, b.chequeDate || null, b.amount || null, b.status || 'pending');
  const row = getDb().prepare('SELECT * FROM property_cheques WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ cheque: rowToApi(row) });
});

router.patch('/:id/cheques/:cid', requireAdmin, (req, res) => {
  const cid = parseInt(req.params.cid, 10);
  const b = req.body || {};
  const updates = [];
  const values = [];
  if (b.chequeNum  !== undefined) { updates.push('cheque_num = ?');  values.push(b.chequeNum); }
  if (b.chequeDate !== undefined) { updates.push('cheque_date = ?'); values.push(b.chequeDate); }
  if (b.amount     !== undefined) { updates.push('amount = ?');      values.push(b.amount); }
  if (b.status     !== undefined) { updates.push('status = ?');      values.push(b.status); }
  if (!updates.length) {
    const row = getDb().prepare('SELECT * FROM property_cheques WHERE id = ?').get(cid);
    return res.json({ cheque: rowToApi(row) });
  }
  values.push(cid);
  getDb().prepare(`UPDATE property_cheques SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const row = getDb().prepare('SELECT * FROM property_cheques WHERE id = ?').get(cid);
  res.json({ cheque: rowToApi(row) });
});

router.delete('/:id/cheques/:cid', requireAdmin, (req, res) => {
  const cid = parseInt(req.params.cid, 10);
  getDb().prepare('DELETE FROM property_cheques WHERE id = ?').run(cid);
  res.json({ ok: true });
});

module.exports = router;
