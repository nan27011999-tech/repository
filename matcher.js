// src/matcher.js — จับคู่สลิปกับรายการเดินบัญชี
const { db, queries } = require('./db');
require('dotenv').config();

const AMOUNT_TOLERANCE = parseFloat(process.env.AMOUNT_TOLERANCE || '1.00');
const DATE_TOLERANCE   = parseInt(process.env.DATE_TOLERANCE_DAYS || '3');

/**
 * จับคู่สลิปกับรายการเดินบัญชี
 * Strategy:
 *   1. จับคู่ด้วย ref_code (แม่นยำ 100%)
 *   2. จับคู่ด้วย amount + date (tolerance ±1 บาท, ±3 วัน)
 *   3. จับคู่ด้วย amount อย่างเดียว (ถ้าไม่มีวันที่)
 */
async function matchTransaction(slipData) {
  const { amount, slip_date, slip_ref, bank_name, sender_name, receiver_name } = slipData;

  // Strategy 1: จับคู่ด้วย ref_code
  if (slip_ref) {
    const byRef = db.prepare(`
      SELECT * FROM transactions
      WHERE matched = 0 AND ref_code = ?
      LIMIT 1
    `).get(slip_ref);

    if (byRef) {
      return { match: byRef, confidence: 'high', strategy: 'ref_code' };
    }
  }

  // Strategy 2: amount + date
  if (slip_date) {
    const rows = queries.findUnmatchedByAmountAndDate.all(
      amount, AMOUNT_TOLERANCE, slip_date, DATE_TOLERANCE,
      amount, slip_date
    );
    if (rows.length > 0) {
      return { match: rows[0], confidence: rows.length === 1 ? 'high' : 'medium', strategy: 'amount_date' };
    }
  }

  // Strategy 3: amount เพียงอย่างเดียว
  const rows = queries.findUnmatchedByAmount.all(amount, AMOUNT_TOLERANCE, amount);
  if (rows.length > 0) {
    return {
      match: rows[0],
      confidence: rows.length === 1 ? 'medium' : 'low',
      strategy: 'amount_only',
      alternatives: rows.slice(1, 3), // รายการอื่นที่ใกล้เคียง
    };
  }

  return { match: null, confidence: null, strategy: null };
}

/**
 * ยืนยันการจับคู่และบันทึกลง DB
 */
function confirmMatch(transactionId, slipId) {
  queries.markAsMatched.run(slipId, transactionId);
  queries.updateSlipStatus.run('matched', slipId);
}

/**
 * บันทึกสลิปลง DB และจับคู่
 * @returns {string} ข้อความตอบกลับสำหรับ LINE
 */
async function processSlip(slipData, lineUserId, messageId) {
  // บันทึกสลิปลง DB ก่อน
  const slipResult = queries.insertSlip.run({
    line_user_id: lineUserId,
    message_id: messageId,
    raw_text: slipData.raw_text,
    amount: slipData.amount,
    slip_date: slipData.slip_date,
    slip_time: slipData.slip_time,
    sender_name: slipData.sender_name,
    receiver_name: slipData.receiver_name,
    slip_ref: slipData.slip_ref,
    bank_name: slipData.bank_name,
    status: 'pending',
  });
  const slipId = slipResult.lastInsertRowid;

  // จับคู่
  const result = await matchTransaction(slipData);

  if (!result.match) {
    queries.updateSlipStatus.run('unmatched', slipId);
    return buildUnmatchedMessage(slipData);
  }

  // ยืนยันการจับคู่
  confirmMatch(result.match.id, slipId);

  return buildMatchedMessage(slipData, result);
}

/**
 * สร้างข้อความตอบกลับเมื่อจับคู่ได้
 */
function buildMatchedMessage(slip, result) {
  const { match, confidence, strategy, alternatives } = result;
  const confidenceLabel = { high: '✅ แน่ใจมาก', medium: '🔶 แน่ใจปานกลาง', low: '⚠️ ไม่แน่ใจ' };

  const lines = [
    `🎉 จับคู่รายการได้!`,
    `─────────────────`,
    `💰 ยอดสลิป:   ${slip.amount.toLocaleString('th-TH', {minimumFractionDigits:2})} บาท`,
    `📅 วันที่สลิป: ${slip.slip_date ?? 'ไม่ทราบ'}`,
    `🏦 ธนาคาร:    ${slip.bank_name}`,
    ``,
    `📋 รายการที่ตรงกัน`,
    `   ${match.description}`,
    `   วันที่: ${match.date}`,
    `   ยอด: ${match.amount.toLocaleString('th-TH', {minimumFractionDigits:2})} บาท`,
    ``,
    `${confidenceLabel[confidence] || ''}`,
  ];

  if (slip.slip_ref) lines.push(`🔖 Ref: ${slip.slip_ref}`);
  if (strategy === 'amount_only' && alternatives?.length > 0) {
    lines.push(``, `ℹ️ มีรายการที่ใกล้เคียงอีก ${alternatives.length} รายการ`);
  }

  return lines.join('\n');
}

/**
 * สร้างข้อความตอบกลับเมื่อจับคู่ไม่ได้
 */
function buildUnmatchedMessage(slip) {
  return [
    `❌ ไม่พบรายการที่ตรงกัน`,
    `─────────────────`,
    `💰 ยอดในสลิป: ${slip.amount.toLocaleString('th-TH', {minimumFractionDigits:2})} บาท`,
    `📅 วันที่:    ${slip.slip_date ?? 'ไม่ทราบ'}`,
    `🏦 ธนาคาร:   ${slip.bank_name}`,
    ``,
    `กรุณาตรวจสอบ:`,
    `• สลิปอาจถูกนำมาแล้ว`,
    `• ยอดเงินไม่ตรงกับรายการ`,
    `• ยังไม่ได้นำเข้าข้อมูลเดินบัญชี`,
    ``,
    `📞 ติดต่อเจ้าหน้าที่เพื่อตรวจสอบ`,
  ].join('\n');
}

/**
 * สรุปสถิติ
 */
function getSummary() {
  const all   = queries.getStats.get();
  const today = queries.getTodayStats.get();

  return [
    `📊 สรุปรายการ`,
    `─────────────────`,
    `📌 วันนี้`,
    `   จับคู่แล้ว: ${today.matched_count} รายการ (${(today.matched_amount??0).toLocaleString('th-TH', {minimumFractionDigits:2})} บาท)`,
    ``,
    `📌 ทั้งหมด`,
    `   จับคู่แล้ว:    ${all.matched_count} รายการ`,
    `   ยังไม่จับคู่: ${all.unmatched_count} รายการ`,
    `   ยอดรวม:        ${(all.matched_amount??0).toLocaleString('th-TH', {minimumFractionDigits:2})} บาท`,
  ].join('\n');
}

module.exports = { processSlip, getSummary };
