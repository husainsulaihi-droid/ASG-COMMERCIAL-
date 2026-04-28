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
const path = require('path');
const { initDb, getDb } = require('./db');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

// ─── Middleware ───────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(cookieParser());

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

// ─── Routes ───────────────────────────────────────────

// Health check — used to verify the backend is reachable.
// Hit it via: GET https://crm.asgproperties.ae/api/health
app.get('/api/health', (req, res) => {
  let dbReachable = false;
  try {
    const row = getDb().prepare('SELECT 1 AS ok').get();
    dbReachable = row?.ok === 1;
  } catch (err) {
    console.error('[health] DB check failed:', err.message);
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    db: dbReachable,
    version: '0.1.0'
  });
});

// Catch-all for unknown /api/* routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// ─── Boot ─────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`[server] ASG backend listening on http://${HOST}:${PORT}`);
  console.log(`[server] Health: http://${HOST}:${PORT}/api/health`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down...`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
