# ADR 0001: การป้องกัน oversell และออเดอร์ซ้ำ

สถานะ (Status): Draft

## บริบท (Context)

API สอง replica รับออเดอร์พร้อมกัน ดังนั้นอะไรที่เก็บในหน่วยความจำของ process เดียวไม่สามารถปกป้อง stock, เพดานการใช้ voucher หรือ idempotency ได้ สเปกข้อ 5.4 กำหนดว่า oversell หรือใช้ voucher เกินแม้ครั้งเดียวคือตกทันที

## การตัดสินใจ (Decision)

ทั้งหมดตัดสินใน Postgres ภายใน transaction เดียวต่อหนึ่ง request

| กฎ | กลไก |
|---|---|
| Stock | `UPDATE products SET stock = stock - $n WHERE sku = $s AND stock >= $n` ถ้าได้ 0 แถวคือ `OUT_OF_STOCK` และ `CHECK (stock >= 0)` เป็นด่านสุดท้าย |
| ยอดรวมของ voucher | `UPDATE vouchers SET used_count = used_count + 1 WHERE ... used_count < max_uses` ถ้าได้ 0 แถวคือ `VOUCHER_EXHAUSTED` และมี `CHECK (used_count <= max_uses)` หนุนอีกชั้น |
| ต่ออีเมล | `pg_advisory_xact_lock(727002, hashtext(email))` แล้วค่อยนับ แล้วค่อยเขียน การ SUM ข้ามแถวที่ request อื่นกำลัง insert อยู่ป้องกันด้วย row lock ไม่ได้ จึงล็อกทั้งอีเมล ส่วนกรณี voucher มี partial unique index บน `voucher_redemptions` หนุนอีกชั้น |
| Idempotency | ดูด้านล่าง |

### Idempotency ใน transaction เดียว

แถวของ key ถูก insert ด้วย `ON CONFLICT DO NOTHING` เป็นคำสั่งแรก ใน transaction เดียวกับการจอง stock และ response ที่บันทึกไว้

- request ที่มาขนานกันด้วย key เดียวกันจะรอที่ unique index จนกว่า transaction แรกจบ แล้วอ่าน response ที่ commit แล้ว ไม่ต้อง polling
- ถ้า crash ตัว key ก็ถูก rollback ไปด้วย จึงไม่มี key ค้างสถานะ "กำลังทำ" และไม่มีสถานะนั้นให้ค้างตั้งแต่แรก
- error เชิงธุรกิจ เช่น `OUT_OF_STOCK` จะ rollback ไปที่ savepoint ซึ่งยังเก็บ key และบันทึก error ไว้ เมื่อ retry จึงได้คำตอบเดิม
- error 5XX จะ rollback ทั้งหมด retry จึงรันใหม่และอาจสำเร็จได้
- body ที่ไม่ผ่าน validation จะไม่ถูกบันทึก client จึงแก้แล้วใช้ key เดิมได้
- เปรียบเทียบ request ด้วย hash ของ input ที่ validate แล้ว ไม่ใช่ raw body รูปแบบการจัดวางหรือ field ที่ไม่รู้จักจึงทำให้ request เดียวกันดูต่างกันไม่ได้

ทางเลือกอื่นคือ commit "จอง key" แยกก่อนแล้วค่อยทำงาน โดยให้ตัวที่รอ polling วิธีนั้นต้องมีเส้นทางกู้ key ที่ถูกทิ้ง และไม่ได้อะไรเพิ่มในกรณีนี้

Trade-off คือ request ที่รออยู่ถือ connection จาก pool ระหว่างที่ block แต่ request ที่มันรอมี connection ของตัวเองอยู่แล้วและไม่ขอเพิ่ม จึงไม่ทำให้ pool deadlock

### ลำดับการล็อก (Lock order)

ทุกตัวที่เขียนข้อมูลล็อกตามลำดับนี้ ทำให้เส้นทางเหล่านี้ไม่เกิด deadlock

1. Idempotency key
2. Email advisory lock
3. แถวออเดอร์ที่มีอยู่แล้ว (expiry และ webhook; การสร้างออเดอร์ไม่มีขั้นนี้)
4. Products เรียงตาม SKU
5. Voucher

เส้นทางจ่ายเงินช้าใน ADR 0004 จองคืน stock และ voucher จึงต้องใช้ลำดับเดียวกันและขอ advisory lock ตัวเดียวกัน ส่วน expiry จัดการทีละออเดอร์ต่อ transaction เพราะถ้าทำเป็น batch อาจถือ voucher ของออเดอร์แรกไว้ขณะรอ product ของออเดอร์ที่สอง

### Database role

api และ worker เชื่อมต่อด้วย `inblack_app` ซึ่งไม่ใช่ superuser และไม่ได้เป็นเจ้าของอะไรเลย ไม่เช่นนั้น bug หรือคำสั่งที่ถูก inject อาจปิด trigger ที่การรับประกันเหล่านี้พึ่งพา มีเพียง `migrate` ที่ใช้ owner ตารางใหม่ทุกตารางต้อง GRANT เอง เพราะ role นี้ไม่ได้ default privileges

### การแก้ stock โดย admin

`PATCH /api/v1/admin/products/{sku}` (superadmin) ตั้งจำนวนคงเหลือ โดยล็อกเฉพาะแถว product (`SELECT ... FOR UPDATE` ขั้นที่ 4 ข้างบน โดยไม่มีอะไรนำหน้า) จึงไม่ deadlock กับการสร้างออเดอร์ expiry หรือ webhook และทั้งหมดรอที่แถวเดียวกัน การสร้างออเดอร์ยังตัด stock ด้วย conditional update ของตัวเอง ไม่มีอะไรเปลี่ยนในเส้นทางนั้น

- request ต้องส่ง `expected_stock` คือค่าที่ admin เห็น ภายใต้ล็อกจะเทียบกับ stock ปัจจุบัน และ `UPDATE` ก็เทียบซ้ำใน `WHERE` ถ้ามีการขายเกิดขึ้นระหว่างนั้นจะได้ 409 `STOCK_CHANGED` แทนที่จะเงียบ ๆ ลบล้างหรือนับซ้ำ
- การสลับระหว่างจำกัดกับไม่จำกัดถูกปฏิเสธ (409 `STOCK_MODE_LOCKED`) เพราะ `release_order_holds` คืน stock ให้เฉพาะสินค้าที่จำกัด ออเดอร์ที่สั่งตอนสินค้ายังไม่จำกัดจะเพิ่มหน่วยที่ไม่เคยถูกตัดเมื่อสินค้ากลายเป็นจำกัด และร้านอาจขายได้มากกว่าที่ admin ตั้ง การรองรับต้องมีบันทึกว่าออเดอร์ไหนตัด stock จริง ตอนนี้ยังไม่จำเป็น
- `CHECK (stock >= 0)` ยังหนุนทุกอย่าง
- ราคา: `order_items` เก็บ `unit_price_satang` และ `name_snapshot` และเป็น append-only ส่วน `orders` เก็บยอดรวมทุกตัว การเปลี่ยนราคาจึงมีผลกับออเดอร์ใหม่เท่านั้น webhook เทียบกับ `orders.total_satang` และ refund เทียบกับ `paid_satang`

## ผลที่ตามมา (Consequences)

- ออเดอร์ flash sale วิ่งทีละรายการผ่านแถว product ซึ่งเป็นจุดประสงค์อยู่แล้ว และล็อกถูกถือไว้แค่ไม่กี่คำสั่งสั้น ๆ
- `POST /api/v1/_test/reset` ต้องตั้ง `APP_ENV=test` ทั้งที่ `migrate` และ API โดย `migrate` ติดตั้งฟังก์ชัน `SECURITY DEFINER` ที่กำหนด `search_path` ตายตัว, grant ให้ `inblack_app` และ drop ทิ้งเมื่อ `APP_ENV` เป็นค่าอื่น container ของ API ไม่เคยถือรหัสผ่านของ owner
