/**
 * ASG Commercial CRM — Backend API
 *
 * Express server, listens on PORT (default 3000).
 * In production, nginx reverse-proxies /api/* to this server.
 *
 * Phase 1 (current): skeleton only — health endpoint to verify the server is alive.
 * Phase 2: real auth.
 * Phase 3+: data endpoints for each module.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const path = require('path');
const { initDb, getDb } = require('./db');
const { clearExpiredSessions } = require('./auth');
const authRoutes          = require('./routes-auth');
const userRoutes          = require('./routes-users');
const propertyRoutes      = require('./routes-properties');
const propertyFileRoutes  = require('./routes-property-files');
const leadRoutes          = require('./routes-leads');
const meetingRoutes       = require('./routes-meetings');
const announcementRoutes  = require('./routes-announcements');
const leaveRoutes         = require('./routes-leaves');
const proposalRoutes      = require('./routes-proposals');
const pendingRoutes       = require('./routes-pending');
const sheetsSync          = require('./sheets-sync');
const backupRoutes        = require('./routes-backup');
const exportRoutes        = require('./routes-export');
const auditRoutes         = require('./routes-audit');
const financialsRoutes    = require('./routes-financials');
const compoundRoutes      = require('./routes-compounds');
const disputeRoutes       = require('./routes-disputes');
const constructionRoutes  = require('./routes-construction');
const calendarRoutes      = require('./routes-calendar');
const sse                 = require('./sse');
const broadcastMiddleware = require('./broadcast-middleware');
const { requireAuth }     = require('./middleware');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

// ─── Middleware ───────────────────────────────────────
// gzip everything except the SSE stream (which must stay unbuffered).
app.use(compression({
  filter: (req, res) => {
    if (req.path === '/api/events') return false;
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(cookieParser());

// Force no-store on every /api/* response so browsers never serve a
// stale cached copy. (Static HTML/CSS/JS cache-busting is handled by
// the ?v= query string in index.html.)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Request logging (compact)
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - t}ms)`);
  });
  next();
});

// ─── Database ─────────────────────────────────────────
initDb();

// GC expired sessions every hour
setInterval(() => {
  try {
    const n = clearExpiredSessions();
    if (n > 0) console.log(`[sessions] Cleared ${n} expired session(s)`);
  } catch (err) {
    console.error('[sessions] GC failed:', err.message);
  }
}, 60 * 60 * 1000);

// ─── Real-time SSE ────────────────────────────────────
// Open one long-lived stream per browser. Mutations on any entity
// route are auto-broadcast by broadcastMiddleware (mounted below).
app.get('/api/events', requireAuth, (req, res) => sse.addClient(req, res));

// Auto-broadcast on every mutation (POST/PATCH/PUT/DELETE).
// Must be mounted BEFORE the entity route handlers so res.on('finish')
// fires after the handler completes.
app.use('/api', broadcastMiddleware);

// ─── Routes ───────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  let dbReachable = false;
  let userCount = 0;
  try {
    const row = getDb().prepare('SELECT 1 AS ok').get();
    dbReachable = row?.ok === 1;
    userCount = getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
  } catch (err) {
    console.error('[health] DB check failed:', err.message);
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    db: dbReachable,
    users: userCount,
    sseClients: sse.clientCount(),
    version: '0.5.0'
  });
});

app.use('/api/auth',                authRoutes);
app.use('/api/users',               userRoutes);
app.use('/api/properties',          propertyRoutes);
app.use('/api/properties/:id/files', propertyFileRoutes);
app.use('/api/leads',               leadRoutes);
app.use('/api/meetings',            meetingRoutes);
app.use('/api/announcements',       announcementRoutes);
app.use('/api/leaves',              leaveRoutes);
app.use('/api/proposals',           proposalRoutes);
app.use('/api/pending-properties',  pendingRoutes);
app.use('/api/backup',              backupRoutes);
app.use('/api/export',              exportRoutes);
app.use('/api/audit',               auditRoutes);
app.use('/api/financials',          financialsRoutes);
app.use('/api/compounds',           compoundRoutes);
app.use('/api/disputes',            disputeRoutes);
app.use('/api/construction',        constructionRoutes);
app.use('/api/calendar',            calendarRoutes);

// Catch-all for unknown /api/* routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// ─── Boot ─────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`[server] ASG backend listening on http://${HOST}:${PORT}`);
  console.log(`[server] Health: http://${HOST}:${PORT}/api/health`);
  // Start Google Sheets ↔ DB sync poller (no-op if creds not present or disabled)
  try { sheetsSync.startPoller(); }
  catch (e) { console.warn('[server] sheets-sync startup failed:', e.message); }
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down...`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
