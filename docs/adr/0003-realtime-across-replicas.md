# ADR 0003: สถานะออเดอร์แบบ real-time ข้าม replica

สถานะ (Status): draft (P2)

## บริบท (Context)

สเปกข้อ 8.3: ลูกค้าที่หน้า tracking ถือ SSE connection อยู่บน api-1 ต้องเห็นการเปลี่ยนสถานะภายใน 2 วินาที
แม้ webhook จะเข้า api-2 หรือ worker เป็นผู้เปลี่ยน หลัง connection หลุด `Last-Event-ID` ต้องคืน event ที่พลาดไป
โดยไม่ซ้ำและไม่ข้าม Postgres คือ source of truth และ Redis หายได้ทุกเมื่อ

## การตัดสินใจ (Decision)

1. **Event มาจาก `order_events` เท่านั้น** id ของแถวคือ SSE `id` แต่ละ stream จำ id ล่าสุดที่ส่งไป
   และทุกการอ่านคือ `WHERE order_id = $1 AND id > $last ORDER BY id` id ของออเดอร์เดียวกัน commit
   ตามลำดับ id เพราะทุกการ insert ถือล็อกแถวออเดอร์ (0002_orders.sql) เงื่อนไข "มากกว่าตัวล่าสุดที่ส่ง"
   จึงไม่ข้ามแถวที่ commit ทีหลัง
2. **Signal เป็นแค่คำใบ้ ไม่ใช่ข้อมูล** trigger บน `order_events` ส่ง `NOTIFY order_events` ซึ่ง Postgres
   ส่งเฉพาะตอน commit worker ทำ LISTEN แล้ว publish `order:{id}` ไป Redis แต่ละ API replica subscribe
   `order:{id}` ขณะที่ถือ stream ของออเดอร์นั้น และ unsubscribe เมื่อ stream สุดท้ายปิด ข้อความแค่ทำให้
   stream อ่าน Postgres ใหม่ NOTIFY ยิงสำหรับทุกตัวที่เขียน (API, worker, SQL function, การแก้ด้วยมือ)
   จึงไม่มีเส้นทางโค้ดไหนลืม publish และการ crash หลัง commit ไม่ทำให้ signal หายแบบที่ publish ในโค้ดแอปอาจหาย
3. **Polling ครอบคลุม signal ที่หาย** ขณะที่ Redis subscriber ของ replica ยังไม่ `ready` แต่ละ stream อ่าน
   Postgres ทุก 1 วินาที เมื่อ Redis ปกติก็ยังอ่านทุก 5 วินาที เพื่อครอบคลุม worker restart หรือข้อความที่หาย
   ระหว่างทาง เมื่อ Redis กลับมา ทุก stream อ่านหนึ่งครั้งทันที
4. **Subscribe ก่อน แล้วค่อยอ่าน** stream ใหม่ subscribe ก่อนการอ่านครั้งแรก event ที่ commit ระหว่างนั้นจึง
   อยู่ในการอ่านนั้น หรือถูกแจ้งหลังจากนั้น การอ่านไม่ซ้อนกันในแต่ละ stream ถ้ามี signal ระหว่างอ่านจะอ่านอีกหนึ่งครั้ง
5. **เข้าถึงโดยไม่มีอีเมลใน URL** `POST /orders/track` คืน `events_token` เป็น HMAC-SHA256 ของ order id และ
   เวลาหมดอายุ (1 ชั่วโมง) ด้วย `ORDER_EVENTS_TOKEN_SECRET` เทียบด้วย `timingSafeEqual` ความล้มเหลวทุกแบบ,
   checksum ผิด และออเดอร์ที่ไม่รู้จัก ได้ 404 เหมือนกัน

## ผลที่ตามมา (Consequences)

- latency ในเส้นทางปกติคือ commit, NOTIFY, worker, Redis, API: หลักสิบมิลลิวินาทีใน
  `scripts/audit/sse.mjs` เมื่อหยุด Redis จะถูกจำกัดด้วย poll 1 วินาที (แย่สุด 981 ms)
- ถ้า worker ล่ม signal หยุด และ stream ถอยไปใช้ safety poll 5 วินาที แต่ worker ล่มก็หยุด fulfilment ด้วย
  ในทางปฏิบัติจึงกระทบเฉพาะขั้น PAID
- ทุก stream ที่เปิดอยู่มีต้นทุน query ที่มี index หนึ่งครั้งต่อ 5 วินาที (ต่อวินาทีระหว่าง Redis ล่ม)
  ที่ระดับไม่กี่พัน stream พร้อมกันยังถือว่าน้อย ถ้าเกินกว่านั้นให้เพิ่มช่วง safety หรือเปลี่ยนเป็น poll
  ครั้งเดียวต่อ replica สำหรับทุกออเดอร์ของมัน
- token เพิกถอนก่อนหมดอายุไม่ได้ แต่เปิดเผยแค่การเปลี่ยนสถานะของออเดอร์เดียว ซึ่งผู้ถือพิสูจน์สิทธิ์เข้าถึงมาแล้ว

## ทางเลือกที่พิจารณา (Alternatives considered)

- **Publish ไป Redis จากโค้ดแอปหลัง commit** ต้องมี hook ในทุกตัวที่เขียน และ signal หายถ้า process
  ตายระหว่าง commit กับ publish
- **ให้แต่ละ API replica LISTEN Postgres โดยตรง** ใช้ได้โดยไม่ต้องมี Redis แต่สเปกขอ Redis pub/sub
  และต้องถือ Postgres connection เพิ่มหนึ่งตัวต่อ replica
- **อีเมลใน query string** จะไปอยู่ใน log ของ proxy และ browser จึงปฏิเสธ
