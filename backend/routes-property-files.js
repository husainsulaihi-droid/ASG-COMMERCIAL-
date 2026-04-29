/**
 * Property file uploads — local storage + Google Drive mirror.
 *
 *   POST    /api/properties/:id/files            multipart/form-data
 *           body fields: category (ijari|tenancy|affection|drec|photo|other)
 *           file field:  file
 *
 *   GET     /api/properties/:id/files            list
 *
 *   DELETE  /api/properties/:id/files/:fileId    delete (disk + Drive + DB)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { getDb } = require('./db');
const { requireAuth, requireAdmin } = require('./middleware');
const { rowToApi } = require('./utils');
const driveUploader = require('./drive-uploader');
const folderExport = require('./property-folder-export');

const UPLOAD_ROOT = process.env.ASG_UPLOAD_ROOT || '/var/asg/uploads';
const ALLOWED_CATS = new Set(['ijari', 'tenancy', 'affection', 'drec', 'photo', 'other']);
const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

// ─── Multer setup: drop the file into <property folder>/<category>/ ──
// Note: req.body fields parsed before file upload only when the form is
// submitted with category appended BEFORE file (frontend follows this).
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const propId = parseInt(req.params.id, 10);
      const property = getDb().prepare('SELECT * FROM properties WHERE id = ?').get(propId);
      if (!property) return cb(new Error('property not found'));
      const propDir = folderExport.ensurePropertyFolder(property);
      const category = (req.body.category || 'other').toLowerCase();
      const catDir = path.join(propDir, ALLOWED_CATS.has(category) ? category : 'other');
      fs.mkdirSync(catDir, { recursive: true });
      cb(null, catDir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    // Prefix with a uuid so two files with the same name don't collide
    const uid = crypto.randomBytes(6).toString('hex');
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    cb(null, `${uid}-${safeName}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_SIZE } });

const router = express.Router({ mergeParams: true });

// ─── List files for a property ────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const propId = parseInt(req.params.id, 10);
  const rows = getDb().prepare(
    'SELECT * FROM property_files WHERE property_id = ? ORDER BY uploaded_at DESC'
  ).all(propId);
  res.json({ files: rows.map(rowToApi) });
});

// ─── Download a file (streams from disk) ──────────────────────────
router.get('/:fileId/download', requireAuth, (req, res) => {
  const propId = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  const row = getDb().prepare(
    'SELECT * FROM property_files WHERE id = ? AND property_id = ?'
  ).get(fileId, propId);
  if (!row || !row.local_path) return res.status(404).json({ error: 'file not found' });

  let actualPath = row.local_path;
  // Fallback: if stored path is stale (e.g. property folder was renamed
  // before this column was kept in sync), look up the current folder name
  // and rebuild the path. Then persist for next time.
  if (!fs.existsSync(actualPath)) {
    const prop = getDb().prepare('SELECT folder_name FROM properties WHERE id = ?').get(propId);
    if (prop && prop.folder_name) {
      // Strip everything before the property folder, then prepend new folder
      const tail = row.local_path.split('/uploads/').pop().split('/').slice(1).join('/');
      const candidate = `${UPLOAD_ROOT}/${prop.folder_name}/${tail}`;
      if (fs.existsSync(candidate)) {
        actualPath = candidate;
        getDb().prepare('UPDATE property_files SET local_path = ? WHERE id = ?').run(candidate, fileId);
      }
    }
  }

  if (!fs.existsSync(actualPath)) return res.status(404).json({ error: 'file missing on disk' });
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(row.filename || 'file').replace(/"/g, '')}"`);
  fs.createReadStream(actualPath).pipe(res);
});

// ─── Upload a file ────────────────────────────────────────────────
router.post('/', requireAdmin, upload.single('file'), async (req, res) => {
  const propId = parseInt(req.params.id, 10);
  const file = req.file;
  const category = (req.body.category || 'other').toLowerCase();

  if (!file) return res.status(400).json({ error: 'file is required' });
  if (!ALLOWED_CATS.has(category)) {
    fs.unlink(file.path, () => {});
    return res.status(400).json({ error: 'invalid category' });
  }
  // Verify property exists
  const prop = getDb().prepare('SELECT id FROM properties WHERE id = ?').get(propId);
  if (!prop) {
    fs.unlink(file.path, () => {});
    return res.status(404).json({ error: 'property not found' });
  }

  // Upload to Drive (best-effort — failure doesn't block the local save)
  let driveMeta = { drive_id: null, drive_url: null };
  if (driveUploader.isEnabled()) {
    try {
      driveMeta = await driveUploader.uploadPropertyFile({
        propertyId: propId,
        category,
        localPath: file.path,
        filename: file.originalname,
        mime: file.mimetype,
      });
    } catch (e) {
      console.warn(`[property-files] Drive upload failed for property ${propId}:`, e.message);
    }
  }

  const result = getDb().prepare(`
    INSERT INTO property_files (
      property_id, category, filename, local_path,
      drive_id, drive_url, mime, size, uploaded_by_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    propId, category, file.originalname, file.path,
    driveMeta.drive_id, driveMeta.drive_url, file.mimetype, file.size,
    req.user.id
  );
  const row = getDb().prepare('SELECT * FROM property_files WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ file: rowToApi(row) });
});

// ─── Delete a file ────────────────────────────────────────────────
router.delete('/:fileId', requireAdmin, async (req, res) => {
  const propId = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  const row = getDb().prepare('SELECT * FROM property_files WHERE id = ? AND property_id = ?').get(fileId, propId);
  if (!row) return res.status(404).json({ error: 'file not found' });

  // Best-effort cleanup of disk + Drive
  if (row.local_path) fs.unlink(row.local_path, () => {});
  if (row.drive_id && driveUploader.isEnabled()) {
    try { await driveUploader.deleteDriveFile(row.drive_id); }
    catch (e) { console.warn('[property-files] Drive delete failed:', e.message); }
  }
  getDb().prepare('DELETE FROM property_files WHERE id = ?').run(fileId);
  res.json({ ok: true });
});

module.exports = router;
