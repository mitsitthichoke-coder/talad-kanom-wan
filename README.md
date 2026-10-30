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
