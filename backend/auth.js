/**
 * Authentication helpers.
 *
 *  - hashPassword / verifyPassword — bcrypt with cost 12
 *  - createSession / getSession / destroySession — DB-backed session tokens
 *  - clearExpiredSessions — call periodically to GC expired rows
 *
 * Sessions live in the `sessions` table. Each token is 64 hex chars
 * (32 random bytes). Default lifetime is 30 days.
 *
 * Cookies are set/read by the auth routes — this module just speaks DB.
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getDb } = require('./db');

const BCRYPT_COST = 12;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Insert a new session row, return the token. */
function createSession(userId, ttlMs = SESSION_TTL_MS) {
  const token = generateToken();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  getDb().prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(token, userId, expires);
  return { token, expires };
}

/** Look up a session by token; returns the user record or null. */
function getSessionUser(token) {
  if (!token) return null;
  const row = getDb().prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.active = 1
  `).get(token);
  return row || null;
}

/** Delete a session row (logout). */
function destroySession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** GC expired sessions — run periodically. */
function clearExpiredSessions() {
  const result = getDb().prepare(
    "DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP"
  ).run();
  return result.changes;
}

/**
 * Strip sensitive fields before sending a user record to the client.
 * NEVER return password_hash to the frontend.
 */
function sanitizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    email: u.email,
    phone: u.phone,
    agentRole: u.agent_role,
    permissions: u.permissions ? safeParseJson(u.permissions) : null,
    availability: u.availability,
    isTeamLeader: !!u.is_team_leader,
    teamLeaderId: u.team_leader_id || null,
    active: !!u.active,
    createdAt: u.created_at,
    updatedAt: u.updated_at
  };
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  createSession,
  getSessionUser,
  destroySession,
  clearExpiredSessions,
  sanitizeUser,
  SESSION_TTL_MS
};
