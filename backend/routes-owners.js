/**
 * Owners — accounts for property owners whose properties ASG manages.
 * Independent of the partner system: owners have their own property links,
 * their own role, and their own login dashboard.
 *
 *   GET    /api/owners              — admin: list all owner accounts + their links
 *   GET    /api/owners/:id          — admin: one owner with property links
 *   POST   /api/owners              — admin: create owner user
 *   PATCH  /api/owners/:id          — admin: edit owner (name/password/links)
 *   DELETE /api/owners/:id          — admin: soft-delete (active=0) + unlink properties
 *
 *   GET    /api/owners/me/properties — owner: list of their linked properties
 *
 * Property links live in property_owners(property_id, user_id, share_pct).
 */

const express = require('express');
const { getDb } = require('./db');
const { hashPassword, sanitizeUser } = require('./auth');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi } = require('./utils');

const router = express.Router();

function findUser(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function usernameTaken(username, exceptId = null) {
  const row = exceptId
    ? getDb().prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, exceptId)
    : getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
  return !!row;
}

function linksForOwner(userId) {
  return getDb().prepare(`
    SELECT po.property_id, po.share_pct, p.name AS property_name, p.location
      FROM property_owners po
      JOIN properties p ON p.id = po.property_id
      WHERE po.user_id = ?
      ORDER BY p.name COLLATE NOCASE
  `).all(userId).map(r => ({
    propertyId:   r.property_id,
    propertyName: r.property_name,
    location:     r.location,
    sharePct:     Number(r.share_pct) || 0,
  }));
}

function syncLinks(userId, links) {
  const db = getDb();
  const want = new Map();
  for (const l of (links || [])) {
    const pid = parseInt(l.propertyId, 10);
    if (!Number.isFinite(pid)) continue;
    const pct = Number(l.sharePct);
    want.set(pid, Number.isFinite(pct) ? pct : 0);
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM property_owners WHERE user_id = ?').run(userId);
    const ins = db.prepare(
      'INSERT INTO property_owners (property_id, user_id, share_pct) VALUES (?, ?, ?)'
    );
    for (const [pid, pct] of want) ins.run(pid, userId, pct);
  });
  tx();
}

// ─── ADMIN ENDPOINTS ─────────────────────────────────

router.get('/', requireAdmin, (req, res) => {
  const rows = getDb().prepare(
    "SELECT * FROM users WHERE role = 'owner' AND active = 1 ORDER BY name COLLATE NOCASE"
  ).all();
  const owners = rows.map(u => ({
    ...sanitizeUser(u),
    properties: linksForOwner(u.id),
  }));
  res.json({ owners });
});

router.get('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = findUser(id);
  if (!u || u.role !== 'owner') return res.status(404).json({ error: 'Owner not found' });
  res.json({ owner: { ...sanitizeUser(u), properties: linksForOwner(id) } });
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const name     = String(b.name || '').trim();

    if (!username) return res.status(400).json({ error: 'username required' });
    if (!name)     return res.status(400).json({ error: 'name required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (usernameTaken(username)) return res.status(409).json({ error: 'Username taken' });

    const password_hash = await hashPassword(password);
    const result = getDb().prepare(`
      INSERT INTO users (username, password_hash, role, name, email, phone, active)
      VALUES (?, ?, 'owner', ?, ?, ?, 1)
    `).run(username, password_hash, name, b.email || null, b.phone || null);

    if (Array.isArray(b.properties)) {
      syncLinks(result.lastInsertRowid, b.properties);
    }

    const created = findUser(result.lastInsertRowid);
    res.status(201).json({
      owner: { ...sanitizeUser(created), properties: linksForOwner(created.id) },
    });
  } catch (e) {
    console.error('[owners POST] failed:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Internal error creating owner' });
  }
});

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const u = findUser(id);
    if (!u || u.role !== 'owner') return res.status(404).json({ error: 'Owner not found' });

    const b = req.body || {};
    const updates = [];
    const values = [];

    if (b.name != null)     { updates.push('name = ?');     values.push(String(b.name).trim()); }
    if (b.email != null)    { updates.push('email = ?');    values.push(b.email || null); }
    if (b.phone != null)    { updates.push('phone = ?');    values.push(b.phone || null); }
    if (b.username != null) {
      const un = String(b.username).trim();
      if (!un) return res.status(400).json({ error: 'username required' });
      if (usernameTaken(un, id)) return res.status(409).json({ error: 'Username taken' });
      updates.push('username = ?'); values.push(un);
    }
    if (b.password) {
      if (String(b.password).length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      updates.push('password_hash = ?');
      values.push(await hashPassword(b.password));
    }

    if (updates.length) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);
      getDb().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    if (Array.isArray(b.properties)) syncLinks(id, b.properties);

    const fresh = findUser(id);
    res.json({ owner: { ...sanitizeUser(fresh), properties: linksForOwner(id) } });
  } catch (e) {
    console.error('[owners PATCH] failed:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Internal error updating owner' });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = findUser(id);
  if (!u || u.role !== 'owner') return res.status(404).json({ error: 'Owner not found' });

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM property_owners WHERE user_id = ?').run(id);
    db.prepare("UPDATE users SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  });
  tx();
  res.json({ ok: true });
});

// ─── OWNER SELF ENDPOINTS ──────────────────────────

router.get('/me/properties', requireAuth, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const rows = getDb().prepare(`
    SELECT p.*, po.share_pct
      FROM properties p
      JOIN property_owners po ON po.property_id = p.id
      WHERE po.user_id = ?
      ORDER BY p.name COLLATE NOCASE
  `).all(req.user.id);

  // Strip financials/tenant/sensitive admin fields. Owners see the same
  // safe shape partners do.
  const FINANCIAL = new Set([
    'annualRent', 'purchasePrice', 'marketValue', 'serviceCharges',
    'maintenanceFees', 'managementFees', 'vat', 'mgmtFee', 'mgmtMaintenance', 'mgmtAdminFee',
    'purchaseDate', 'mgmtDate',
    'ourShare', 'partnerName', 'partners', 'partnerRent',
    'landCharges', 'licenseFees', 'subLeaseFees',
    'dewaCharges', 'ejariFees', 'civilDefenseCharges', 'legalFee',
    'corporateTax', 'securityDeposit', 'cashAmount', 'brokerageAmount',
  ]);
  const TENANT = new Set([
    'tenantName', 'tenantPhone', 'tenantEmail', 'leaseStart', 'leaseEnd', 'numCheques',
  ]);

  const properties = rows.map(r => {
    const sharePct = Number(r.share_pct) || 0;
    delete r.share_pct;
    const api = rowToApi(r);
    for (const f of FINANCIAL) delete api[f];
    for (const f of TENANT)    delete api[f];
    api.yourSharePct = sharePct;
    return api;
  });
  res.json({ properties });
});

module.exports = router;
