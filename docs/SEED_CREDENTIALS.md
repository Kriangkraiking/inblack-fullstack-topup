# ค่าทดสอบที่ seed ไว้

บัญชีทดสอบสำหรับสภาพแวดล้อมในเครื่องและการตรวจงานเท่านั้น `db/seed/seed.sql` เก็บไว้เฉพาะ hash

| Role | อีเมล | รหัสผ่าน |
|---|---|---|
| viewer | `viewer@inblackm.test` | `Viewer-Test-2026` |
| support | `support@inblackm.test` | `Support-Test-2026` |
| finance | `finance@inblackm.test` | `Finance-Test-2026` |
| superadmin | `superadmin@inblackm.test` | `Superadmin-Test-2026` |
| superadmin | username `Admin` (ตัวพิมพ์ใดก็ได้; อีเมล `admin@inblackm.test`) | `Admin3324` |

บัญชี `Admin` ก็เป็นค่าทดสอบเช่นกัน (migration 0011 และ seed) login ด้วย `{"login":"Admin","password":"Admin3324"}` ส่วนบัญชีอื่น login ด้วยอีเมลในช่อง `login` หรือในช่อง `email` แบบเดิม

## รูปแบบ hash

`scrypt$N$r$p$<salt base64>$<hash base64>` สร้างด้วย `crypto.scryptSync(password, salt, 32, { N, r, p })` ของ Node บัญชีที่ seed ไว้ใช้ N=16384, r=8, p=1 เปรียบเทียบด้วย `crypto.timingSafeEqual`

## ลูกค้า

ลูกค้าไม่มีรหัสผ่านที่ seed ไว้ login ด้วยอีเมลใดก็ได้: `POST /api/v1/auth/otp/request` อ่านรหัส 6 หลักที่ http://localhost:8025 (mailpit) แล้ว `POST /api/v1/auth/otp/verify` รหัสถูกเก็บเป็น HMAC ที่ใช้ key `OTP_HASH_SECRET` เท่านั้น ซึ่งค่า default ใน compose เป็นค่าทดสอบในเครื่อง
