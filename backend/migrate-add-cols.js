// Idempotent migration: ensures every column the backend code expects
// exists on the production DB. Re-running is safe.
const db = require('better-sqlite3')('/var/asg/data/asg.db');

// (table, column, type)
const cols = [
  // property_cheques
  ['property_cheques', 'late_fees',          'REAL'],
  ['property_cheques', 'cheque_no_text',     'TEXT'],

  // properties — every camelCase field the routes accept
  ['properties', 'unit_no',              'TEXT'],
  ['properties', 'trade_license',        'TEXT'],
  ['properties', 'usage',                'TEXT'],
  ['properties', 'map_link',             'TEXT'],
  ['properties', 'compound',             'TEXT'],
  ['properties', 'mezzanine',            'TEXT'],
  ['properties', 'premise_number',       'TEXT'],
  ['properties', 'dewa_number',          'TEXT'],
  ['properties', 'partner_name',         'TEXT'],
  ['properties', 'our_share',            'REAL'],
  ['properties', 'owner_name',           'TEXT'],
  ['properties', 'owner_phone',          'TEXT'],
  ['properties', 'owner_email',          'TEXT'],
  ['properties', 'partners',             'TEXT'],
  ['properties', 'mgmt_fee',             'REAL'],
  ['properties', 'mgmt_date',            'TEXT'],
  ['properties', 'mgmt_maintenance',     'REAL'],
  ['properties', 'mgmt_admin_fee',       'REAL'],
  ['properties', 'purchase_price',       'REAL'],
  ['properties', 'purchase_date',        'TEXT'],
  ['properties', 'market_value',         'REAL'],
  ['properties', 'land_charges',         'REAL'],
  ['properties', 'license_fees',         'REAL'],
  ['properties', 'sub_lease_fees',       'REAL'],
  ['properties', 'dewa_charges',         'REAL'],
  ['properties', 'ejari_fees',           'REAL'],
  ['properties', 'civil_defense_charges','REAL'],
  ['properties', 'legal_fee',            'REAL'],
  ['properties', 'corporate_tax',        'REAL'],
  ['properties', 'security_deposit',     'REAL'],
  ['properties', 'cash_amount',          'REAL'],
  ['properties', 'brokerage_amount',     'REAL'],
  ['properties', 'tenant_name',          'TEXT'],
  ['properties', 'tenant_phone',         'TEXT'],
  ['properties', 'tenant_email',         'TEXT'],
  ['properties', 'reminder_days',        'INTEGER'],
  ['properties', 'lease_start',          'TEXT'],
  ['properties', 'lease_end',            'TEXT'],
  ['properties', 'num_cheques',          'INTEGER'],
  ['properties', 'notes',                'TEXT'],
  ['properties', 'coords',               'TEXT'],
  ['properties', 'holding_company',      'TEXT'],
  ['properties', 'plot_no',              'TEXT'],
  ['properties', 'ejari_number',         'TEXT'],
  ['properties', 'deposit',              'REAL'],
  ['properties', 'service_charges',      'REAL'],
  ['properties', 'maintenance_fees',     'REAL'],
  ['properties', 'vat',                  'REAL'],
  ['properties', 'annual_rent',          'REAL'],
  ['properties', 'management_fees',      'REAL'],

  // tasks
  ['tasks',           'created_by_id',   'INTEGER'],
  ['tasks',           'created_by_name', 'TEXT'],
];

let added = 0, skipped = 0;
for (const [table, col, type] of cols) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    console.log('OK:  ', table, col);
    added++;
  } catch (e) {
    if (/duplicate column/.test(e.message)) skipped++;
    else console.log('FAIL:', table, col, '-', e.message);
  }
}
console.log(`---\nadded=${added} skipped(already-present)=${skipped}`);
console.log('properties columns:', db.prepare('PRAGMA table_info(properties)').all().map(c => c.name).length, 'total');
