/**
 * Proposals + their cheque schedules.
 *
 *   GET    /api/proposals                  — admin: all; agents: own
 *   GET    /api/proposals/:id              — admin or creator
 *   POST   /api/proposals                  — any user (creator = self)
 *   PATCH  /api/proposals/:id              — admin or creator
 *   DELETE /api/proposals/:id              — admin or creator
 *
 * Cheques are bundled in the create/update payload as `cheques: [...]`,
 * and returned alongside the proposal record on every read.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAuth } = require('./middleware');
const { rowToApi, bodyToDb } = require('./utils');

const router = express.Router();

const PROP_FIELDS = [
  'title', 'ref', 'proposal_date', 'valid_until', 'prep_by',
  'prop_id', 'prop_name', 'prop_type', 'prop_location', 'prop_size',
  'client_name', 'client_company', 'client_phone', 'client_email',
  'rent', 'lessor', 'tenancy_from', 'tenancy_to', 'num_cheques',
  'vat_amount', 'service_amount', 'maint_amount', 'admin_amount', 'drec_amount',
  'terms_raw', 'notes'
];

function canEdit(user, p) {
  if (user.role === 'admin') return true;
  return user.id === p.created_by_id;
}

function withCheques(row) {
  if (!row) return null;
  const cheques = getDb().prepare(
    'SELECT * FROM proposal_cheques WHERE proposal_id = ? ORDER BY id ASC'
  ).all(row.id);
  const api = rowToApi(row);
  api.cheques = cheques.map(rowToApi);
  return api;
}

function replaceCheques(proposalId, cheques) {
  if (!Array.isArray(cheques)) return;
  const db = getDb();
  db.prepare('DELETE FROM proposal_cheques WHERE proposal_id = ?').run(proposalId);
  const stmt = db.prepare(
    'INSERT INTO proposal_cheques (proposal_id, ord_label, cheque_date, amount, payable) VALUES (?, ?, ?, ?, ?)'
  );
  for (const c of cheques) {
    stmt.run(
      proposalId,
      c.ordLabel || c.ord_label || null,
      c.chequeDate || c.cheque_date || null,
      Number(c.amount) || null,
      c.payable || null
    );
  }
}

router.get('/', requireAuth, (req, res) => {
  const rows = req.user.role === 'admin'
    ? getDb().prepare('SELECT * FROM proposals ORDER BY created_at DESC').all()
    : getDb().prepare('SELECT * FROM proposals WHERE created_by_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ proposals: rows.map(withCheques) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Proposal not found' });
  if (!canEdit(req.user, row) && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  res.json({ proposal: withCheques(row) });
});

router.post('/', requireAuth, (req, res) => {
  const data = bodyToDb(req.body, PROP_FIELDS);
  if (!data.title) return res.status(400).json({ error: 'title required' });

  data.created_by_id   = req.user.id;
  data.created_by_name = req.user.name;
  data.created_by_type = req.user.role;

  const cols = Object.keys(data);
  const values = cols.map(c => data[c]);
  const result = getDb().prepare(
    `INSERT INTO proposals (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...values);

  if (Array.isArray(req.body && req.body.cheques)) {
    replaceCheques(result.lastInsertRowid, req.body.cheques);
  }

  const row = getDb().prepare('SELECT * FROM proposals WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ proposal: withCheques(row) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Proposal not found' });
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: 'Forbidden' });

  const data = bodyToDb(req.body, PROP_FIELDS);
  if (Object.keys(data).length) {
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(data), id];
    getDb().prepare(`UPDATE proposals SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  }

  if (Array.isArray(req.body && req.body.cheques)) {
    replaceCheques(id, req.body.cheques);
  }

  const row = getDb().prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  res.json({ proposal: withCheques(row) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getDb().prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Proposal not found' });
  if (!canEdit(req.user, existing)) return res.status(403).json({ error: 'Forbidden' });
  getDb().prepare('DELETE FROM proposals WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
