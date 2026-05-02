/**
 * Auth routes.
 *
 *   POST /api/auth/login   — { username, password } -> sets cookie, returns { user }
 *   POST /api/auth/logout  — destroys session, clears cookie
 *   GET  /api/auth/me      — returns { user } if logged in, 401 otherwise
 */

const express = require('express');
const { getDb } = require('./db');
const {
  verifyPassword,
  createSession,
  destroySession,
  sanitizeUser,
  SESSION_TTL_MS
} = require('./auth');
const { requireAuth, COOKIE_NAME } = require('./middleware');

const router = express.Router();

// Cookie options. `secure` is set automatically when running behind HTTPS
// (we detect it via the X-Forwarded-Proto header set by nginx).
function cookieOptions(req) {
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: SESSION_TTL_MS,
    path: '/'
  };
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

function recordLogin({ userId, username, ip, ua, success, reason }) {
  try {
    getDb().prepare(`
      INSERT INTO login_audit (user_id, username, ip, user_agent, success, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId || null, username || null, ip || null, ua || null, success ? 1 : 0, reason || null);
  } catch (e) {
    console.warn('[auth] login_audit insert failed:', e.message);
  }
}

// ─── POST /api/auth/login ─────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || null;

  if (!username || !password) {
    recordLogin({ username, ip, ua, success: false, reason: 'missing-credentials' });
    return res.status(400).json({ error: 'Username and password required' });
  }

  const trimmedUsername = String(username).trim();
  const user = getDb().prepare(
    'SELECT * FROM users WHERE username = ? AND active = 1'
  ).get(trimmedUsername);

  // Generic error message — don't leak which half was wrong
  if (!user) {
    recordLogin({ username: trimmedUsername, ip, ua, success: false, reason: 'no-such-user' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    recordLogin({ userId: user.id, username: trimmedUsername, ip, ua, success: false, reason: 'wrong-password' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  recordLogin({ userId: user.id, username: trimmedUsername, ip, ua, success: true, reason: null });
  const { token } = createSession(user.id);
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
  return res.json({ user: sanitizeUser(user) });
});

// ─── POST /api/auth/logout ────────────────────────
router.post('/logout', (req, res) => {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) destroySession(token);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// ─── GET /api/auth/me ─────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
