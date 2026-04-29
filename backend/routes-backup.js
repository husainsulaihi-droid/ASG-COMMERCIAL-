/**
 * Admin-only data backup endpoint.
 *
 *   GET /api/backup/all   → streams a .tar.gz containing /var/asg/uploads
 *                          and /var/asg/data (the SQLite DB).
 *
 * Implementation: spawns `tar czf -` and pipes its stdout straight to the
 * HTTP response. No buffering, so even multi-GB backups stream cleanly.
 */

const express = require('express');
const { spawn } = require('child_process');
const { requireAdmin } = require('./middleware');

const router = express.Router();

router.get('/all', requireAdmin, (req, res) => {
  const filename = `asg-backup-${new Date().toISOString().slice(0,10)}.tar.gz`;
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const tar = spawn('tar', [
    'czf', '-',
    '-C', '/var/asg',
    'uploads',
    'data',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  tar.stdout.pipe(res);

  tar.stderr.on('data', d => console.warn('[backup] tar stderr:', d.toString().trim()));
  tar.on('error', err => {
    console.error('[backup] tar spawn failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'backup failed' });
  });
  tar.on('close', code => {
    if (code !== 0) console.warn(`[backup] tar exited ${code}`);
  });

  // If the client disconnects, kill tar
  req.on('close', () => { try { tar.kill('SIGTERM'); } catch {} });
});

module.exports = router;
