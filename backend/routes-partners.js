/**
 * Partners — accounts for outside co-owners who can log in and see only the
 * properties they have a stake in (with a separate partner-facing rent and
 * no financials/tenant info).
 *
 *   GET    /api/partners              — admin: list all partner accounts + their links
 *   GET    /api/partners/:id          — admin: one partner with property links
 *   POST   /api/partners              — admin: create partner user
 *   PATCH  /api/partners/:id          — admin: edit partner (name/password/links)
 *   DELETE /api/partners/:id          — admin: soft-delete (active=0) + unlink properties
 *
 *   GET    /api/partners/me/properties — partner: list of their linked properties
 *                                        (also reachable via /api/properties as
 *                                        partner — this is just a convenience
 *                                        endpoint for a partner-only frontend view).
 *
 * Property links live in property_partners(property_id, user_id, share_pct).
 * The partner-facing rent is on properties.partner_rent (admin sets it on the
 * property edit modal — same value visible to every partner on that property).
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

function linksForPartner(userId) {
  return getDb().prepare(`
    SELECT pp.property_id, pp.share_pct, p.name AS property_name, p.location, p.partner_rent
      FROM property_partners pp
      JOIN properties p ON p.id = pp.property_id
      WHERE pp.user_id = ?
      ORDER BY p.name COLLATE NOCASE
  `).all(userId).map(r => ({
    propertyId:   r.property_id,
    propertyName: r.property_name,
    location:     r.location,
    partnerRent:  Number(r.partner_rent) || 0,
    sharePct:     Number(r.share_pct) || 0,
  }));
}

// Replace this partner's full set of links with the supplied list. `links` is
// [{ propertyId, sharePct }, ...]. Anything not in the list is removed.
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
    db.prepare('DELETE FROM property_partners WHERE user_id = ?').run(userId);
    const ins = db.prepare(
      'INSERT INTO property_partners (property_id, user_id, share_pct) VALUES (?, ?, ?)'
    );
    for (const [pid, pct] of want) ins.run(pid, userId, pct);
  });
  tx();
}

// ─── ADMIN ENDPOINTS ─────────────────────────────────

router.get('/', requireAdmin, (req, res) => {
  const rows = getDb().prepare(
    "SELECT * FROM users WHERE role = 'partner' AND active = 1 ORDER BY name COLLATE NOCASE"
  ).all();
  const partners = rows.map(u => ({
    ...sanitizeUser(u),
    properties: linksForPartner(u.id),
  }));
  res.json({ partners });
});

router.get('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = findUser(id);
  if (!u || u.role !== 'partner') return res.status(404).json({ error: 'Partner not found' });
  res.json({ partner: { ...sanitizeUser(u), properties: linksForPartner(id) } });
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
      VALUES (?, ?, 'partner', ?, ?, ?, 1)
    `).run(username, password_hash, name, b.email || null, b.phone || null);

    if (Array.isArray(b.properties)) {
      syncLinks(result.lastInsertRowid, b.properties);
    }

    const created = findUser(result.lastInsertRowid);
    res.status(201).json({
      partner: { ...sanitizeUser(created), properties: linksForPartner(created.id) },
    });
  } catch (e) {
    console.error('[partners POST] failed:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Internal error creating partner' });
  }
});

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const u = findUser(id);
    if (!u || u.role !== 'partner') return res.status(404).json({ error: 'Partner not found' });

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
    res.json({ partner: { ...sanitizeUser(fresh), properties: linksForPartner(id) } });
  } catch (e) {
    console.error('[partners PATCH] failed:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Internal error updating partner' });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = findUser(id);
  if (!u || u.role !== 'partner') return res.status(404).json({ error: 'Partner not found' });

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM property_partners WHERE user_id = ?').run(id);
    db.prepare("UPDATE users SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  });
  tx();
  res.json({ ok: true });
});

// ─── PARTNER SELF ENDPOINTS ──────────────────────────

router.get('/me/properties', requireAuth, (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ error: 'Partner only' });
  const rows = getDb().prepare(`
    SELECT p.*, pp.share_pct
      FROM properties p
      JOIN property_partners pp ON pp.property_id = p.id
      WHERE pp.user_id = ?
      ORDER BY p.name COLLATE NOCASE
  `).all(req.user.id);

  // Strip financials/tenant — only shape the safe fields. Use the same
  // logic as routes-properties.shapeForViewer for partners, but inline so
  // we don't have a circular-require with that module.
  const FINANCIAL = new Set([
    'annualRent', 'purchasePrice', 'marketValue', 'serviceCharges',
    'maintenanceFees', 'managementFees', 'vat', 'mgmtFee', 'mgmtMaintenance', 'mgmtAdminFee',
    'purchaseDate', 'mgmtDate',
    'ourShare', 'partnerName', 'partners',
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
    const partnerRent = Number(api.partnerRent) || 0;
    for (const f of FINANCIAL) delete api[f];
    for (const f of TENANT)    delete api[f];
    delete api.partnerRent;
    api.annualRent   = partnerRent;
    api.yourSharePct = sharePct;
    return api;
  });
  res.json({ properties });
});

module.exports = router;
