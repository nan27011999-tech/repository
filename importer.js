// src/importer.js — นำเข้า CSV/Excel ข้อมูลเดินบัญชี
const XLSX = require('xlsx');
const { queries, db } = require('./db');
const crypto = require('crypto');

/**
 * คอลัมน์ที่รองรับ (หลายชื่อ เพราะธนาคารแต่ละแห่งใช้ชื่อต่างกัน)
 */
const COLUMN_ALIASES = {
  date: [
    'วันที่', 'date', 'transaction date', 'txn date', 'posting date',
    'วันที่ทำรายการ', 'วันที่โอน', 'เวลา/วันที่'
  ],
  description: [
    'รายการ', 'description', 'detail', 'รายละเอียด', 'รายการ/คำอธิบาย',
    'transaction description', 'narration', 'หมายเหตุ', 'memo'
  ],
  amount: [
    'จำนวนเงิน', 'amount', 'credit', 'debit', 'ฝาก', 'ถอน',
    'จำนวน(บาท)', 'credit amount', 'เครดิต', 'credit (thb)'
  ],
  type: [
    'ประเภท', 'type', 'transaction type', 'dr/cr'
  ],
  ref_code: [
    'เลขที่อ้างอิง', 'ref', 'reference', 'ref no', 'reference no',
    'เลขที่รายการ', 'transaction id', 'txn id'
  ],
};

/**
 * หาชื่อคอลัมน์ที่ตรงกัน (case-insensitive)
 */
function findColumn(headers, aliases) {
  const headerMap = {};
  headers.forEach(h => { headerMap[h.toLowerCase().trim()] = h; });

  for (const alias of aliases) {
    const found = headerMap[alias.toLowerCase().trim()];
    if (found) return found;
  }
  return null;
}

/**
 * แปลงวันที่จากรูปแบบต่างๆ เป็น YYYY-MM-DD
 */
function normalizeDate(val) {
  if (!val) return null;

  // Excel date serial number
  if (typeof val === 'number') {
    const date = XLSX.SSF.parse_date_code(val);
    if (date) {
      return `${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
    }
  }

  const str = String(val).trim();

  // DD/MM/YYYY
  let m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const year = parseInt(m[3]) > 2500 ? parseInt(m[3]) - 543 : parseInt(m[3]);
    return `${year}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }

  // YYYY-MM-DD
  m = str.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
  if (m) {
    const year = parseInt(m[1]) > 2500 ? parseInt(m[1]) - 543 : parseInt(m[1]);
    return `${year}-${m[2]}-${m[3]}`;
  }

  // DD MMM YYYY เช่น "25 Apr 2024"
  m = str.match(/^(\d{1,2})\s+([A-Za-zก-๙]+\.?)\s+(\d{4})$/);
  if (m) {
    const months = {
      jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
      jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
    };
    const month = months[m[2].toLowerCase().substring(0,3)];
    if (month) {
      const year = parseInt(m[3]) > 2500 ? parseInt(m[3]) - 543 : parseInt(m[3]);
      return `${year}-${month}-${m[1].padStart(2,'0')}`;
    }
  }

  return str; // คืนค่าดิบถ้าแปลงไม่ได้
}

/**
 * แปลงยอดเงิน
 */
function normalizeAmount(val) {
  if (!val && val !== 0) return 0;
  if (typeof val === 'number') return Math.abs(val);
  const cleaned = String(val).replace(/[,\s฿$]/g, '').replace(/\((.+)\)/, '-$1');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.abs(num);
}

/**
 * ประมวลผลไฟล์ CSV/Excel
 * @param {Buffer} buffer
 * @param {string} originalname
 * @returns {{ imported, skipped, errors, batchId }}
 */
function importFile(buffer, originalname) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  // ใช้ sheet แรก
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rows.length === 0) {
    throw new Error('ไฟล์ว่างเปล่า หรือไม่มีข้อมูลใน sheet แรก');
  }

  // ตรวจหา column mapping
  const headers = Object.keys(rows[0]);
  const colDate  = findColumn(headers, COLUMN_ALIASES.date);
  const colDesc  = findColumn(headers, COLUMN_ALIASES.description);
  const colAmt   = findColumn(headers, COLUMN_ALIASES.amount);
  const colType  = findColumn(headers, COLUMN_ALIASES.type);
  const colRef   = findColumn(headers, COLUMN_ALIASES.ref_code);

  if (!colAmt) {
    throw new Error(`ไม่พบคอลัมน์จำนวนเงิน คอลัมน์ที่มี: ${headers.join(', ')}`);
  }

  const batchId = crypto.randomBytes(4).toString('hex').toUpperCase();
  let imported = 0;
  let skipped  = 0;
  const errors = [];

  // นำเข้าทีละ batch ด้วย transaction
  const insertMany = db.transaction((data) => {
    for (const [i, row] of data.entries()) {
      try {
        const amount = normalizeAmount(row[colAmt]);
        if (!amount || amount <= 0) { skipped++; continue; }

        const result = queries.insertTransaction.run({
          date:        colDate ? normalizeDate(row[colDate]) : null,
          description: colDesc ? String(row[colDesc]).trim() : `รายการ ${i+1}`,
          amount,
          type:        colType ? String(row[colType]).trim() : 'credit',
          ref_code:    colRef  ? String(row[colRef]).trim()  : null,
          batch_id:    batchId,
        });

        if (result.changes > 0) imported++;
        else skipped++;
      } catch (err) {
        errors.push(`แถว ${i+2}: ${err.message}`);
        skipped++;
      }
    }
  });

  insertMany(rows);

  // บันทึก log
  db.prepare(`
    INSERT INTO import_logs (batch_id, filename, row_count, imported, skipped)
    VALUES (?, ?, ?, ?, ?)
  `).run(batchId, originalname, rows.length, imported, skipped);

  return { imported, skipped, errors: errors.slice(0, 10), batchId, total: rows.length };
}

module.exports = { importFile };
