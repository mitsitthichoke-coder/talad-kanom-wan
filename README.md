# ตลาดขนมหวาน (ออนไลน์: ไอดี · เซฟบนเซิร์ฟเวอร์ · แรงกิ้ง · เพื่อน)

โครงสร้าง: `server.js` (Node ไม่มี framework) + `public/index.html` (หน้าเกม) + Postgres

## ดีพลอยบน Render (แบบ Blueprint)
1. อัปโหลดโฟลเดอร์นี้ขึ้น GitHub (ให้ `render.yaml` อยู่ที่ราก repo)
2. Render → New → Blueprint → เลือก repo → Apply
   จะสร้างทั้ง Web Service และ Postgres ให้ แล้วต่อ `DATABASE_URL` ให้อัตโนมัติ

ทำเองแบบไม่ใช้ Blueprint: สร้าง Postgres ก่อน แล้วสร้าง Web Service
(Build: `npm install`, Start: `node server.js`) แล้วใส่ env `DATABASE_URL` เป็น Internal Database URL

## รันในเครื่อง
    npm install
    node server.js        # ไม่ตั้ง DATABASE_URL = เก็บลงไฟล์ data.json (ใช้ทดสอบเท่านั้น)
เปิด http://localhost:3000

## ข้อควรรู้ (แพ็กเกจฟรีของ Render)
- Postgres ฟรีหมดอายุ 30 วันหลังสร้าง (มีเวลาอัปเกรดอีก 14 วัน ไม่งั้นข้อมูลถูกลบ)
- Web Service ฟรีจะหลับหลังไม่มีคนเข้า 15 นาที ครั้งแรกที่ตื่นใช้เวลาราว 1 นาที

## เวอร์ชัน (รูปแบบ 00.00.0000) และรายละเอียดอัปเดต
เลขเวอร์ชันแสดงต่อท้ายชื่อเกม (เช่น `Ver 01.00.0001`) แตะเพื่อดูรายละเอียดการอัปเดตในเกม
เก็บอยู่ในบล็อก `BUILD` ของ `public/index.html` (ระหว่าง `/*BUILD_START*/` และ `/*BUILD_END*/`)

    npm run watch                  # เปิดทิ้งไว้ บันทึกไฟล์ทีไร เลข build +1 อัตโนมัติ
    npm run bump -- "แก้บั๊ก X"     # เพิ่มเลข build และเพิ่มหัวข้ออัปเดต
    node bump.js --minor "เพิ่มด่านใหม่"   # เลขกลาง +1
    node bump.js --major "ปรับระบบใหม่"    # เลขหน้า +1

## ระบบชื่อเล่น
หลังสมัครไอดีเสร็จ เกมจะให้ตั้งชื่อเล่น (2–16 ตัวอักษร ห้ามซ้ำกัน) ใช้แสดงในกระดานผู้เล่น แตะชื่อผู้เล่นด้านบนเพื่อเปลี่ยนภายหลัง
ฐานข้อมูล Postgres จะเพิ่มคอลัมน์ `nick`, `nick_key` ให้เองตอนเซิร์ฟเวอร์เริ่มทำงาน
