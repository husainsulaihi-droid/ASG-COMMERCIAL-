/**
 * Financial summary route — single source of truth for rental income,
 * management income, deductions, and other aggregated figures shown
 * on the Financials tab and used by the PDF report.
 *
 *   GET /api/financials/summary?year=YYYY&type=warehouse|office|residential|land|all
 *
 * Returns JSON:
 *   {
 *     year, type,
 *     kpis: { rentalNet, deductions, mgmtIncome, additional, brokerage, lateFees, grandTotal, vacantCount },
 *     rentalRows:    [{ id, name, type, ownership, sharePct, annual, totalDed, net, ourIncome }],
 *     mgmtRows:      [{ id, name, type, fee, maint, admin, annual }],
 *     vacantRows:    [{ id, name, type, ownership }],
 *     additionalRows:[{ id, name, type, maint, vat, sub }],
 *     deductionsBreakdown: { land, license, service, dewa, ejari, civilDefense, legal, corporateTax }
 *   }
 *
 * Managed properties are EXCLUDED from rentalRows — the rent on a managed
 * property belongs to the owner, not us. Their mgmt fee + maintenance +
 * admin fee land in mgmtRows instead.
 */

const express = require('express');
const { getDb } = require('./db');
const { requireAdmin } = require('./middleware');
const { rowToApi } = require('./utils');

const router = express.Router();

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function totalDeductions(p) {
  return num(p.landCharges) + num(p.licenseFees) + num(p.serviceCharges)
       + num(p.dewaCharges) + num(p.ejariFees) + num(p.civilDefenseCharges)
       + num(p.legalFee)    + num(p.corporateTax);
}

function activeInYear(p, year) {
  const start = p.leaseStart ? new Date(p.leaseStart) : null;
  const end   = p.leaseEnd   ? new Date(p.leaseEnd)   : null;
  if (!start && !end) return p.status === 'rented';
  const yearStart = new Date(`${year}-01-01`);
  const yearEnd   = new Date(`${year}-12-31`);
  if (start && start > yearEnd) return false;
  if (end   && end   < yearStart) return false;
  return true;
}

router.get('/summary', requireAdmin, (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const typeFilter = String(req.query.type || 'all');

  const rows = getDb().prepare('SELECT * FROM properties').all().map(rowToApi);
  const pool = typeFilter === 'all' ? rows : rows.filter(p => p.type === typeFilter);

  // ── Rental rows: rented + has rent + NOT managed ──
  const rentalRows = pool
    .filter(p => p.status === 'rented' && num(p.annualRent) > 0 && p.ownership !== 'management')
    .map(p => {
      const annual = num(p.annualRent);
      const totalDed = totalDeductions(p);
      const net = Math.max(0, annual - totalDed);
      const sharePct = p.ownership === 'partnership' ? (num(p.ourShare) || 100) : 100;
      const ourIncome = Math.round(net * (sharePct / 100));
      return {
        id: p.id, name: p.name, type: p.type, ownership: p.ownership,
        sharePct, annual, totalDed, net, ourIncome,
        landCharges: num(p.landCharges), licenseFees: num(p.licenseFees),
        serviceCharges: num(p.serviceCharges), dewaCharges: num(p.dewaCharges),
        ejariFees: num(p.ejariFees), civilDefenseCharges: num(p.civilDefenseCharges),
        legalFee: num(p.legalFee), corporateTax: num(p.corporateTax),
        tenantName: p.tenantName || '',
      };
    })
    .sort((a, b) => b.ourIncome - a.ourIncome);

  // ── Management rows: every management property ──
  const mgmtRows = pool
    .filter(p => p.ownership === 'management')
    .map(p => {
      const fee   = num(p.mgmtFee);
      const maint = num(p.mgmtMaintenance);
      const admin = num(p.mgmtAdminFee);
      return {
        id: p.id, name: p.name, type: p.type,
        fee, maint, admin, annual: fee + maint + admin,
        ownerName: p.ownerName || '', ownerPhone: p.ownerPhone || '',
      };
    })
    .sort((a, b) => b.annual - a.annual);

  // ── Vacant: own/partnership only (managed vacancies aren't our missed income) ──
  const vacantRows = pool
    .filter(p => p.status === 'vacant' && (p.ownership === 'own' || p.ownership === 'partnership'))
    .map(p => ({ id: p.id, name: p.name, type: p.type, ownership: p.ownership }));

  // ── Maintenance + VAT (rented, non-managed) ──
  const additionalRows = pool
    .filter(p => p.status === 'rented' && p.ownership !== 'management')
    .map(p => {
      const maint = Math.round(num(p.maintenanceFees));
      const vat   = Math.round(num(p.vat) || num(p.annualRent) * 0.05);
      return { id: p.id, name: p.name, type: p.type, maint, vat, sub: maint + vat };
    })
    .filter(r => r.sub > 0)
    .sort((a, b) => b.sub - a.sub);

  // ── Brokerage + cash receipts (one-offs) ──
  const brokerageTotal = pool.reduce((s, p) => s + num(p.brokerageAmount), 0);
  const cashTotal      = pool.reduce((s, p) => s + num(p.cashAmount), 0);

  // ── Late + bounce cheque fees ──
  let lateFees = 0;
  for (const p of pool) {
    const cqs = getDb().prepare('SELECT late_fees FROM property_cheques WHERE property_id = ?').all(p.id);
    for (const c of cqs) lateFees += num(c.late_fees);
  }

  const deductionsBreakdown = {
    land:          rentalRows.reduce((s, r) => s + r.landCharges, 0),
    license:       rentalRows.reduce((s, r) => s + r.licenseFees, 0),
    service:       rentalRows.reduce((s, r) => s + r.serviceCharges, 0),
    dewa:          rentalRows.reduce((s, r) => s + r.dewaCharges, 0),
    ejari:         rentalRows.reduce((s, r) => s + r.ejariFees, 0),
    civilDefense:  rentalRows.reduce((s, r) => s + r.civilDefenseCharges, 0),
    legal:         rentalRows.reduce((s, r) => s + r.legalFee, 0),
    corporateTax:  rentalRows.reduce((s, r) => s + r.corporateTax, 0),
  };

  const rentalNet  = rentalRows.reduce((s, r) => s + r.ourIncome, 0);
  const deductions = Object.values(deductionsBreakdown).reduce((s, n) => s + n, 0);
  const mgmtIncome = mgmtRows.reduce((s, r) => s + r.annual, 0);
  const additional = additionalRows.reduce((s, r) => s + r.sub, 0);

  res.json({
    year, type: typeFilter,
    kpis: {
      rentalNet, deductions, mgmtIncome, additional,
      brokerage: brokerageTotal, cash: cashTotal, lateFees,
      grandTotal: rentalNet + mgmtIncome + additional + brokerageTotal + lateFees,
      vacantCount: vacantRows.length,
      rentedCount: rentalRows.length,
      managedCount: mgmtRows.length,
    },
    rentalRows, mgmtRows, vacantRows, additionalRows, deductionsBreakdown,
  });
});

module.exports = router;
