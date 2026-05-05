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

// When a property is linked to a compound, these four charges are paid at the
// compound level (one bill for the whole compound, not per warehouse) and the
// per-property fields here are ignored to avoid double-counting.
function totalDeductions(p) {
  const inCompound = !!p.compoundId;
  const land    = inCompound ? 0 : num(p.landCharges);
  const license = inCompound ? 0 : num(p.licenseFees);
  const service = inCompound ? 0 : num(p.serviceCharges);
  const civDef  = inCompound ? 0 : num(p.civilDefenseCharges);
  return land + license + service + civDef
       + num(p.dewaCharges) + num(p.ejariFees)
       + num(p.legalFee)    + num(p.corporateTax)
       + num(p.managementFees);
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
  // Compound-linked properties show zero for compound-level charges in their
  // own row; those charges land in compoundRows below instead.
  const rentalRows = pool
    .filter(p => p.status === 'rented' && num(p.annualRent) > 0 && p.ownership !== 'management')
    .map(p => {
      const inCompound = !!p.compoundId;
      const annual = num(p.annualRent);
      const totalDed = totalDeductions(p);
      const net = Math.max(0, annual - totalDed);
      const sharePct = p.ownership === 'partnership' ? (num(p.ourShare) || 100) : 100;
      const ourIncome = Math.round(net * (sharePct / 100));
      return {
        id: p.id, name: p.name, type: p.type, ownership: p.ownership,
        compoundId: p.compoundId || null,
        sharePct, annual, totalDed, net, ourIncome,
        landCharges:         inCompound ? 0 : num(p.landCharges),
        licenseFees:         inCompound ? 0 : num(p.licenseFees),
        serviceCharges:      inCompound ? 0 : num(p.serviceCharges),
        civilDefenseCharges: inCompound ? 0 : num(p.civilDefenseCharges),
        dewaCharges: num(p.dewaCharges),
        ejariFees:   num(p.ejariFees),
        legalFee:    num(p.legalFee),
        corporateTax:num(p.corporateTax),
        managementFees: num(p.managementFees),
        tenantName: p.tenantName || '',
      };
    })
    .sort((a, b) => b.ourIncome - a.ourIncome);

  // ── Compound deductions: one row per compound that has ≥1 property in pool ──
  const usedCompoundIds = new Set(pool.map(p => p.compoundId).filter(Boolean));
  const compoundRows = [];
  if (usedCompoundIds.size > 0) {
    const allCompounds = getDb().prepare('SELECT * FROM compounds').all().map(rowToApi);
    for (const c of allCompounds) {
      if (!usedCompoundIds.has(c.id)) continue;
      const linkedCount = pool.filter(p => p.compoundId === c.id).length;
      const land    = num(c.landCharges);
      const license = num(c.licenseFees);
      const service = num(c.serviceCharges);
      const civDef  = num(c.civilDefenseCharges);
      compoundRows.push({
        id: c.id, name: c.name, location: c.location || '',
        propertyCount: linkedCount,
        landCharges: land, licenseFees: license,
        serviceCharges: service, civilDefenseCharges: civDef,
        total: land + license + service + civDef,
      });
    }
    compoundRows.sort((a, b) => b.total - a.total);
  }

  // ── Management rows: managed-ownership AND any rented property where
  // we paid an internal management fee (counts as income to mgmt arm). ──
  const mgmtRows = [];
  for (const p of pool) {
    if (p.ownership === 'management') {
      const fee   = num(p.mgmtFee);
      const maint = num(p.mgmtMaintenance);
      const admin = num(p.mgmtAdminFee);
      mgmtRows.push({
        id: p.id, name: p.name, type: p.type, source: 'managed',
        fee, maint, admin, annual: fee + maint + admin,
        ownerName: p.ownerName || '', ownerPhone: p.ownerPhone || '',
      });
    } else if (num(p.managementFees) > 0) {
      // Internal management fee charged on an owned/partnered property.
      const fee = num(p.managementFees);
      mgmtRows.push({
        id: p.id, name: p.name, type: p.type, source: 'internal',
        fee, maint: 0, admin: 0, annual: fee,
        ownerName: '', ownerPhone: '',
      });
    }
  }
  mgmtRows.sort((a, b) => b.annual - a.annual);

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

  // Per-property deductions (compound-linked properties contribute 0 here).
  const propLevel = {
    land:    rentalRows.reduce((s, r) => s + r.landCharges, 0),
    license: rentalRows.reduce((s, r) => s + r.licenseFees, 0),
    service: rentalRows.reduce((s, r) => s + r.serviceCharges, 0),
    civilDefense: rentalRows.reduce((s, r) => s + r.civilDefenseCharges, 0),
  };
  // Compound-level deductions (one bill per compound).
  const compLevel = {
    land:    compoundRows.reduce((s, c) => s + c.landCharges, 0),
    license: compoundRows.reduce((s, c) => s + c.licenseFees, 0),
    service: compoundRows.reduce((s, c) => s + c.serviceCharges, 0),
    civilDefense: compoundRows.reduce((s, c) => s + c.civilDefenseCharges, 0),
  };
  const deductionsBreakdown = {
    land:           propLevel.land    + compLevel.land,
    license:        propLevel.license + compLevel.license,
    service:        propLevel.service + compLevel.service,
    civilDefense:   propLevel.civilDefense + compLevel.civilDefense,
    dewa:           rentalRows.reduce((s, r) => s + r.dewaCharges, 0),
    ejari:          rentalRows.reduce((s, r) => s + r.ejariFees, 0),
    legal:          rentalRows.reduce((s, r) => s + r.legalFee, 0),
    corporateTax:   rentalRows.reduce((s, r) => s + r.corporateTax, 0),
    managementFees: rentalRows.reduce((s, r) => s + r.managementFees, 0),
  };

  const rentalNet     = rentalRows.reduce((s, r) => s + r.ourIncome, 0);
  const compoundTotal = compoundRows.reduce((s, c) => s + c.total, 0);
  const deductions    = Object.values(deductionsBreakdown).reduce((s, n) => s + n, 0);
  const mgmtIncome    = mgmtRows.reduce((s, r) => s + r.annual, 0);
  const maintenance   = additionalRows.reduce((s, r) => s + r.maint, 0);  // INCOME (we keep)
  const vat           = additionalRows.reduce((s, r) => s + r.vat,   0);  // OUTFLOW (passes to govt)

  // rentalNet already excludes compound-level charges (zeroed in totalDeductions
  // for compound-linked properties), so subtract compoundTotal once here.
  const grandTotal = rentalNet + mgmtIncome + maintenance + brokerageTotal + lateFees
                   - vat - compoundTotal;

  res.json({
    year, type: typeFilter,
    kpis: {
      rentalNet, deductions, mgmtIncome,
      maintenance, vat,
      brokerage: brokerageTotal, cash: cashTotal, lateFees,
      compoundDeductions: compoundTotal,
      grandTotal,
      vacantCount: vacantRows.length,
      rentedCount: rentalRows.length,
      managedCount: mgmtRows.length,
      compoundCount: compoundRows.length,
    },
    rentalRows, mgmtRows, vacantRows, additionalRows, compoundRows, deductionsBreakdown,
  });
});

module.exports = router;
