// src/parser.js — แยกข้อมูลจาก OCR text
// รองรับสลิปจากธนาคารไทยหลัก: SCB, KBANK, KTB, BBL, BAY, TTB, GSB, BAAC

/**
 * Pattern สำหรับแต่ละธนาคาร
 * เพราะ format สลิปต่างกันมาก
 */
const BANK_PATTERNS = {
  SCB: {
    name: 'ไทยพาณิชย์',
    detect: /SCB|ไทยพาณิชย์|scb easy/i,
    amount: [
      /(?:จำนวนเงิน|ยอดเงิน|amount)[^\d]*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
      /(\d{1,3}(?:,\d{3})*\.\d{2})\s*(?:บาท|THB)/i,
    ],
    ref: /(?:เลขที่รายการ|ref\.?no\.?|transaction)[^\w]*([A-Z0-9]{10,20})/i,
  },
  KBANK: {
    name: 'กสิกรไทย',
    detect: /KBANK|กสิกร|K PLUS/i,
    amount: [
      /(?:จำนวน|amount)[^\d]*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
      /(\d{1,3}(?:,\d{3})*\.\d{2})\s*บาท/i,
    ],
    ref: /(?:หมายเลขอ้างอิง|ref)[^\w]*(\d{15,20})/i,
  },
  KTB: {
    name: 'กรุงไทย',
    detect: /KTB|กรุงไทย|Krungthai/i,
    amount: [
      /(?:จำนวนเงิน)[^\d]*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
      /(\d{1,3}(?:,\d{3})*\.\d{2})\s*(?:บาท|THB)/i,
    ],
    ref: /(?:เลขที่อ้างอิง|ref)[^\w]*([A-Z0-9]{10,20})/i,
  },
  BBL: {
    name: 'กรุงเทพ',
    detect: /BBL|กรุงเทพ|Bangkok Bank/i,
    amount: [
      /(?:จำนวนเงิน|amount)[^\d]*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
    ],
    ref: /(?:reference|อ้างอิง)[^\w]*([A-Z0-9]{10,20})/i,
  },
  BAY: {
    name: 'กรุงศรี',
    detect: /BAY|กรุงศรี|Krungsri/i,
    amount: [
      /(\d{1,3}(?:,\d{3})*\.\d{2})\s*(?:บาท|THB)/i,
    ],
    ref: /(?:ref|อ้างอิง)[^\w]*([A-Z0-9]{10,20})/i,
  },
  PROMPTPAY: {
    name: 'พร้อมเพย์',
    detect: /พร้อมเพย์|PromptPay|prompt pay/i,
    amount: [
      /(?:จำนวนเงิน|ยอดโอน|amount)[^\d]*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
      /(\d{1,3}(?:,\d{3})*\.\d{2})\s*บาท/i,
    ],
    ref: /(?:ref|เลขที่)[^\w]*([A-Z0-9]{10,20})/i,
  },
};

// Pattern ทั่วไป (fallback)
const GENERIC_PATTERNS = {
  amount: [
    /(?:จำนวนเงิน|ยอดเงิน|ยอดโอน|amount|total)[^\d]*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
    /(\d{1,3}(?:,\d{3})*\.\d{2})\s*(?:บาท|THB|฿)/i,
    /฿\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/,
    /(\d{1,3}(?:,\d{3})*)\s*บาทถ้วน/,
  ],
  date: [
    // DD/MM/YYYY หรือ DD-MM-YYYY
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
    // YYYY-MM-DD
    /(\d{4})[\/\-](\d{2})[\/\-](\d{2})/,
    // Thai: วันที่ 25 เม.ย. 2567
    /(\d{1,2})\s+(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s+(\d{4})/,
  ],
  time: [
    /(\d{2}):(\d{2})(?::(\d{2}))?/,
  ],
  sender: [
    /(?:จาก|from|ผู้โอน|ชื่อผู้โอน)[^\n:]*[:\s]+([ก-๙a-zA-Z][ก-๙\s a-zA-Z.]{2,40})/i,
    /(?:บัญชีต้นทาง)[^\n]*\n([ก-๙a-zA-Z][ก-๙\s a-zA-Z.]{2,40})/i,
  ],
  receiver: [
    /(?:ถึง|to|ผู้รับ|ชื่อผู้รับ)[^\n:]*[:\s]+([ก-๙a-zA-Z][ก-๙\s a-zA-Z.]{2,40})/i,
    /(?:บัญชีปลายทาง)[^\n]*\n([ก-๙a-zA-Z][ก-๙\s a-zA-Z.]{2,40})/i,
  ],
  ref: [
    /(?:เลขที่รายการ|หมายเลขอ้างอิง|ref\.?(?:\s*no)?|transaction\s*(?:id|no)?)[^\w]*([A-Z0-9]{6,20})/i,
    /(?:ref|อ้างอิง)[^\w]*:?\s*([A-Z0-9]{6,20})/i,
  ],
};

// แปลงเดือนภาษาไทยย่อ
const THAI_MONTHS = {
  'ม.ค.': '01', 'ก.พ.': '02', 'มี.ค.': '03', 'เม.ย.': '04',
  'พ.ค.': '05', 'มิ.ย.': '06', 'ก.ค.': '07', 'ส.ค.': '08',
  'ก.ย.': '09', 'ต.ค.': '10', 'พ.ย.': '11', 'ธ.ค.': '12',
};

/**
 * แปลงวันที่จาก raw text เป็น YYYY-MM-DD
 */
function parseDate(text) {
  // รูปแบบ DD/MM/YYYY หรือ DD-MM-YYYY
  let m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    const year = parseInt(m[3]) > 2500 ? parseInt(m[3]) - 543 : parseInt(m[3]);
    return `${year}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }

  // รูปแบบ YYYY-MM-DD
  m = text.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
  if (m) {
    const year = parseInt(m[1]) > 2500 ? parseInt(m[1]) - 543 : parseInt(m[1]);
    return `${year}-${m[2]}-${m[3]}`;
  }

  // รูปแบบ Thai เช่น "25 เม.ย. 2567"
  m = text.match(/(\d{1,2})\s+(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s+(\d{4})/);
  if (m) {
    const year = parseInt(m[3]) > 2500 ? parseInt(m[3]) - 543 : parseInt(m[3]);
    const month = THAI_MONTHS[m[2]] || '01';
    return `${year}-${month}-${m[1].padStart(2,'0')}`;
  }

  return null;
}

/**
 * ดึงข้อมูลจากข้อความสลิป
 */
function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return m[1]?.trim() || null;
  }
  return null;
}

/**
 * ตรวจสอบว่าเป็นธนาคารไหน
 */
function detectBank(text) {
  for (const [key, bank] of Object.entries(BANK_PATTERNS)) {
    if (bank.detect.test(text)) return { key, ...bank };
  }
  return null;
}

/**
 * แปลงจำนวนเงินจาก string เป็น number
 */
function parseAmount(str) {
  if (!str) return null;
  const cleaned = str.replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * ฟังก์ชันหลัก: แยกข้อมูลจาก OCR text
 * @param {string} rawText
 * @returns {object|null}
 */
function parseSlip(rawText) {
  if (!rawText || rawText.trim().length < 10) return null;

  const text = rawText;
  const bank = detectBank(text);

  // หาจำนวนเงิน (ลอง bank-specific patterns ก่อน)
  let amountStr = null;
  if (bank) {
    amountStr = firstMatch(text, bank.amount);
  }
  if (!amountStr) {
    amountStr = firstMatch(text, GENERIC_PATTERNS.amount);
  }

  const amount = parseAmount(amountStr);
  if (!amount || amount <= 0) return null; // ถ้าไม่มียอดเงิน ไม่ใช่สลิป

  // หาวันที่
  const dateStr = firstMatch(text, GENERIC_PATTERNS.date);
  const slip_date = parseDate(text);

  // หาเวลา
  const timeMatch = text.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
  const slip_time = timeMatch ? timeMatch[0] : null;

  // หาชื่อผู้โอน/รับ
  const sender_name = firstMatch(text, GENERIC_PATTERNS.sender);
  const receiver_name = firstMatch(text, GENERIC_PATTERNS.receiver);

  // หาเลขอ้างอิง (ลอง bank-specific ก่อน)
  let slip_ref = null;
  if (bank?.ref) {
    const m = text.match(bank.ref);
    if (m) slip_ref = m[1];
  }
  if (!slip_ref) {
    slip_ref = firstMatch(text, GENERIC_PATTERNS.ref);
  }

  return {
    amount,
    slip_date,
    slip_time,
    sender_name,
    receiver_name,
    slip_ref,
    bank_name: bank?.name || 'ไม่ทราบธนาคาร',
    raw_text: rawText,
    // confidence: มีข้อมูลครบแค่ไหน
    confidence: [amount, slip_date, slip_ref].filter(Boolean).length,
  };
}

module.exports = { parseSlip };
