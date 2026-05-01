/**
 * Admin-only Excel export.
 *
 *   GET /api/export/xlsx   → streams an .xlsx workbook with two sheets:
 *                            "Properties" (one row per property, all columns)
 *                            "Cheques"    (one row per cheque, with property_name)
 *
 * Built on demand from the live DB so the file always reflects current state.
 */

const express = require('express');
const XLSX = require('xlsx');
const { getDb } = require('./db');
const { requireAdmin } = require('./middleware');

const router = express.Router();

router.get('/xlsx', requireAdmin, (req, res) => {
  const db = getDb();
  const properties = db.prepare('SELECT * FROM properties ORDER BY id').all();
  const cheques    = db.prepare(`
    SELECT c.*, p.name AS property_name, p.unit_no AS property_unit_no
      FROM property_cheques c
      LEFT JOIN properties p ON p.id = c.property_id
     ORDER BY c.property_id, c.cheque_num
  `).all();

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(properties), 'Properties');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cheques),    'Cheques');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `asg-export-${new Date().toISOString().slice(0,10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});

module.exports = router;
