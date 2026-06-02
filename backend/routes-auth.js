/**
 * Auth routes.
 *
 *   POST /api/auth/login            — { username, password } -> sets cookie, returns { user }
 *   POST /api/auth/logout           — destroys session, clears cookie
 *   GET  /api/auth/me               — returns { user } if logged in, 401 otherwise
 *   GET  /api/auth/config           — { googleEnabled } so the UI can show/hide the button
 *   GET  /api/auth/google           — redirect to Google's consent screen
 *   GET  /api/auth/google/callback  — Google redirects back here; matches email -> session
 *
 * Google login (when enabled) does NOT replace password login — both work.
 * Access is gated by the users table: only a verified Google email that
 * matches an active user's `email` is allowed in.
 */

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./db');
const {
  verifyPassword,
  createSession,
  destroySession,
  sanitizeUser,
  SESSION_TTL_MS
} = require('./auth');
const { requireAuth, COOKIE_NAME } = require('./middleware');
const googleOAuth = require('./google-oauth');

const router = express.Router();

// Short-lived cookie holding the OAuth `state` value for CSRF protection.
const OAUTH_STATE_COOKIE = 'g_oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

// ─── GET /api/auth/config ─────────────────────────
// Public — lets the login screen decide whether to render the Google button.
router.get('/config', (req, res) => {
  res.json({ googleEnabled: googleOAuth.isEnabled() });
});

// ─── GET /api/auth/google ─────────────────────────
// Kick off the OAuth flow: set a CSRF state cookie, then redirect to Google.
router.get('/google', (req, res) => {
  if (!googleOAuth.isEnabled()) {
    return res.status(404).json({ error: 'Google login is not configured' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: OAUTH_STATE_TTL_MS,
    path: '/'
  });
  const url = googleOAuth.buildAuthUrl({ state, redirectUri: googleOAuth.getRedirectUri(req) });
  return res.redirect(url);
});

// ─── GET /api/auth/google/callback ────────────────
// Google redirects back here with ?code & ?state. We verify state, swap the
// code for the verified email, match it to an active user, and start a session.
// On any failure we bounce back to the login screen with ?auth_error=<reason>.
router.get('/google/callback', async (req, res) => {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || null;
  const fail = (reason, logReason, username) => {
    recordLogin({ username: username || null, ip, ua, success: false, reason: logReason });
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
    return res.redirect('/?auth_error=' + encodeURIComponent(reason));
  };

  if (!googleOAuth.isEnabled()) return fail('google_disabled', 'google-disabled');

  // The user denied consent, or Google returned an error.
  if (req.query.error) return fail('cancelled', 'google-' + String(req.query.error).slice(0, 40));

  const { code, state } = req.query;
  const cookieState = req.cookies && req.cookies[OAUTH_STATE_COOKIE];
  if (!code || !state || !cookieState || state !== cookieState) {
    return fail('bad_state', 'google-bad-state');
  }

  let profile;
  try {
    profile = await googleOAuth.exchangeCodeForProfile({
      code: String(code),
      redirectUri: googleOAuth.getRedirectUri(req),
    });
  } catch (e) {
    console.warn('[auth] google code exchange failed:', e.message);
    return fail('exchange_failed', 'google-exchange-failed');
  }

  if (!profile.email || !profile.emailVerified) {
    return fail('unverified_email', 'google-unverified', profile.email);
  }

  // Match the verified email to an active user (case-insensitive).
  const user = getDb().prepare(
    'SELECT * FROM users WHERE lower(email) = ? AND active = 1'
  ).get(profile.email);

  if (!user) {
    // Email isn't on anyone's account — not authorized.
    return fail('not_authorized', 'google-no-match', profile.email);
  }

  recordLogin({ userId: user.id, username: user.username, ip, ua, success: true, reason: 'google' });
  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
  const { token } = createSession(user.id);
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
  return res.redirect('/');
});

module.exports = router;
