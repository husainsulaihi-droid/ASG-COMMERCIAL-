/**
 * Field naming utilities.
 *
 * The API speaks camelCase (`annualRent`), the DB speaks snake_case (`annual_rent`).
 * These helpers translate both ways and filter incoming bodies to the allowed columns.
 */

function camelToSnake(s) {
  return String(s).replace(/[A-Z]/g, c => '_' + c.toLowerCase());
}

function snakeToCamel(s) {
  return String(s).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert a DB row (snake_case keys) into an API object (camelCase keys). */
function rowToApi(row) {
  if (!row) return null;
  const out = {};
  for (const k of Object.keys(row)) out[snakeToCamel(k)] = row[k];
  return out;
}

/**
 * Convert an incoming API body (camelCase) into a DB-shaped object (snake_case),
 * dropping any keys not in the allowed-fields list.
 */
function bodyToDb(body, allowedFields) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const k of Object.keys(body)) {
    const dbKey = camelToSnake(k);
    if (allowedFields.includes(dbKey)) out[dbKey] = body[k];
  }
  return out;
}

module.exports = { camelToSnake, snakeToCamel, rowToApi, bodyToDb };
