/**
 * Google Drive uploader for property files.
 *
 * Layout in Drive:
 *   <ROOT_FOLDER>/                   <- shared with service account by user
 *     <holding> — <unit>/             <- per-property, lazy-created on first upload
 *       ijari/  tenancy/  affection/  drec/  photos/
 *         <files>
 *
 * Each property's folder ID is cached on the properties row in
 * `drive_folder_id` so we don't search Drive every upload.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');

let google = null;
try { google = require('googleapis').google; } catch (e) {}

const ROOT_FOLDER_ID = process.env.ASG_DRIVE_ROOT || '1xFnOXiUkeGIoO5FVYwaChD52AwEjp5Zy';
const CREDS_PATH     = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/var/asg/sa-creds.json';
const DISABLED       = process.env.ASG_DRIVE_DISABLED === '1';

let _drive = null;
function driveClient() {
  if (DISABLED || !google) return null;
  if (_drive) return _drive;
  if (!fs.existsSync(CREDS_PATH)) return null;
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

function isEnabled() { return !!driveClient(); }

// ─── Find or create a folder by name under a parent ───────────────
async function findOrCreateFolder(name, parentId) {
  const drive = driveClient();
  if (!drive) throw new Error('drive not configured');
  // Search first
  const escaped = name.replace(/'/g, "\\'");
  const q = `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const found = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 1,
  });
  if (found.data.files && found.data.files.length) return found.data.files[0].id;

  // Create
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return created.data.id;
}

// ─── Get or create the per-property folder ────────────────────────
async function getOrCreatePropertyFolder(propertyId) {
  const db = getDb();
  const prop = db.prepare('SELECT id, holding_company, unit_no, name, drive_folder_id FROM properties WHERE id = ?').get(propertyId);
  if (!prop) throw new Error(`property ${propertyId} not found`);

  if (prop.drive_folder_id) {
    // Verify the folder still exists; if not, fall through and create
    try {
      const drive = driveClient();
      const r = await drive.files.get({ fileId: prop.drive_folder_id, fields: 'id,trashed' });
      if (r.data.id && !r.data.trashed) return prop.drive_folder_id;
    } catch (e) {
      console.warn(`[drive-uploader] cached folder for property ${propertyId} unreachable; recreating`);
    }
  }

  const folderName = prop.name || `Property ${propertyId}`;
  const folderId = await findOrCreateFolder(folderName, ROOT_FOLDER_ID);
  db.prepare('UPDATE properties SET drive_folder_id = ? WHERE id = ?').run(folderId, propertyId);
  return folderId;
}

// ─── Upload a local file to a given Drive folder ──────────────────
async function uploadFileToDrive(localPath, filename, mime, parentFolderId) {
  const drive = driveClient();
  if (!drive) throw new Error('drive not configured');
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [parentFolderId],
    },
    media: {
      mimeType: mime,
      body: fs.createReadStream(localPath),
    },
    fields: 'id,name,webViewLink,webContentLink,size,mimeType',
  });
  return res.data;
}

// ─── Delete a Drive file ──────────────────────────────────────────
async function deleteDriveFile(driveId) {
  const drive = driveClient();
  if (!drive) return;
  try {
    await drive.files.delete({ fileId: driveId });
  } catch (e) {
    if (e.code !== 404) throw e;
  }
}

// ─── Main: upload a file for a property ───────────────────────────
async function uploadPropertyFile({ propertyId, category, localPath, filename, mime }) {
  const folderId = await getOrCreatePropertyFolder(propertyId);
  // Optional sub-categorization: create a subfolder per category
  const subFolderName = category || 'other';
  const subFolderId = await findOrCreateFolder(subFolderName, folderId);
  const meta = await uploadFileToDrive(localPath, filename, mime, subFolderId);
  return {
    drive_id: meta.id,
    drive_url: meta.webViewLink || `https://drive.google.com/file/d/${meta.id}/view`,
  };
}

module.exports = {
  isEnabled,
  uploadPropertyFile,
  deleteDriveFile,
  getOrCreatePropertyFolder,
};
