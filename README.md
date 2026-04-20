# LINE Slip Bot 📱
ระบบรับสลิปและจับคู่รายการเดินบัญชีอัตโนมัติ — **ฟรีทั้งหมด**

---

## Stack ที่ใช้ (ฟรี 100%)

| ส่วน | เครื่องมือ | ฟรีแค่ไหน |
|------|-----------|-----------|
| LINE Bot | LINE Messaging API | ฟรี 200 push msg/เดือน (free tier) |
| Server | Render.com | ฟรี (sleep หลัง 15 นาที inactive) |
| OCR | Tesseract.js | Open-source ฟรีตลอด |
| Database | SQLite | ฟรี ไม่ต้องติดตั้งแยก |
| Image processing | Sharp | Open-source ฟรีตลอด |

---

## โครงสร้างโปรเจกต์

```
line-slip-bot/
├── src/
│   ├── server.js     # Webhook + Admin API
│   ├── ocr.js        # Tesseract OCR
│   ├── parser.js     # แยกข้อมูลสลิป
│   ├── matcher.js    # จับคู่รายการ
│   ├── importer.js   # นำเข้า CSV/Excel
│   └── db.js         # SQLite database
├── public/
│   └── index.html    # Admin Web UI
├── data/             # (สร้างอัตโนมัติ) ไฟล์ SQLite
├── .env.example
├── package.json
└── README.md
```

---

## วิธีติดตั้งและใช้งาน

### 1. สร้าง LINE Bot (ฟรี)

1. ไปที่ https://developers.line.biz
2. Log in ด้วยบัญชี LINE ส่วนตัว
3. **Create Provider** → ตั้งชื่อบริษัท/ชื่อตัวเอง
4. **Create a new channel** → เลือก **Messaging API**
5. กรอกข้อมูล → สร้าง
6. ไปที่ tab **Messaging API**:
   - คัดลอก **Channel Secret** → ใส่ใน `.env`
   - กด **Issue** ที่ Channel access token → คัดลอก → ใส่ใน `.env`
7. เปิด **Allow bot to join group chats** (ถ้าต้องการ)
8. ปิด **Auto-reply messages** และ **Greeting messages**

### 2. ติดตั้ง Dependencies

```bash
git clone <your-repo>
cd line-slip-bot
npm install

# คัดลอกและแก้ไข .env
cp .env.example .env
# แก้ไข LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, ADMIN_PASSWORD
```

### 3. ทดสอบ local ด้วย ngrok (ฟรี)

```bash
# Terminal 1: รัน server
npm run dev

# Terminal 2: expose ด้วย ngrok
npx ngrok http 3000
# จะได้ URL เช่น https://xxxx.ngrok-free.app
```

ไปที่ LINE Developers → Messaging API → Webhook settings:
- **Webhook URL**: `https://xxxx.ngrok-free.app/webhook`
- กด **Verify** → ต้องได้ ✅ Success
- เปิด **Use webhook**: ON

### 4. Deploy ขึ้น Render.com (ฟรี)

1. Push โค้ดขึ้น GitHub
2. ไปที่ https://render.com → Sign up ฟรี
3. **New** → **Web Service** → เชื่อม GitHub repo
4. ตั้งค่า:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. เพิ่ม **Environment Variables**:
   ```
   LINE_CHANNEL_ACCESS_TOKEN = xxx
   LINE_CHANNEL_SECRET       = xxx
   ADMIN_PASSWORD            = your-password
   NODE_ENV                  = production
   ```
6. Deploy → รอสักครู่ → ได้ URL เช่น `https://line-slip-bot.onrender.com`
7. อัปเดต Webhook URL ใน LINE Developers

> ⚠️ Render free tier: server จะ sleep หลัง 15 นาที idle
> แก้ได้โดย: ตั้ง cron ping ทุก 10 นาที เช่น https://cron-job.org (ฟรี)

---

## วิธีใช้งาน

### สำหรับ Admin

**นำเข้าข้อมูลเดินบัญชี:**
1. ดาวน์โหลดข้อมูลเดินบัญชีจากแอปธนาคาร (CSV/Excel)
2. เปิด `https://your-domain.com/admin`
3. ใส่รหัสผ่าน (ค่าใน ADMIN_PASSWORD)
4. ลากไฟล์ CSV/Excel ลงในกล่อง Upload
5. ระบบจะนำเข้าและพร้อมใช้งานทันที

**รูปแบบไฟล์ที่รองรับ:**
- SCB: Statement จาก SCB Easy (/export CSV)
- KBANK: K-Statement Excel
- KTB: Krungthai Next CSV
- หรือไฟล์ Excel/CSV ที่มีคอลัมน์: วันที่, รายการ, จำนวนเงิน

### สำหรับผู้ใช้ LINE Bot

1. เพิ่ม Bot เป็นเพื่อน (QR Code จาก LINE Developers)
2. ถ่ายรูปหรือ screenshot สลิปการโอนเงิน
3. ส่งรูปเข้า LINE Bot
4. รอสักครู่ → ระบบจะแจ้งผลว่าจับคู่ได้หรือไม่

**คำสั่ง:**
- `/สถานะ` — ดูสรุปรายการทั้งหมด
- `/ช่วย` — ดูวิธีใช้งาน

---

## เพิ่มประสิทธิภาพ OCR

Tesseract.js ทำงานได้ดีกับสลิปที่:
- ✅ ถ่ายตรง ไม่เอียง
- ✅ แสงสว่างเพียงพอ ไม่มืด
- ✅ ไม่เบลอ
- ✅ ความละเอียดสูง (ไม่ crop เกินไป)

สลิปที่อ่านยาก: SCB, KBANK app screenshot ทำงานได้ดีที่สุด

---

## ข้อจำกัด Free Tier

| บริการ | ข้อจำกัด |
|-------|---------|
| LINE free | 200 push message/เดือน (reply ไม่จำกัด) |
| Render free | Sleep หลัง 15 นาที, 512MB RAM |
| SQLite | ไม่มีขีดจำกัด (ขึ้นอยู่กับ disk ของ Render) |

> 💡 ถ้าต้องการ push message มากกว่า 200/เดือน → อัปเกรด LINE plan (500 บาท/เดือน)
> หรือใช้ reply message แทน push (ฟรีไม่จำกัด แต่ต้องตอบภายใน 1 นาที)
