// src/server.js — Server หลัก
const express = require('express');
const line    = require('@line/bot-sdk');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
require('dotenv').config();

const { extractTextFromImage } = require('./ocr');
const { parseSlip }            = require('./parser');
const { processSlip, getSummary } = require('./matcher');
const { importFile }           = require('./importer');
const { queries }              = require('./db');

// ========================================
// Config
// ========================================
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
};

const app    = express();
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ========================================
// Middleware
// ========================================
app.use('/admin', express.static(path.join(__dirname, '..', 'public')));

// Simple admin auth middleware
function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('กรุณาล็อกอิน');
  }
  const [, encoded] = auth.split(' ');
  const [, password] = Buffer.from(encoded, 'base64').toString().split(':');
  if (password === process.env.ADMIN_PASSWORD) return next();
  res.status(403).send('รหัสผ่านไม่ถูกต้อง');
}

// ========================================
// LINE Webhook
// ========================================
app.post('/webhook',
  line.middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200); // ตอบ LINE ก่อนเสมอ (ต้องตอบภายใน 1 วินาที)

    const events = req.body.events;
    for (const event of events) {
      try {
        await handleEvent(event);
      } catch (err) {
        console.error('[Event Error]', err.message);
      }
    }
  }
);

async function handleEvent(event) {
  const userId = event.source?.userId;

  // ========== รับรูปภาพ (สลิป) ==========
  if (event.type === 'message' && event.message.type === 'image') {
    const messageId = event.message.id;

    // แจ้งว่ากำลังประมวลผล
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: '⏳ กำลังอ่านสลิป รอสักครู่...' }],
    });

    try {
      // ดึงรูปจาก LINE
      const stream = await client.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const imageBuffer = Buffer.concat(chunks);

      // OCR
      const rawText = await extractTextFromImage(imageBuffer);
      console.log(`[OCR Result]\n${rawText}\n---`);

      // Parse
      const slipData = parseSlip(rawText);
      if (!slipData) {
        await client.pushMessage({
          to: userId,
          messages: [{
            type: 'text',
            text: '⚠️ ไม่สามารถอ่านข้อมูลสลิปได้\n\nกรุณาส่งรูปสลิปที่:\n• ถ่ายตรง ไม่เอียง\n• แสดงยอดเงินชัดเจน\n• ไม่เบลอหรือมืดเกินไป',
          }],
        });
        return;
      }

      // Match
      const replyText = await processSlip(slipData, userId, messageId);

      await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: replyText }],
      });

    } catch (err) {
      console.error('[Slip Error]', err);
      await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: `❌ เกิดข้อผิดพลาด: ${err.message}\n\nกรุณาลองใหม่อีกครั้ง` }],
      });
    }
    return;
  }

  // ========== รับข้อความ ==========
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text?.trim().toLowerCase();

    if (text === '/สถานะ' || text === '/status') {
      const summary = getSummary();
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: summary }],
      });
    }

    if (text === '/ช่วย' || text === '/help') {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: '📖 วิธีใช้งาน\n─────────────\n📸 ส่งรูปสลิป → ระบบจะอ่านและจับคู่อัตโนมัติ\n\n/สถานะ → ดูสรุปรายการ\n/ช่วย   → แสดงวิธีใช้',
        }],
      });
    }

    // Default
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: '📸 ส่งรูปสลิปเพื่อตรวจสอบรายการ\nหรือพิมพ์ /ช่วย เพื่อดูวิธีใช้งาน',
      }],
    });
  }
}

// ========================================
// Admin API (ต้องการ password)
// ========================================

// Upload CSV/Excel
app.post('/admin/upload', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.csv', '.xlsx', '.xls'].includes(ext)) {
    return res.status(400).json({ error: 'รองรับเฉพาะ .csv .xlsx .xls' });
  }

  try {
    const result = importFile(req.file.buffer, req.file.originalname);
    res.json({
      success: true,
      message: `นำเข้าสำเร็จ ${result.imported} รายการ (ข้าม ${result.skipped} รายการ)`,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ดูสถิติ
app.get('/admin/stats', adminAuth, (req, res) => {
  const stats    = queries.getStats.get();
  const today    = queries.getTodayStats.get();
  const recent   = queries.getRecentSlips.all();
  const pending  = queries.getUnmatchedTransactions.all();
  res.json({ stats, today, recent, pending });
});

// ดูรายการที่ยังไม่จับคู่
app.get('/admin/unmatched', adminAuth, (req, res) => {
  const rows = queries.getUnmatchedTransactions.all();
  res.json(rows);
});

// Health check (สำหรับ Render.com)
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ========================================
// Start
// ========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ LINE Slip Bot running on port ${PORT}`);
  console.log(`📍 Webhook URL: https://your-domain.com/webhook`);
  console.log(`🔧 Admin URL:   https://your-domain.com/admin`);
});
