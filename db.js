// src/db.js — SQLite database (ฟรี ไม่ต้องติดตั้งเพิ่ม)
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'slip_bot.db');

// สร้างโฟลเดอร์ data ถ้ายังไม่มี
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// เปิด WAL mode เพื่อประสิทธิภาพที่ดีขึ้น
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// สร้างตารางทั้งหมด
db.exec(`
  -- รายการเดินบัญชี (นำเข้าจาก CSV/Excel)
  CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT NOT NULL,          -- YYYY-MM-DD
    description  TEXT NOT NULL,          -- รายการ
    amount       REAL NOT NULL,          -- จำนวนเงิน
    type         TEXT DEFAULT 'credit',  -- credit/debit
    ref_code     TEXT,                   -- เลขอ้างอิงธนาคาร
    matched      INTEGER DEFAULT 0,      -- 0=ยังไม่จับคู่, 1=จับคู่แล้ว
    matched_at   TEXT,                   -- เวลาที่จับคู่
    slip_id      INTEGER,                -- FK → slips.id
    batch_id     TEXT,                   -- รหัส batch ที่นำเข้า
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (slip_id) REFERENCES slips(id)
  );

  -- รูปสลิปที่รับจาก LINE
  CREATE TABLE IF NOT EXISTS slips (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL,
    message_id   TEXT NOT NULL UNIQUE,   -- LINE message ID
    raw_text     TEXT,                   -- ข้อความดิบจาก OCR
    amount       REAL,                   -- ยอดเงินในสลิป
    slip_date    TEXT,                   -- วันที่ในสลิป
    slip_time    TEXT,                   -- เวลาในสลิป
    sender_name  TEXT,                   -- ชื่อผู้โอน
    receiver_name TEXT,                  -- ชื่อผู้รับ
    slip_ref     TEXT,                   -- เลขอ้างอิงในสลิป
    bank_name    TEXT,                   -- ชื่อธนาคาร
    status       TEXT DEFAULT 'pending', -- pending/matched/unmatched
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- log การนำเข้าข้อมูล
  CREATE TABLE IF NOT EXISTS import_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id   TEXT NOT NULL,
    filename   TEXT,
    row_count  INTEGER,
    imported   INTEGER,
    skipped    INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- INDEX เพื่อเร่งการค้นหา
  CREATE INDEX IF NOT EXISTS idx_tx_amount   ON transactions(amount);
  CREATE INDEX IF NOT EXISTS idx_tx_date     ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_matched  ON transactions(matched);
  CREATE INDEX IF NOT EXISTS idx_slip_user   ON slips(line_user_id);
  CREATE INDEX IF NOT EXISTS idx_slip_status ON slips(status);
`);

// ฟังก์ชันช่วยเหลือ
const queries = {
  // Transaction queries
  findUnmatchedByAmount: db.prepare(`
    SELECT * FROM transactions
    WHERE matched = 0
      AND ABS(amount - ?) <= ?
    ORDER BY ABS(amount - ?) ASC, date DESC
    LIMIT 10
  `),

  findUnmatchedByAmountAndDate: db.prepare(`
    SELECT * FROM transactions
    WHERE matched = 0
      AND ABS(amount - ?) <= ?
      AND ABS(JULIANDAY(date) - JULIANDAY(?)) <= ?
    ORDER BY ABS(amount - ?) ASC, ABS(JULIANDAY(date) - JULIANDAY(?)) ASC
    LIMIT 5
  `),

  markAsMatched: db.prepare(`
    UPDATE transactions
    SET matched = 1, matched_at = CURRENT_TIMESTAMP, slip_id = ?
    WHERE id = ?
  `),

  insertTransaction: db.prepare(`
    INSERT OR IGNORE INTO transactions (date, description, amount, type, ref_code, batch_id)
    VALUES (@date, @description, @amount, @type, @ref_code, @batch_id)
  `),

  // Slip queries
  insertSlip: db.prepare(`
    INSERT INTO slips (line_user_id, message_id, raw_text, amount, slip_date, slip_time,
                       sender_name, receiver_name, slip_ref, bank_name, status)
    VALUES (@line_user_id, @message_id, @raw_text, @amount, @slip_date, @slip_time,
            @sender_name, @receiver_name, @slip_ref, @bank_name, @status)
  `),

  updateSlipStatus: db.prepare(`
    UPDATE slips SET status = ? WHERE id = ?
  `),

  // Stats
  getStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN matched = 1 THEN 1 ELSE 0 END) as matched_count,
      SUM(CASE WHEN matched = 0 THEN 1 ELSE 0 END) as unmatched_count,
      SUM(CASE WHEN matched = 1 THEN amount ELSE 0 END) as matched_amount,
      SUM(CASE WHEN matched = 0 THEN amount ELSE 0 END) as unmatched_amount
    FROM transactions
  `),

  getTodayStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN matched = 1 THEN 1 ELSE 0 END) as matched_count,
      SUM(CASE WHEN matched = 1 THEN amount ELSE 0 END) as matched_amount
    FROM transactions
    WHERE date = date('now', 'localtime')
  `),

  getRecentSlips: db.prepare(`
    SELECT s.*, t.description as tx_description
    FROM slips s
    LEFT JOIN transactions t ON t.slip_id = s.id
    ORDER BY s.created_at DESC
    LIMIT 20
  `),

  getUnmatchedTransactions: db.prepare(`
    SELECT * FROM transactions
    WHERE matched = 0
    ORDER BY date DESC, amount DESC
    LIMIT 50
  `),

  importMany: db.transaction((rows) => {
    const stmt = queries.insertTransaction;
    let imported = 0;
    for (const row of rows) {
      const result = stmt.run(row);
      if (result.changes > 0) imported++;
    }
    return imported;
  }),
};

module.exports = { db, queries };
