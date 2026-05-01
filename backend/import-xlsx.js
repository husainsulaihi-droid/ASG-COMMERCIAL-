/**
 * Import properties + cheques from "Transaction List.xlsx".
 *
 *   node import-xlsx.js --plan      # dry-run, prints counts + warnings, no DB writes
 *   node import-xlsx.js --commit    # backup DB, then insert
 *
 * Inputs:
 *   /home/claude/projects/ASG-COMMERCIAL-/images/Transaction List.xlsx (default)
 *   override with: XLSX_PATH=/path/to/file.xlsx
 *
 * Source layout:
 *   - Sheet "ASG PROPERTIES "  : master list across 5 sections
 *   - SAIFUDDIN (5x), CALCON   : sub-tenant matrix tabs (extra properties not in master)
 *   - 13 other tabs            : per-property cheque schedules
 */

const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const XLSX_PATH = process.env.XLSX_PATH ||
  '/home/claude/projects/ASG-COMMERCIAL-/images/Transaction List.xlsx';

const MODE = process.argv.includes('--commit') ? 'commit' : 'plan';

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function clean(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t || t === 'N/A' || t === '-' || t === '.' || t.toLowerCase() === 'pending') return null;
  return t;
}

function cleanKeepCase(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/[\r\n]+/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!t) return null;
  return t;
}

// "32,000.00", "  100,000.00 ", "1,799,999.96" -> 32000 etc; null otherwise
function parseAmount(s) {
  if (s === null || s === undefined) return null;
  let t = String(s).replace(/[, \r\n]/g, '').trim();
  if (!t || /^[-N\/A.]+$/i.test(t)) return null;
  // strip "AED " etc
  t = t.replace(/^AED/i, '').trim();
  // multi-year cells: take the LAST number
  const matches = t.match(/-?\d+(\.\d+)?/g);
  if (!matches) return null;
  const v = parseFloat(matches[matches.length - 1]);
  return isFinite(v) ? v : null;
}

// Multi-year cells: take the LAST line
function pickLastLine(s) {
  if (s === null || s === undefined) return null;
  const lines = String(s).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

// Date parser. Accepts: "04-04-2025", "31/07/2025", "30-07-2026", "01/01/2026"
// Returns "YYYY-MM-DD" or null.
function parseDate(s) {
  const raw = pickLastLine(s);
  if (!raw) return null;
  const t = String(raw).trim();
  // Strip everything after first space (handles "Pending " etc)
  const m = t.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (!m) return null;
  let [, dd, mm, yy] = m;
  dd = dd.padStart(2, '0');
  mm = mm.padStart(2, '0');
  if (yy.length === 2) yy = (parseInt(yy, 10) > 50 ? '19' : '20') + yy;
  // Sanity: month 1-12, day 1-31
  if (parseInt(mm, 10) < 1 || parseInt(mm, 10) > 12) return null;
  if (parseInt(dd, 10) < 1 || parseInt(dd, 10) > 31) return null;
  return `${yy}-${mm}-${dd}`;
}

// "1,044 sq.ft" / "200 sq.m" / "55.36 sq.m " -> {value, unit}
function parseSize(s) {
  if (s === null || s === undefined) return { value: null, unit: null };
  const t = String(s).toLowerCase().replace(/,/g, '').trim();
  const m = t.match(/(-?\d+(\.\d+)?)\s*(sq\.?\s*ft|sq\.?\s*m)?/);
  if (!m) return { value: null, unit: null };
  const value = parseFloat(m[1]);
  let unit = null;
  if (m[3]) unit = m[3].includes('m') ? 'sqm' : 'sqft';
  return { value: isFinite(value) ? value : null, unit };
}

// "Tenant: Al Basmah Tyres" → "Al Basmah Tyres"
function stripTenantPrefix(s) {
  if (!s) return s;
  return String(s).replace(/^\s*tenant\s*:\s*/i, '').replace(/^\s*nant\s*:\s*/i, '').trim();
}

function normName(s) {
  if (!s) return '';
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Plot normalizer — split on "-", strip leading zeros per segment, rejoin.
// "243-0235" -> "243-235", "0369-0584" -> "369-584"
function plotKey(s) {
  if (!s) return '';
  return String(s).split('-')
    .map(p => p.replace(/[^0-9]/g, '').replace(/^0+/, ''))
    .filter(Boolean).join('-');
}

// "Schon Business Park Office No. 264\nTenant: …" → { propLine, tenantLine }
function splitNameTenant(cellA, cellB) {
  // master sheet: col 2 ("Property Name") may contain multi-line "Property\nTenant: X"
  // OR col 3 may hold tenant separately.
  const left = cleanKeepCase(cellA);
  const right = cleanKeepCase(cellB);
  let propLine = null, tenantLine = null;
  if (left && left.includes('\n')) {
    const parts = left.split('\n').map(s => s.trim()).filter(Boolean);
    propLine = parts[0];
    const t = parts.find(p => /^tenant\s*:/i.test(p));
    if (t) tenantLine = stripTenantPrefix(t);
  } else {
    propLine = left;
  }
  if (right) {
    if (/^tenant\s*:/i.test(right) || /^nant\s*:/i.test(right)) {
      tenantLine = stripTenantPrefix(right);
    } else if (!tenantLine) {
      tenantLine = right;
    }
  }
  return { propLine, tenantLine };
}

// ─────────────────────────────────────────────────────────────────────
// Section definitions (master sheet)
// ─────────────────────────────────────────────────────────────────────

// Master sheet section identifiers — col 0 cell content uniquely flags each.
function classifyMasterRow(row, currentSection, currentHolding) {
  const c0 = clean(row[0]);
  const c1 = clean(row[1]);
  const c2 = clean(row[2]);

  // Section header detection
  if (c0 && /COMMERCIAL\s*\(Self-Owned\)/i.test(c0)) return { section: 'commercial-own', holding: null, kind: 'section' };
  if (c0 && /SISTER COMPANIES.*Co-?owned/i.test(c0)) return { section: 'sister', holding: null, kind: 'section' };
  if (c1 && /COMPANY MANAGED BY ASG/i.test(c1)) return { section: 'managed', holding: null, kind: 'section' };

  // Sub-headers (header row repeating column titles)
  if (c1 && /^(Property Name|Company:|Company Name)$/i.test(c1) && !c0) return { kind: 'subheader' };

  // Date helper rows ("From"/"To") — second header line
  if (!c0 && (clean(row[9]) === 'From' || clean(row[10]) === 'To')) return { kind: 'subheader' };

  // Standalone date label rows (e.g. R53 "DREC CONTRACT EXP:" with date in col 3).
  // Must come BEFORE the holding-row heuristic — otherwise these get misread
  // as holding headers with empty names and clobber the real holding context.
  if (c0 && /^(DREC CONTRACT EXP|LICENSE EXPIRY)/i.test(c0) && !c1) return { kind: 'subheader' };

  // A row that has DATA (lease dates, plot, status, etc.) is data, never holding.
  // Detect "looks like data" by presence of usage/plot/contract fields.
  const hasDataIndicators =
    !!clean(row[4]) ||  // usage
    !!clean(row[5]) ||  // plot
    !!clean(row[9]) ||  // lease from
    !!clean(row[10]) || // lease to
    !!clean(row[11]);   // contract value

  // Holding-company headers (within sister section). Have c0 with company name
  // but no c1 (no "1, 2, 3" index) and no c2 (no Property Name) AND no data fields.
  // e.g. "ALI QADR GLASS INDUSTRIES …  DREC CONTRACT EXPIRY: …"
  if (c0 && !c1 && !c2 && !hasDataIndicators && currentSection === 'sister') {
    const holding = c0.replace(/DREC.*/i, '').replace(/LICENSE EXP.*/i, '').replace(/\s*PLOT.*/i, '').trim();
    if (!holding) return { kind: 'subheader' };
    return { kind: 'holding', section: currentSection, holding };
  }
  // Some holding rows have just a name in c1 (R98 "AL SHAMS PERFUMES L.L.C")
  // — these have NO data fields. R106 (SEPTEM warehouse) has data fields, so it's a data row.
  if (!c0 && c1 && !c2 && !hasDataIndicators && currentSection === 'managed') {
    return { kind: 'holding', section: currentSection, holding: c1 };
  }

  // SOLD rows — skip
  if (c0 && /^SOLD$/i.test(c0)) return { kind: 'sold' };

  // Data row: at minimum needs c1 (index/name) OR c2 (property name)
  if (c1 || c2) return { kind: 'data', section: currentSection, holding: currentHolding };

  return { kind: 'blank' };
}

function buildPropertyFromMasterRow(row, ctx) {
  const propName = cleanKeepCase(row[2]);
  const propTenantCol3 = cleanKeepCase(row[3]);
  const split = splitNameTenant(row[2], row[3]);
  const usage = clean(row[4]) || ctx.section;
  const plot = clean(row[5]);
  const sizeRaw = clean(row[6]);
  const location = clean(row[7]);
  const ejari = clean(row[8]);
  const leaseFrom = parseDate(row[9]);
  const leaseTo = parseDate(row[10]);
  const rent = parseAmount(row[11]);
  const dep = parseAmount(row[12]);
  const subFee = parseAmount(row[13]);
  const status = clean(row[14]);
  const license = clean(row[15]);
  const dewa = clean(row[16]);
  const tenantEmail = clean(row[17]);
  const tenantPhone = clean(row[18]);
  const remarks = clean(row[20]);

  const size = parseSize(sizeRaw);

  // Extract unit number from property name e.g. "Warehouse No. 01" -> "01", "Office No. 264" -> "264"
  let unitNo = null;
  const nameForUnit = (split.propLine || propName || '');
  const um = nameForUnit.match(/(?:Warehouse|Office|Shed|Unit|RS|Retail)\s*(?:No\.?)?\s*([A-Z0-9-]+)/i);
  if (um) unitNo = um[1];

  // type derivation
  let type = 'commercial';
  if (ctx.section === 'residential' || /studio|bedroom|villa|townhouse/i.test(usage || '')) type = 'residential';
  else if (/warehouse|factory|workshop|garage|shed|labour/i.test(usage || '')) type = 'warehouse';
  else if (/office/i.test(usage || '')) type = 'office';
  else if (/retail|shop/i.test(usage || '')) type = 'retail';

  // ownership derivation
  let ownership = 'own';
  if (ctx.section === 'sister') ownership = 'partnership';
  else if (ctx.section === 'managed') ownership = 'management';

  // status derivation
  let dbStatus = 'vacant';
  const sUp = (status || '').toUpperCase();
  if (/^(ACTIVE|ONGOING CASE|SHORT TERM|PAYMENT PENDING|PENDING)/.test(sUp)) dbStatus = 'rented';
  else if (/^(VACANT|FOR RENT|FOR SALE|COMPLETE CONTRACT|EXPIRED)/.test(sUp)) dbStatus = 'vacant';
  else if (split.tenantLine) dbStatus = 'rented';

  // name (NOT NULL) — prefer the property CODE from col 0 (BAD-104, AAS-02, SBP-264).
  // That's the identifier the user actually uses. Fall back to descriptive name only
  // when col 0 is missing (e.g. orphan rows like the lone "Warehouse 02" under
  // MILLENNIALS AUTO, or sub-rows under SEPTEM where col 0 is blank).
  const codeCol0 = clean(row[0]);
  const codeIsValid = codeCol0
    && !/^(SOLD|COMMERCIAL|SISTER|COMPANY|DREC|LICENSE)/i.test(codeCol0)
    && codeCol0.length < 30;
  const c1Name = cleanKeepCase(row[1]);
  const c1IsName = c1Name && !/^\d+$/.test(c1Name);
  const descName = split.propLine || propName || (c1IsName ? c1Name : null);
  const name = codeIsValid ? codeCol0 : (descName || `Unit ${plot || '?'}`);

  // Keep the descriptive label too — useful in UI / search. Stored on `unit_no`
  // (since that field already shows the warehouse number for sub-units).
  // If we have a code as name, put descriptive label in compound/notes.
  const descLabel = (descName && descName !== name) ? descName : null;

  return {
    type,
    name,
    unit_no: unitNo,
    trade_license: license,
    usage: usage,
    location: location,
    size: size.value,
    compound: location && location.includes(',') ? location.split(',').slice(1).join(',').trim() : null,
    ownership,
    partner_name: ctx.section === 'sister' ? ctx.holding : null,
    holding_company: ctx.holding || null,
    plot_no: plot,
    ejari_number: ejari,
    dewa_number: dewa,
    annual_rent: rent,
    security_deposit: dep,
    sub_lease_fees: subFee,
    tenant_name: split.tenantLine,
    tenant_phone: tenantPhone,
    tenant_email: tenantEmail,
    lease_start: leaseFrom,
    lease_end: leaseTo,
    status: dbStatus,
    notes: [
      descLabel ? `Label: ${descLabel}` : null,
      remarks ? `Remarks: ${remarks}` : null,
      sizeRaw && size.unit === 'sqm' ? `Size: ${sizeRaw}` : null,
      status && status !== 'ACTIVE' ? `Excel status: ${status}` : null,
    ].filter(Boolean).join('\n') || null,
    _src: 'master',
  };
}

// ─────────────────────────────────────────────────────────────────────
// Master sheet parser
// ─────────────────────────────────────────────────────────────────────

function parseMaster(wb, warnings) {
  const ws = wb.Sheets['ASG PROPERTIES '];
  if (!ws) { warnings.push('Master sheet missing'); return []; }
  const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

  const props = [];
  // First section is implicit "residential" (rows 3-12 before "COMMERCIAL (Self-Owned)" header at R13).
  let currentSection = 'residential';
  let currentHolding = null;

  for (let i = 3; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const cls = classifyMasterRow(row, currentSection, currentHolding);
    switch (cls.kind) {
      case 'section':
        currentSection = cls.section;
        currentHolding = null;
        break;
      case 'holding':
        currentHolding = cls.holding;
        break;
      case 'subheader':
      case 'sold':
      case 'blank':
        break;
      case 'data': {
        const p = buildPropertyFromMasterRow(row, { section: currentSection, holding: currentHolding });
        props.push(p);
        break;
      }
    }
  }
  return props;
}

// ─────────────────────────────────────────────────────────────────────
// Sub-tenant matrix (SAIFUDDIN x5, CALCON) — extra properties not in master
// ─────────────────────────────────────────────────────────────────────

const SUBTENANT_TABS = [
  'SAIFUDDIN (215-202)',
  'SAIFUDDIN (612-219)',
  'SAIFUDDIN (365-207)',
  'SAIFUDDIN (613-1449)',
  'SAIFUDDIN (215-532)',
  'CALCON',
];

function parseSubtenantTab(wb, sheetName, warnings) {
  const ws = wb.Sheets[sheetName];
  if (!ws) { warnings.push(`Sheet missing: ${sheetName}`); return []; }
  const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

  // Header rows have: MAIN CONTRACT NO, DM PLOT NO, LOCATION, CONTRACT DURATION
  let mainContract = null, dmPlot = null, location = null, contractDuration = null;
  let holdingCompany = null;
  let headerRowIdx = -1;

  for (let i = 0; i < Math.min(20, aoa.length); i++) {
    const r = aoa[i] || [];
    const c0 = clean(r[0]);
    const c1 = cleanKeepCase(r[1]);
    if (c0 === 'MAIN CONTRACT NO.') mainContract = c1;
    else if (c0 === 'DM PLOT NO.') dmPlot = c1;
    else if (c0 === 'LOCATION') location = c1;
    else if (c0 === 'CONTRACT DURATION') contractDuration = c1;
    else if (!holdingCompany && c1 && /L\.?L\.?C\.?$/i.test(c1)) holdingCompany = c1;
    // Detect the header row by presence of "Sub-Contract No" anywhere
    if (r.some(c => c && /^Sub-?Contract\s*No$/i.test(String(c).trim()))) {
      headerRowIdx = i;
    }
  }
  if (headerRowIdx < 0) { warnings.push(`${sheetName}: header row not found`); return []; }

  // Build column map from header row (lowercased, normalized)
  const header = (aoa[headerRowIdx] || []).map(c => c ? String(c).toLowerCase().replace(/\s+/g, ' ').trim() : null);
  const colIdx = (...patterns) => {
    for (let j = 0; j < header.length; j++) {
      if (header[j] && patterns.some(p => p.test(header[j]))) return j;
    }
    return -1;
  };
  const COL_SUBCONTRACT = colIdx(/sub-?contract no/i);
  const COL_EJARI       = colIdx(/ejari/i);
  const COL_SUBUNIT     = colIdx(/sub-?unit no/i);
  const COL_FROM        = headerRowIdx + 1 < aoa.length ? (aoa[headerRowIdx + 1] || []).findIndex(c => c && /^from$/i.test(String(c).trim())) : -1;
  const COL_TO          = headerRowIdx + 1 < aoa.length ? (aoa[headerRowIdx + 1] || []).findIndex(c => c && /^to$/i.test(String(c).trim())) : -1;
  const COL_VALUE       = colIdx(/contract value/i);
  const COL_SUBFEE      = colIdx(/sub-?lease fee/i);
  const COL_TENANT      = colIdx(/sub-?tenant\s*name|tenant\s*name/i);
  const COL_UNITTYPE    = colIdx(/unit type/i);
  const COL_AREA        = colIdx(/area/i);
  const COL_STATUS      = colIdx(/^status$/i);
  const COL_REMARKS     = colIdx(/remark/i);
  const COL_EMAIL       = colIdx(/email/i);
  const COL_MOBILE      = colIdx(/mobile|mob no|mob\b/i);
  const COL_LICENSE     = colIdx(/license/i);

  const dataStart = headerRowIdx + 2; // skip header + From/To row
  const props = [];
  let blankStreak = 0;
  for (let i = dataStart; i < aoa.length; i++) {
    const r = aoa[i] || [];
    if (!r.some(c => c !== null && c !== '')) { if (++blankStreak > 5) break; continue; }
    blankStreak = 0;

    const subContractNo = COL_SUBCONTRACT >= 0 ? clean(r[COL_SUBCONTRACT]) : null;
    const subUnit = COL_SUBUNIT >= 0 ? clean(r[COL_SUBUNIT]) : null;
    const subTenantName = COL_TENANT >= 0 ? cleanKeepCase(r[COL_TENANT]) : null;
    const status = COL_STATUS >= 0 ? clean(r[COL_STATUS]) : null;
    if (!subUnit && !subTenantName && !subContractNo) continue;

    const ejari = COL_EJARI >= 0 ? clean(r[COL_EJARI]) : null;
    const from = COL_FROM >= 0 ? parseDate(r[COL_FROM]) : null;
    const to = COL_TO >= 0 ? parseDate(r[COL_TO]) : null;
    const value = COL_VALUE >= 0 ? parseAmount(r[COL_VALUE]) : null;
    const subFee = COL_SUBFEE >= 0 ? parseAmount(r[COL_SUBFEE]) : null;
    const unitType = COL_UNITTYPE >= 0 ? clean(r[COL_UNITTYPE]) : null;
    const area = COL_AREA >= 0 ? parseAmount(r[COL_AREA]) : null;
    const remarks = COL_REMARKS >= 0 ? clean(r[COL_REMARKS]) : null;
    const email = COL_EMAIL >= 0 ? clean(r[COL_EMAIL]) : null;
    const mobile = COL_MOBILE >= 0 ? clean(r[COL_MOBILE]) : null;
    const license = COL_LICENSE >= 0 ? clean(r[COL_LICENSE]) : null;

    const tenantName = stripTenantPrefix(subTenantName);

    let dbStatus = 'vacant';
    const sUp = (status || '').toUpperCase();
    if (/^(ACTIVE|PAYMENT PENDING|PENDING|ONGOING)/.test(sUp)) dbStatus = 'rented';
    if (/^VACANT/.test(sUp) || (!tenantName && !value)) dbStatus = 'vacant';

    let type = 'warehouse';
    if (/office/i.test(unitType || '')) type = 'office';
    else if (/garage|workshop|shed/i.test(unitType || '')) type = 'warehouse';

    // Property code: prefer col 0 if it looks like a code (SAIFUDDIN tabs have
    // codes there like "SLW-202-SH01"). Fall back to sub-contract column, then to
    // a synthesized code (CALCON tab has only "5E+12" Excel scientific-notation
    // truncations there, so we use "CALCON-S01" etc).
    const explicitCol0 = clean(r[0]);
    const isScientific = subContractNo && /^[\d.]+E[+-]?\d+$/i.test(subContractNo);
    const isPureNum = subContractNo && /^\d+$/.test(subContractNo);
    const tabCode = sheetName.replace(/[\s()]+/g, '').replace(/-+$/, '');
    let code;
    if (explicitCol0 && /^[A-Z]/.test(explicitCol0) && /[-]/.test(explicitCol0)) {
      code = explicitCol0;
      // Source sometimes has the same parent code on consecutive rows that are
      // actually different sub-units (R8 + R9 both "SLW-202-SH01" but units SH01 / SH02).
      // Replace the trailing segment with the actual sub-unit so the name is unique.
      if (subUnit && code.includes('-')) {
        const lastDash = code.lastIndexOf('-');
        const tail = code.slice(lastDash + 1);
        if (tail.toUpperCase() !== String(subUnit).toUpperCase()) {
          code = code.slice(0, lastDash + 1) + subUnit;
        }
      }
    } else if (subContractNo && !isScientific && !isPureNum && /[A-Z]/i.test(subContractNo)) {
      code = subContractNo;
    } else {
      // Build a clean fallback like "SLW-202-SH05" from the plot suffix.
      const plotSuffix = (dmPlot || '').split('-').pop() || '';
      const compactPlotSuffix = plotSuffix.replace(/^0+/, '');
      const tabPrefix = sheetName.match(/SAIFUDDIN/i) ? 'SLW'
        : sheetName.match(/CALCON/i) ? 'CALCON'
        : tabCode;
      code = `${tabPrefix}-${compactPlotSuffix || tabCode}-${subUnit || '?'}`;
    }

    props.push({
      type,
      name: code,
      unit_no: subUnit,
      trade_license: license,
      usage: unitType,
      location: location,
      size: area,
      compound: location,
      ownership: 'management',
      partner_name: null,
      holding_company: holdingCompany,
      plot_no: dmPlot,
      ejari_number: ejari,
      dewa_number: null,
      annual_rent: value,
      security_deposit: null,
      sub_lease_fees: subFee,
      tenant_name: tenantName,
      tenant_phone: mobile,
      tenant_email: email,
      lease_start: from,
      lease_end: to,
      status: dbStatus,
      notes: [
        mainContract ? `Main contract: ${mainContract}` : null,
        contractDuration ? `Main duration: ${contractDuration}` : null,
        remarks ? `Remarks: ${remarks}` : null,
      ].filter(Boolean).join('\n') || null,
      _src: sheetName,
    });
  }
  return props;
}

// ─────────────────────────────────────────────────────────────────────
// Cheque tabs (Format B)
// ─────────────────────────────────────────────────────────────────────

const CHEQUE_TABS = [
  'ACCELERATE', 'AL DANAH', 'AMEERAT', 'SBP Office 264', 'SBP Office 268',
  'BOEING ', 'CUTTING EDGE', 'HARAZ', 'UNIQUE', 'MAMA BATOOL ',
  'MILLENNIALS WORKSHOP', 'OLIVE ISLAND', 'MILLENIALS AUTO',
];

// Each tab contains 1+ "contract blocks". Each block:
//   YEAR 2024-2025
//   <num>. Active Contract / Completed Contract / With Case
//   TENANT NAME:        <name>
//   PROPERTY DETAILS:   <details>
//   TENANCY PERIOD:     <from to>
//   ANNUAL RENT:        <value>
//   MODE OF PAYMENT:    <count>
//   ...
//   PARTICULARS  CHEQUE DATE  CHEQUE NO.  AMOUNT  PAYABLE TO
//   First Rental Payment ...
//   Second Rental Payment ...
//   ...
//   TOTAL RENT  -  -  <total>  -
//
// We extract: tenant, property details, tenancy period, and all "Rental Payment" rows.
// Optionally also "Security Deposit / VAT / Mgmt Fee" rows from ADDITIONAL CHARGES.

function parseChequeTab(wb, sheetName, warnings) {
  const ws = wb.Sheets[sheetName];
  if (!ws) { warnings.push(`Cheque sheet missing: ${sheetName}`); return []; }
  const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

  const blocks = [];
  let cur = null;
  for (let i = 0; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const c0 = clean(r[0]);
    const c1 = cleanKeepCase(r[1]);
    if (!c0 && !c1) continue;

    // Start new block on TENANT NAME row
    if (c0 && /^TENANT NAME:?$/i.test(c0)) {
      if (cur) blocks.push(cur);
      cur = { tenant: c1, propertyDetails: null, period: null, annualRent: null, cheques: [], _row: i, _sheet: sheetName };
      continue;
    }
    if (!cur) continue;

    if (c0 && /^PROPERTY DETAILS:?$/i.test(c0)) cur.propertyDetails = c1;
    else if (c0 && /^TENANCY PERIOD:?$/i.test(c0)) cur.period = c1;
    else if (c0 && /^ANNUAL RENT:?$/i.test(c0)) cur.annualRent = parseAmount(c1);
    else if (c0 && /Rental Payment/i.test(c0)) {
      // Columns: 0=Particulars, 1=CHEQUE DATE, 2=CHEQUE NO, 3=AMOUNT, 4=PAYABLE TO
      // (or for SBP-Office variant: 0,1,2 same; 3=CASH/BANK; 4=AMOUNT; 5=PAYABLE)
      // Detect amount by trying both positions.
      const dateRaw = clean(r[1]);
      const noRaw = clean(r[2]);
      let amt = parseAmount(r[3]);
      let payable = clean(r[4]);
      // SBP-Office format: amount in col 4, payable in 5
      if (amt === null && parseAmount(r[4]) !== null) {
        amt = parseAmount(r[4]);
        payable = clean(r[5]);
      }
      // Some cells are CASH/BANK transfer (not a cheque): col3 holds amount, no date/no
      if (amt === null) {
        amt = parseAmount(r[3]);
      }
      if (amt !== null) {
        cur.cheques.push({
          particulars: c0,
          cheque_date: parseDate(dateRaw),
          cheque_no_text: noRaw,
          amount: amt,
          payable_to: payable,
        });
      }
    }
  }
  if (cur) blocks.push(cur);

  // Filter out empty blocks (no tenant + no cheques)
  return blocks.filter(b => b.tenant || b.cheques.length);
}

// ─────────────────────────────────────────────────────────────────────
// Match cheque blocks to properties
// ─────────────────────────────────────────────────────────────────────

// Tab → keyword(s) that should appear in a candidate property's holding/name/partner.
// Used to constrain the search so e.g. UNIQUE-tab cheques can't match SAIFUDDIN properties.
const TAB_HINTS = {
  'ACCELERATE':            ['ACCELERATE'],
  'AL DANAH':              ['DANAH', 'DANA-'],
  'AMEERAT':               ['AMEERAT', 'AAS-'],
  'SBP Office 264':        ['SBP-264', 'OFFICE NO. 264', 'OFFICE NO 264'],
  'SBP Office 268':        ['SBP-268', 'OFFICE NO. 268', 'OFFICE NO 268'],
  'BOEING ':               ['BOEING', 'BO-'],
  'CUTTING EDGE':          ['CUTTING EDGE', 'CE-'],
  'HARAZ':                 ['HARAZ', 'HM-'],
  'UNIQUE':                ['UNIQUE', 'UM-'],
  'MAMA BATOOL ':          ['MAMA BATOOL', 'MAMA-'],
  'MILLENNIALS WORKSHOP':  ['MILLENNIALS WORKSHOP', 'MWT-'],
  'OLIVE ISLAND':          ['OLIVE ISLAND', 'OI-'],
  'MILLENIALS AUTO':       ['MILLENIALS AUTO', 'MILLENNIALS AUTO', 'MAS-'],
};

function tabHits(p, sheetName) {
  const hints = TAB_HINTS[sheetName] || [];
  if (!hints.length) return false;
  const hay = (
    (p.holding_company || '') + ' | ' +
    (p.partner_name || '') + ' | ' +
    (p.name || '') + ' | ' +
    (p.unit_no || '')
  ).toUpperCase();
  return hints.some(h => hay.includes(h.toUpperCase()));
}

function matchBlockToProperty(block, properties, sheetName) {
  const detail = block.propertyDetails || '';
  const plotMatch = detail.match(/Plot\s*0*([0-9]{2,4})-?0*([0-9]{2,4})/i);
  const blockPlot = plotMatch ? plotKey(`${plotMatch[1]}-${plotMatch[2]}`) : '';
  const whMatch = detail.match(/(?:Warehouse|Office|Shed|Property|Workshop|Unit|Garage)\s*(?:No\.?)?\s*0*([A-Z0-9]+)/i);
  const whNum = whMatch ? whMatch[1].replace(/^0+/, '') : null;

  const tenantNorm = normName(block.tenant);
  const tenantKey = tenantNorm.slice(0, 10);
  const periodFromStr = block.period ? block.period.split(/to|-/i)[0].trim() : '';
  const periodFrom = parseDate(periodFromStr);

  // Candidate filter: only properties belonging to this tab's holding/sister-co.
  const hasHints = !!(TAB_HINTS[sheetName] || []).length;
  const candidates = hasHints ? properties.filter(p => tabHits(p, sheetName)) : properties;
  const pool = candidates.length ? candidates : properties;

  // STRICT tenant-match policy (per user instruction "skip those cheques"):
  // Only consider properties whose tenant_name has a real overlap with the
  // block's tenant — otherwise we'd be attaching cheques from old/historical
  // tenants (AL MASAR, OFFROAD past contracts, etc.) to whoever's in master now.
  function tenantOverlap(p) {
    const pn = normName(p.tenant_name);
    if (!tenantNorm || !pn) return 0;
    if (pn === tenantNorm) return 8;
    // 8-char prefix overlap either way
    const k = 8;
    if (pn.length >= k && tenantNorm.length >= k && (pn.startsWith(tenantNorm.slice(0, k)) || tenantNorm.startsWith(pn.slice(0, k)))) return 5;
    // shorter 6-char prefix as a softer signal
    if (pn.length >= 6 && tenantNorm.length >= 6 && (pn.startsWith(tenantNorm.slice(0, 6)) || tenantNorm.startsWith(pn.slice(0, 6)))) return 3;
    return 0;
  }

  let best = null, bestScore = -100;
  for (const p of pool) {
    const tMatch = tenantOverlap(p);
    if (tMatch === 0) continue;   // strict: no tenant overlap → skip this candidate
    let score = tMatch;
    const pPlot = plotKey(p.plot_no);
    if (blockPlot && pPlot) {
      if (pPlot === blockPlot) score += 6;
      else score -= 6;
    }
    if (whNum && p.unit_no && p.unit_no.replace(/[^A-Z0-9]/gi, '').toUpperCase().endsWith(whNum.toUpperCase())) score += 4;
    if (whNum && p.name && new RegExp(`(?:^|\\s|No\\.?\\s*)0*${whNum}\\b`, 'i').test(p.name)) score += 3;
    if (periodFrom && p.lease_start === periodFrom) score += 4;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return { match: best, score: bestScore };
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(XLSX_PATH)) { console.error('XLSX not found:', XLSX_PATH); process.exit(1); }
  console.log('Reading:', XLSX_PATH, 'mode:', MODE);
  const wb = xlsx.readFile(XLSX_PATH);
  const warnings = [];

  // 1) properties from master + sub-tenant tabs
  const properties = [];
  properties.push(...parseMaster(wb, warnings));
  for (const tab of SUBTENANT_TABS) {
    properties.push(...parseSubtenantTab(wb, tab, warnings));
  }

  // 2) cheque blocks
  const blocks = [];
  for (const tab of CHEQUE_TABS) {
    blocks.push(...parseChequeTab(wb, tab, warnings));
  }

  // Skip blocks that are empty templates (no tenant AND no cheques)
  const realBlocks = blocks.filter(b => b.tenant && b.cheques.length);
  const skippedEmpty = blocks.length - realBlocks.length;

  // 3) match each block to a property
  const matched = [];
  const unmatched = [];
  for (const b of realBlocks) {
    const { match, score } = matchBlockToProperty(b, properties, b._sheet);
    // With strict tenant-match, any positive score is a real match.
    if (match && score >= 3) matched.push({ block: b, prop: match, score });
    else unmatched.push({ block: b, score, bestGuess: match });
  }

  // ─── REPORT ─────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('PLAN SUMMARY');
  console.log('========================================');
  console.log('Properties to insert:', properties.length);
  const bySrc = {};
  for (const p of properties) bySrc[p._src] = (bySrc[p._src] || 0) + 1;
  for (const k of Object.keys(bySrc)) console.log('  from', k, ':', bySrc[k]);

  console.log('\nProperty status breakdown:');
  const byStatus = {};
  for (const p of properties) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  for (const k of Object.keys(byStatus)) console.log('  ', k, ':', byStatus[k]);

  console.log('\nProperty type breakdown:');
  const byType = {};
  for (const p of properties) byType[p.type] = (byType[p.type] || 0) + 1;
  for (const k of Object.keys(byType)) console.log('  ', k, ':', byType[k]);

  console.log('\nCheque blocks parsed:', blocks.length, '(real:', realBlocks.length, '/ empty templates skipped:', skippedEmpty, ')');
  console.log('  matched to a property (score >= 4):', matched.length);
  console.log('  unmatched / weak match:', unmatched.length);
  const totalCheques = matched.reduce((s, m) => s + m.block.cheques.length, 0);
  console.log('  total cheque rows to insert:', totalCheques);

  console.log('\nWarnings:', warnings.length);
  for (const w of warnings) console.log('   -', w);

  if (unmatched.length) {
    console.log('\nUnmatched cheque blocks (top 10):');
    for (const u of unmatched.slice(0, 10)) {
      console.log(`   [${u.block._sheet} R${u.block._row}] tenant="${u.block.tenant}" details="${(u.block.propertyDetails||'').slice(0,80)}" -> bestScore=${u.score} bestGuess=${u.bestGuess?.name||'-'}`);
    }
  }

  console.log('\nMatched cheque blocks (sheet -> property | tenant | #cheques | total AED):');
  for (const m of matched) {
    const total = m.block.cheques.reduce((s, c) => s + (c.amount || 0), 0);
    console.log(`  [${m.block._sheet}] -> ${m.prop.name} | ${m.prop.tenant_name || '(no tenant)'} | ${m.block.cheques.length} cheques | ${total.toLocaleString()} AED  (score ${m.score})`);
  }

  console.log('\nSample property records (first 5 from master):');
  for (const p of properties.filter(p => p._src === 'master').slice(0, 5)) {
    console.log(`  ${p.name} | type=${p.type} | usage=${p.usage} | tenant=${p.tenant_name||'-'} | rent=${p.annual_rent||'-'} | status=${p.status}`);
  }
  console.log('\nSample SAIFUDDIN sub-tenants (first 5):');
  for (const p of properties.filter(p => p._src.startsWith('SAIFUDDIN')).slice(0, 5)) {
    console.log(`  ${p.name} | unit=${p.unit_no} | tenant=${p.tenant_name||'-'} | rent=${p.annual_rent||'-'} | status=${p.status}`);
  }

  if (MODE !== 'commit') {
    console.log('\nThis was a PLAN run. No DB changes made.');
    console.log('Re-run with --commit to insert.');
    return;
  }

  // ─── COMMIT ─────────────────────────────────────────────────
  const Database = require('better-sqlite3');
  const DB_PATH = process.env.DB_PATH || '/var/asg/data/asg.db';
  const BACKUP = `${DB_PATH}.before-xlsx-${Date.now()}`;
  fs.copyFileSync(DB_PATH, BACKUP);
  console.log('\nBackup:', BACKUP);

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  const insertProp = db.prepare(`
    INSERT INTO properties
      (type, name, unit_no, trade_license, usage, location, size, compound,
       ownership, partner_name, holding_company, plot_no, ejari_number, dewa_number,
       annual_rent, security_deposit, sub_lease_fees,
       tenant_name, tenant_phone, tenant_email,
       lease_start, lease_end, status, notes, num_cheques, added_by_name)
    VALUES (@type, @name, @unit_no, @trade_license, @usage, @location, @size, @compound,
            @ownership, @partner_name, @holding_company, @plot_no, @ejari_number, @dewa_number,
            @annual_rent, @security_deposit, @sub_lease_fees,
            @tenant_name, @tenant_phone, @tenant_email,
            @lease_start, @lease_end, @status, @notes, @num_cheques, 'XLSX import')
  `);

  const insertCheque = db.prepare(`
    INSERT INTO property_cheques (property_id, cheque_num, cheque_no_text, cheque_date, amount, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const idMap = new Map();   // properties[index] -> rowid
    properties.forEach((p, idx) => {
      const params = {
        type: p.type, name: p.name, unit_no: p.unit_no || null, trade_license: p.trade_license || null,
        usage: p.usage || null, location: p.location || null, size: p.size, compound: p.compound || null,
        ownership: p.ownership, partner_name: p.partner_name || null, holding_company: p.holding_company || null,
        plot_no: p.plot_no || null, ejari_number: p.ejari_number || null, dewa_number: p.dewa_number || null,
        annual_rent: p.annual_rent, security_deposit: p.security_deposit, sub_lease_fees: p.sub_lease_fees,
        tenant_name: p.tenant_name || null, tenant_phone: p.tenant_phone || null, tenant_email: p.tenant_email || null,
        lease_start: p.lease_start || null, lease_end: p.lease_end || null,
        status: p.status, notes: p.notes || null, num_cheques: null,
      };
      const info = insertProp.run(params);
      idMap.set(idx, info.lastInsertRowid);
    });

    let chequeCount = 0;
    for (const m of matched) {
      const propIdx = properties.indexOf(m.prop);
      const propId = idMap.get(propIdx);
      if (!propId) continue;
      m.block.cheques.forEach((c, i) => {
        // Only insert "Rental Payment" rows (skip security deposit / VAT etc as primary cheques)
        const today = new Date().toISOString().slice(0, 10);
        let st = 'pending';
        if (c.cheque_date && c.cheque_date < today) st = 'received';
        insertCheque.run(propId, i + 1, c.cheque_no_text || null, c.cheque_date || null, c.amount, st);
        chequeCount++;
      });
      // update num_cheques on the property
      db.prepare('UPDATE properties SET num_cheques = ? WHERE id = ?').run(m.block.cheques.length, propId);
    }
    return { propCount: properties.length, chequeCount };
  });

  const result = tx();
  console.log('\nCommitted.');
  console.log('  properties inserted:', result.propCount);
  console.log('  cheques inserted:   ', result.chequeCount);
  console.log('  backup at:', BACKUP);
  db.close();
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('FATAL:', e); process.exit(1); }
}
