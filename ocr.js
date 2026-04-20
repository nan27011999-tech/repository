// src/ocr.js — OCR ด้วย Tesseract.js (ฟรี 100% ไม่ต้อง API key)
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Tesseract worker pool (รัน parallel ได้)
let worker = null;

async function getWorker() {
  if (!worker) {
    worker = await Tesseract.createWorker(['tha', 'eng'], 1, {
      // ไม่ log spam
      logger: () => {},
    });
  }
  return worker;
}

// ทำความสะอาด worker เมื่อปิดโปรแกรม
process.on('SIGTERM', async () => { if (worker) await worker.terminate(); });
process.on('SIGINT',  async () => { if (worker) await worker.terminate(); });

/**
 * ประมวลผลรูปภาพก่อน OCR เพื่อความแม่นยำ
 * สลิปธนาคารมักมีพื้นหลังสี — ทำ grayscale + contrast ก่อน
 */
async function preprocessImage(inputBuffer) {
  return sharp(inputBuffer)
    .grayscale()
    .normalize()                    // auto contrast
    .sharpen({ sigma: 1.5 })       // เพิ่มความคมชัด
    .threshold(128)                 // binary threshold (ขาวดำ)
    .png()
    .toBuffer();
}

/**
 * อ่านข้อความจากรูปสลิป
 * @param {Buffer} imageBuffer
 * @returns {string} raw text
 */
async function extractTextFromImage(imageBuffer) {
  try {
    const processed = await preprocessImage(imageBuffer);
    const w = await getWorker();
    const { data: { text, confidence } } = await w.recognize(processed);

    console.log(`[OCR] confidence: ${confidence.toFixed(1)}%`);
    return text;
  } catch (err) {
    console.error('[OCR] error:', err.message);
    throw new Error('OCR ล้มเหลว: ' + err.message);
  }
}

/**
 * ทดสอบ OCR กับรูปจากไฟล์ (ใช้สำหรับ debug)
 */
async function testOCRFromFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return extractTextFromImage(buffer);
}

module.exports = { extractTextFromImage, testOCRFromFile };
