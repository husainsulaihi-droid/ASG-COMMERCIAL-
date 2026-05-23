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

// ─── AI auto-fill (Ollama) ────────────────────────────────────────────────
// Reads a free-text contract description and extracts proposal fields via a
// local Ollama model. Configurable via env; defaults match the dev setup.
const OLLAMA_URL   = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

// The exact field set we ask the model to extract. Kept lean so a small model
// stays reliable. Anything it can't find it leaves null — the user fills the
// rest by hand.
const PARSE_KEYS = [
  'propName','propType','propLocation','propSize','plotNo','makaniNo','propertyNo','dewaNo','usage',
  'lessorName','lessorEid','lessorPhone','lessorEmail','lessorLicense','lessorAuthority',
  'clientName','clientCompany','clientPhone','clientEmail','clientEid','clientLicense','clientAuthority',
  'annualRent','contractYears','yearlyRents','tenancyFrom','tenancyTo','numCheques',
  'securityDeposit','serviceCharges','commission','maintenance','adminFee',
  'notes','terms',
];

const PROMPT_INSTRUCTIONS = `You are a data-extraction engine for a Dubai commercial real-estate CRM.
Read the tenancy/contract description and return ONE JSON object with these keys (use null when a value is not stated — never guess):

propName, propType, propLocation, propSize, plotNo, makaniNo, propertyNo, dewaNo, usage,
lessorName, lessorEid, lessorPhone, lessorEmail, lessorLicense, lessorAuthority,
clientName, clientCompany, clientPhone, clientEmail, clientEid, clientLicense, clientAuthority,
annualRent, contractYears, yearlyRents, tenancyFrom, tenancyTo, numCheques,
securityDeposit, serviceCharges, commission, maintenance, adminFee, notes, terms

Rules:
- The LESSOR / landlord / owner is the party RECEIVING rent. The CLIENT / tenant / lessee is the party PAYING rent. Assign names accordingly.
- propType is one of: Warehouse, Office, Residential, Land, Retail, Shop. Pick the closest.
- usage is one of: Commercial, Residential, Industrial.
- propSize is the area in square feet, as a number only (no "sqft").
- Money fields (annualRent, securityDeposit, serviceCharges, commission, maintenance, adminFee) are absolute numbers only — strip "AED", commas, and convert "120k" to 120000. NEVER calculate or guess a number that is not explicitly written. If a value is given only as a percentage (e.g. "commission 5%"), leave that field null and mention it in notes instead.
- An EID (lessorEid/clientEid) is an Emirates ID that starts with 784 (e.g. 784-1990-1234567-1). A trade licence number goes in lessorLicense/clientLicense. The issuing authority (DED, DMCC, DAFZA, JAFZA, etc.) goes in lessorAuthority/clientAuthority. Do not mix these up.
- annualRent is the FIRST year's annual rent.
- yearlyRents: ONLY fill this if the rent changes from year to year. When you fill it, list EVERY year in order INCLUDING year 1, e.g. a 2-year lease at 480000 then 500000 is [480000,500000]. If the rent is the same every year, leave yearlyRents null.
- contractYears is an integer 1-5 (the lease duration in years).
- numCheques is how many rent cheques PER YEAR (e.g. "4 cheques" -> 4).
- Dates are written day/month/year (UAE style). Output tenancyFrom and tenancyTo as ISO strings "YYYY-MM-DD". If only a start date and a duration are given, leave tenancyTo null.
- terms is an array of short condition strings if any special terms/clauses are mentioned, else null.
- Return ONLY the JSON object, no commentary.`;

// Coerce "AED 120,000" / "120k" / "1.2m" / "120000" -> 120000 (number) or null.
function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().toLowerCase().replace(/aed|dhs?|,|\s/g, '');
  if (!s) return null;
  let mult = 1;
  if (/[km]$/.test(s)) { mult = s.endsWith('m') ? 1e6 : 1e3; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return isFinite(n) ? Math.round(n * mult) : null;
}

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
// Normalise a date to ISO YYYY-MM-DD. Ambiguous numeric dates are read as
// day/month/year (UAE convention).
function toIso(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)))            // already ISO
    return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  if ((m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/))) { // D/M/Y
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    if (+mo > 12 && +d <= 12) { const t = d; d = mo; mo = t; }      // looks like M/D/Y
    return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  if ((m = s.match(/^(\d{1,2})\s+([a-z]{3,})\.?,?\s+(\d{4})$/i))) { // 1 Jan 2026
    const mo = MONTHS[m[2].slice(0,3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  }
  if ((m = s.match(/^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/i))) { // Jan 1, 2026
    const mo = MONTHS[m[1].slice(0,3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  }
  return null;
}

const ALLOWED_CHEQUES = [1, 2, 3, 4, 6, 12];
const PROP_TYPES = ['Warehouse','Office','Residential','Land','Retail','Shop'];
const USAGES     = ['Commercial','Residential','Industrial'];
function pickEnum(v, list) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  return list.find(o => o.toLowerCase() === s) || list.find(o => o.toLowerCase().includes(s) || s.includes(o.toLowerCase())) || null;
}

// Clean the raw model object into the shape/types the frontend expects.
function sanitizeParsed(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const str = v => (v == null || v === '') ? null : String(v).trim();
  const out = {};
  out.propName      = str(o.propName);
  out.propType      = pickEnum(o.propType, PROP_TYPES);
  out.propLocation  = str(o.propLocation);
  out.propSize      = toNum(o.propSize);
  out.plotNo        = str(o.plotNo);
  out.makaniNo      = str(o.makaniNo);
  out.propertyNo    = str(o.propertyNo);
  out.dewaNo        = str(o.dewaNo);
  out.usage         = pickEnum(o.usage, USAGES);
  out.lessorName    = str(o.lessorName);
  out.lessorEid     = str(o.lessorEid);
  out.lessorPhone   = str(o.lessorPhone);
  out.lessorEmail   = str(o.lessorEmail);
  out.lessorLicense = str(o.lessorLicense);
  out.lessorAuthority = str(o.lessorAuthority);
  out.clientName    = str(o.clientName);
  out.clientCompany = str(o.clientCompany);
  out.clientPhone   = str(o.clientPhone);
  out.clientEmail   = str(o.clientEmail);
  out.clientEid     = str(o.clientEid);
  out.clientLicense = str(o.clientLicense);
  out.clientAuthority = str(o.clientAuthority);
  out.annualRent    = toNum(o.annualRent);

  let years = parseInt(o.contractYears, 10);
  out.contractYears = (years >= 1 && years <= 5) ? years : null;

  out.yearlyRents = Array.isArray(o.yearlyRents)
    ? o.yearlyRents.map(toNum).filter(n => n != null)
    : null;
  if (out.yearlyRents && !out.yearlyRents.length) out.yearlyRents = null;
  // If yearlyRents present but contractYears missing, infer it.
  if (!out.contractYears && out.yearlyRents && out.yearlyRents.length > 1)
    out.contractYears = Math.min(5, out.yearlyRents.length);
  if (!out.annualRent && out.yearlyRents) out.annualRent = out.yearlyRents[0];

  out.tenancyFrom = toIso(o.tenancyFrom);
  out.tenancyTo   = toIso(o.tenancyTo);

  let nc = parseInt(o.numCheques, 10);
  if (nc >= 1) {
    out.numCheques = ALLOWED_CHEQUES.includes(nc)
      ? nc
      : ALLOWED_CHEQUES.reduce((a, b) => Math.abs(b - nc) < Math.abs(a - nc) ? b : a);
  } else out.numCheques = null;

  out.securityDeposit = toNum(o.securityDeposit);
  out.serviceCharges  = toNum(o.serviceCharges);
  out.commission      = toNum(o.commission);
  out.maintenance     = toNum(o.maintenance);
  out.adminFee        = toNum(o.adminFee);
  out.notes           = str(o.notes);
  out.terms = Array.isArray(o.terms)
    ? o.terms.map(str).filter(Boolean).slice(0, 10)
    : (str(o.terms) ? [str(o.terms)] : null);

  return out;
}

router.post('/parse', requireAuth, async (req, res) => {
  const text = (req.body && req.body.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'No text provided' });
  if (text.length > 8000) return res.status(400).json({ error: 'Text too long (max 8000 chars)' });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: `${PROMPT_INSTRUCTIONS}\n\n--- CONTRACT DESCRIPTION ---\n${text}\n\n--- JSON OUTPUT ---\n`,
        format: 'json',
        stream: false,
        keep_alive: '10m',
        options: { temperature: 0, num_ctx: 4096 },
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.warn('[proposals/parse] Ollama HTTP', r.status, body.slice(0, 300));
      return res.status(502).json({ error: 'AI service error', detail: `Ollama HTTP ${r.status}` });
    }
    const data = await r.json();
    let parsed;
    try { parsed = JSON.parse(data.response || '{}'); }
    catch (e) {
      console.warn('[proposals/parse] non-JSON model output:', (data.response || '').slice(0, 300));
      return res.status(502).json({ error: 'AI returned malformed output' });
    }
    return res.json({ fields: sanitizeParsed(parsed), model: OLLAMA_MODEL });
  } catch (err) {
    const aborted = err.name === 'AbortError';
    console.warn('[proposals/parse]', aborted ? 'timeout' : err.message);
    return res.status(aborted ? 504 : 502).json({
      error: aborted ? 'AI request timed out' : 'AI service unavailable',
      detail: aborted ? null : err.message,
    });
  } finally {
    clearTimeout(timer);
  }
});

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
// Exposed for unit testing of the AI-parse normalisation.
module.exports._sanitizeParsed = sanitizeParsed;
module.exports._toNum = toNum;
module.exports._toIso = toIso;
