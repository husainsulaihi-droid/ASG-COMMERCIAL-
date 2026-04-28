/**
 * Auth + role middleware.
 *
 *   requireAuth         — any logged-in user (admin, agent, team leader)
 *   requireAdmin        — admin only
 *   requireAdminOrSelf  — admin OR the user whose ID is in :id
 *
 * All middleware attach `req.user` (sanitized) when auth succeeds.
 *
 * Auth flow: every protected request must carry the `asg_session` cookie
 * (set by POST /api/auth/login).
 */

const { getSessionUser, sanitizeUser } = require('./auth');

const COOKIE_NAME = 'asg_session';

function readToken(req) {
  // Primary: HttpOnly cookie. Fallback: Authorization: Bearer <token>.
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

function requireAuth(req, res, next) {
  const token = readToken(req);
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = sanitizeUser(user);
  req.userRaw = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

function requireAdminOrSelf(req, res, next) {
  requireAuth(req, res, () => {
    const targetId = parseInt(req.params.id, 10);
    if (req.user.role === 'admin' || req.user.id === targetId) return next();
    return res.status(403).json({ error: 'Forbidden' });
  });
}

module.exports = { requireAuth, requireAdmin, requireAdminOrSelf, COOKIE_NAME };
