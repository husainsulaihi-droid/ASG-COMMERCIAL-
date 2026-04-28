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

// ─── POST /api/auth/login ─────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = getDb().prepare(
    'SELECT * FROM users WHERE username = ? AND active = 1'
  ).get(String(username).trim());

  // Generic error message — don't leak which half was wrong
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

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
