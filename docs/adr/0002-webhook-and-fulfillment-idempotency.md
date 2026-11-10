# ADR 0002: Idempotency ของ webhook และ fulfillment

สถานะ (Status): Draft

## บริบท (Context)

สเปกข้อ 5.4 กำหนดว่าเติมเกมซ้ำคือตกทันที และทุกข้อความอาจมาซ้ำ สลับลำดับ หรือหายไป process ใดก็ตายระหว่างสองบรรทัดได้ mock-game ไม่ได้ช่วยปกป้องเรา: ทุก POST ที่มัน commit นับเป็นการเติมเพิ่มอีกครั้ง และ `SUCCESS_BUT_TIMEOUT_RATE` ทำให้มัน commit แล้วไม่ตอบเลย

## การตัดสินใจ (Decision)

กัน webhook ซ้ำด้วย primary key ของ `webhook_events` ภายใน transaction ที่เปลี่ยนสถานะ; เขียนงานต่อเนื่องเป็นแถว outbox ใน transaction เดียวกัน; เติมเกมเฉพาะหลัง GET ตอบ 404 สำหรับ reference `<order_id>:<sku>`; ส่ง refund ด้วย `refund_id` ที่ idempotent และ settle ด้วย SQL function เดียว รายละเอียดอยู่ในหัวข้อด้านล่าง โค้ด: `apps/api/src/webhooks/`, `apps/worker/src/job-handlers.ts`, `apps/worker/src/outbox.repository.ts`, `db/migrations/0003`, `0006`, `0007` หลักฐาน: `scripts/audit/invariants.mjs` scenario s2a (kill worker 3 ครั้งขณะออเดอร์เป็น IN_PROGRESS), s2b (webhook ซ้ำ ใหม่ และ replay, signature ผิด), s3 (refund พร้อมกัน, kill worker ระหว่าง refund, replay refund webhook) และ `db/src/refund-settlement.int.spec.ts`

## Webhook

`POST /api/v1/webhooks/payment` ตามลำดับนี้:

1. ตรวจ `X-IBM-Signature` บน `req.rawBody` ด้วย `timingSafeEqual` ตรวจรูปแบบ header ก่อน ทั้งสองฝั่งจึงยาว 32 bytes เสมอ ถ้า `t` ห่างเกิน 300 วินาทีจะถูกปฏิเสธ ทั้งหมดนี้ตอบ 401 `INVALID_SIGNATURE`
2. Validate body ด้วย Zod ไม่ผ่านตอบ 422
3. ใน transaction เดียว: `INSERT INTO webhook_events ... ON CONFLICT (event_id) DO NOTHING`, การเปลี่ยนสถานะ, `order_events` ของมัน, outbox job แล้ว commit และตอบ 200

primary key ทำหน้าที่กันซ้ำ สำเนาที่มาระหว่างตัวแรกกำลังทำจะรอที่ index จนตัวแรก commit แล้วเห็นแถวนั้นและตอบ 200 พร้อม outcome `duplicate` ถ้าตัวแรก crash แถวก็ rollback ไปด้วย การ retry ของ provider จึงเริ่มใหม่สะอาด ไม่มีสถานะ `processing` ที่อาจค้าง เหตุผลเดียวกับ ADR 0001

ลำดับการล็อกตาม ADR 0001: แถว event, email advisory lock, แถวออเดอร์, products ตาม SKU, voucher อ่านอีเมลก่อนล็อกออเดอร์ซึ่งปลอดภัยเพราะอีเมลไม่เปลี่ยน `payment.succeeded` ขอ email lock เสมอ เพราะการจ่ายช้าต้องตรวจเพดานต่ออีเมลซ้ำ

| Event | สถานะออเดอร์ | ผลลัพธ์ |
|---|---|---|
| `payment.succeeded` ยอดตรง | PENDING_PAYMENT | PAID, IN_QUEUE และ job ใน transaction เดียว |
| `payment.succeeded` ยอดผิดหรือไม่ใช่ THB | PENDING_PAYMENT, EXPIRED | บันทึก `paid_satang`, NEEDS_REVIEW ไม่เติมเกม |
| `payment.succeeded` | EXPIRED | ADR 0004: จองคืน ไม่เช่นนั้น refund |
| `payment.succeeded` | PAYMENT_FAILED | NEEDS_REVIEW, ADR 0004 |
| `payment.succeeded` ที่มี `event_id` ใหม่ | จ่ายแล้ว | สถานะไม่เปลี่ยน, event `payment.duplicate` และ reconciliation รายงาน |
| `payment.failed` | PENDING_PAYMENT | PAYMENT_FAILED คืน stock และ voucher ใน transaction เดียวกัน |
| `payment.failed` | อื่น ๆ | สถานะไม่เปลี่ยน, event `payment.failed_ignored` |
| `payment.refunded` | มี refund PENDING ที่ตรงกัน | Settle |
| `payment.refunded` | ไม่มีที่ตรงกัน | NEEDS_REVIEW เพราะมีเงินเคลื่อนไหวที่เราไม่ได้ขอ |
| ใดก็ได้ | ออเดอร์ที่ไม่รู้จัก | บันทึกไว้ ตอบ 200 เพื่อให้ provider หยุด retry |

## Outbox และ lease

job คือแถวที่เขียนใน transaction ที่เปลี่ยนสถานะ กรณี "สถานะเปลี่ยนแต่ไม่มี job" จึงเกิดไม่ได้ worker claim ด้วย `FOR UPDATE SKIP LOCKED` และเลื่อน `available_at` ไปข้างหน้าตาม lease การ claim commit ทันที จึงไม่ถือ connection หรือล็อกระหว่างยิง HTTP

worker ที่ตายไม่ต้องจัดการพิเศษ: เมื่อเลย `available_at` การ poll ครั้งถัดไปจะหยิบ job ไป `attempts` เพิ่มทุกครั้งที่ claim และ `(id, attempts)` ทำหน้าที่เป็น fencing token worker ที่ค้างเกิน lease จึงเปลี่ยนอะไรไม่ได้เมื่อตัวอื่น claim ไปแล้ว job ที่เริ่มแล้วได้คิวก่อน job ใหม่ เพราะออเดอร์ของมันอยู่ในนาฬิกา 2 นาที `requeueOrphans` เป็นแค่ตาข่ายกันพลาดและไม่ควรเจออะไร

Redis แค่ปลุก worker ให้เร็วขึ้น polling ยังรันทุกวินาทีเสมอ และการ publish ไม่เคยทำให้ request ล้ม

## ไม่เติมเกมซ้ำเด็ดขาด

**กฎ:** POST เฉพาะทันทีหลัง GET ตอบ 404 และเฉพาะเมื่อไม่มีอะไรอื่นที่อาจยังลงไปได้ timeout, 5XX ของ GET, network error หรือ 200 ที่ไม่มี count ล้วนหมายถึง "เราไม่รู้" และการไม่รู้ไม่เคยนำไปสู่ POST

ออเดอร์มีได้หลายบรรทัดและ mock-game รับหนึ่ง sku ต่อ POST reference จึงเป็น `<order_id>:<sku>` ซึ่งไม่เปลี่ยนข้าม retry

ทุกการ claim สำหรับแต่ละบรรทัด:

1. `GET /topups/{reference}` เจอ: บรรทัดนี้เสร็จ ไม่รู้: retry ทีหลัง
2. หยุดถ้านี่เป็น claim สุดท้ายหรือถึงเพดาน POST แล้ว บรรทัดนี้ถือว่าไม่ได้ส่ง
3. Insert `fulfillment_attempts` เป็น IN_FLIGHT และต่อ lease แล้ว commit การ insert ถูกปฏิเสธถ้า claim นี้ไม่ใช่ของเราแล้ว หรือมี attempt อื่น in flight อยู่ (partial unique index)
4. POST บันทึกผลเป็น SUCCEEDED, FAILED หรือ UNKNOWN

### กับดักเรื่องจังหวะเวลา

กับดัก: client timeout ขณะที่ mock-game ยังอยู่ใน `LATENCY_MS` ก่อนที่มันจะ commit GET ในจังหวะนั้นอาจตอบ 404 แล้ว POST ครั้งที่สองออกไป จากนั้น POST แรกก็ commit ด้วย

ใน `apps/mock-game/server.js` delay รันก่อน routing สำหรับทั้งสอง method และอ่าน state หลัง delay ดังนั้น GET ที่ส่งหลัง POST จะอ่าน state หลัง POST นั้น commit ไม่ว่า latency เท่าไร การตีความ 404 ของเราจึงถูกต้องกับ mock นี้ แต่เราไม่อยากพึ่งสิ่งนี้อย่างเดียว จึง:

- หลัง timeout มี settle wait ก่อน GET ถัดไป (`FULFILLMENT_SETTLE_MS`, 5 s) POST ที่ออกไปแล้วจะมีเวลา POST timeout + settle = 13 s ให้ลงไป บวกกับ delay ของ GET เองใน mock นี้
- GET มี timeout ของตัวเอง ถ้า `LATENCY_MS` สูงกว่านั้น GET จะตอบไม่ทัน state ยังไม่รู้ และไม่มี POST ออกไป ออเดอร์จบที่ NEEDS_REVIEW
- หลัง crash attempt ที่ IN_FLIGHT จะถูกรับช่วงเฉพาะเมื่อ lease หมดแล้ว worker ไม่ยอมเริ่มถ้า lease ไม่ยาวกว่า POST timeout + settle + GET timeout ดังนั้นใครที่ส่ง POST นั้นก็ timeout ไปแล้ว และ POST นั้นได้เวลา settle แล้ว

ทดสอบตรง ๆ สองรอบ: POST timeout 3 s กับ `LATENCY_MS` 6 s: ทุก POST timeout ก่อนแล้วค่อย commit ทีหลัง GET ถัดไปเจอ และทั้ง 12 ออเดอร์ completed ด้วย count เท่ากับ 1 อีกรอบ `LATENCY_MS` 12 s ซึ่งสูงกว่า GET timeout 8 s: ไม่มี POST ออกไปเลย และทั้ง 4 ออเดอร์ไป NEEDS_REVIEW

### เมื่อไหร่ที่หยุด

สูงสุด 5 claim: GET และ POST ได้ถึงสามรอบ และ claim สุดท้ายที่อ่านอย่างเดียว การอ่านครั้งสุดท้ายทำให้การตัดสินใจอิงกับ GET ใหม่หลัง settle wait เสมอ

| สถานะล่าสุดที่รู้ | ผลลัพธ์ |
|---|---|
| เจอครบทุกบรรทัด | COMPLETED |
| GET ยังตอบไม่ได้ | NEEDS_REVIEW และ dead letter ไม่เดา |
| เจอบางบรรทัด บรรทัดอื่นยืนยันว่าไม่ได้ส่ง | NEEDS_REVIEW และ dead letter refund เต็มจำนวนจะผิด |
| ไม่มีบรรทัดไหนส่งถึง ยืนยันด้วย GET | FAILED, dead letter และ refund อัตโนมัติ ใน transaction เดียว |

ค่า default: 3 x (POST 8 s + settle 5 s + backoff สูงสุด 4 s) ประมาณ 51 s และหลัง crash บวก lease อีกสูงสุด 25 s ดังนั้นออเดอร์ออกจาก IN_PROGRESS ภายใน 2 นาทีตามสเปกข้อ 7 เมื่อระบบกลับมา ค่า default แรก (10 s, 10 s และ lease 35 s) ไปถึง 119 s ตามนาฬิกาจริงในรอบที่ kill สองครั้ง ใกล้เพดานเกินไป ต้นทุนของ timeout ที่สั้นลง: เมื่อ `LATENCY_MS` ตั้งแต่ 8 s ขึ้นไป ทุกออเดอร์จบที่ NEEDS_REVIEW ซึ่งปลอดภัย และเพิ่ม timeout ได้ผ่าน env

### สิ่งที่ยังเหลือ

worker อาจค้างระหว่าง commit attempt กับการส่ง bytes นานกว่า lease ขณะที่ worker ตัวที่สองรับช่วง เราลดช่องนี้ด้วยการเช็กเวลาที่ผ่านไปก่อน POST ทันที แต่มีเพียง provider ที่มี idempotency จริงเท่านั้นที่ปิดช่องนี้ได้ Compose รัน worker ตัวเดียว ซึ่งแข่งกับตัวเองไม่ได้

## Refund

ใช้ idempotency แบบ transaction เดียวเหมือนออเดอร์ (ADR 0001) โดยมีขอบเขตต่อออเดอร์ ล็อกแถวออเดอร์ทำให้ refund พร้อมกันวิ่งทีละตัว `planRefund` ตรวจยอดคงเหลือ และฐานข้อมูลหนุนด้วย `orders_refund_within_paid`

API เขียนแค่แถว PENDING และ job แล้ว worker เรียก `POST /refunds` `refund_id` คือ `refunds.refund_ref` ซึ่งสุ่ม ไม่ใช่ค่า identity เพราะ `_test/reset` restart identity แต่ mock-pay เก็บ journal ไว้ การส่งซ้ำปลอดภัยเสมอ

การ settle เป็น SQL function เดียวคือ `settle_refund` ใช้ทั้งจาก webhook และจากคำตอบของ `POST /refunds` อันไหนมาก่อนก็ได้ webhook ไม่ระบุ refund จึงจับคู่ด้วยยอด และคำตอบของ worker เลือกแถวของตัวเองก่อน แต่ละ event settle แถว PENDING ได้หนึ่งแถวพอดี และ event ที่ใช้แล้วไม่มีผล `provider_event_id` เป็น unique หนุนอีกชั้น

การจับคู่ด้วยยอดอย่างเดียวไม่พอ (audit, `s3/same-amount-order`) เมื่อมีแถว PENDING สองแถว A และ B ยอด 5000 worker ที่ส่ง B แล้วตาย ทิ้งให้ webhook ของ B ไป settle A ซึ่งมี id ต่ำสุด job ของ A ที่ restart แล้วเห็นแถวที่ไม่ใช่ PENDING จึงปิดโดยไม่ส่ง และ job ของ B ได้ `already_settled` provider มี refund หนึ่งรายการ ฐานข้อมูลมี settle หนึ่งและค้าง PENDING หนึ่ง และไม่มีอะไรจะส่ง A อีกเลย วิธีแก้ที่เลือกเพราะง่ายที่สุดที่พิสูจน์ได้ทุก interleaving: **ทุก refund job ส่ง `refund_id` ของตัวเองเว้นแต่แถวของมันเป็น FAILED** แม้ webhook จะ settle แถวนั้นไปแล้ว เหตุผลที่ยอดรวมตรงกัน:

- `refund_id` idempotent ที่ provider แต่ละแถวจึงสร้าง refund ที่ provider ได้ไม่เกินหนึ่ง และทุกแถวที่ไม่ถูกปฏิเสธจะสร้างได้หนึ่งพอดีเมื่อ job ได้คำตอบ
- แต่ละ provider event settle แถว PENDING ได้หนึ่งแถวพอดีในออเดอร์และยอดเดียวกัน และไม่ซ้ำสอง
- ดังนั้นต่อออเดอร์และยอด แถวที่ settle = refund ที่ provider ไม่ว่า event จะไปลงแถวไหน แถวที่ถูก settle ด้วย event ของแถวอื่นยังส่ง `refund_id` ของตัวเอง และ refund ที่เกิดขึ้นจะ settle แถวที่ยัง PENDING
- สิ่งที่ค้าง PENDING เหลือแค่แถวที่ job หมด retry โดยไม่ได้คำตอบ ซึ่งเป็นความไม่แน่นอนจริง reconciliation รายงานไว้

ทางเลือกอื่นคือคอลัมน์ `sent_at` จับคู่ webhook เฉพาะแถวที่ส่งแล้ว แต่ไม่แก้ความกำกวมระหว่างสองแถวที่ส่งแล้ว job จึงยังต้องส่งต่อไป และเพิ่มการเขียนก่อนทุก POST

**การชำระที่ provider ไม่เคยเห็น** ทีมตรวจเซ็น webhook `payment.succeeded` เอง mock-pay จึงอาจถูกขอให้ refund ออเดอร์ที่มันไม่มีการชำระ worker ส่ง `paid_satang` และ `event_id` ของ webhook ที่จ่ายออเดอร์นั้นไปกับทุก `POST /refunds` mock-pay ใช้ค่าเหล่านี้เฉพาะเมื่อไม่มีการชำระของออเดอร์นั้น: บันทึกการชำระด้วย `event_id` นั้น (ใน journal และ settlement file โดยไม่ส่ง webhook) แล้วตรวจยอดคงเหลือตามปกติ การชำระที่มันรู้อยู่แล้วจะไม่ถูกเปลี่ยนด้วย `paid_satang` จากนั้น reconciliation จะเห็น `event_id` และยอดเดียวกันทั้งสองฝั่ง

**Reconciliation** ยังรายงานเป็น `STATUS_MISMATCH` ทุก refund PENDING ที่ไม่มี job ที่เปิดอยู่จะส่ง และทุก refund PENDING ที่เก่ากว่า 15 นาที

**Stock และการใช้ voucher เมื่อ refund** refund เต็มจำนวนคืน hold เมื่อออเดอร์เป็น FAILED หรือไม่เคยถึง `IN_QUEUE` (เช่น NEEDS_REVIEW หลังยอดไม่ตรง) เพราะไม่มีอะไรไปถึงเกม ออเดอร์แบบนี้อาจคืนไปแล้วระหว่างผ่าน EXPIRED หรือ PAYMENT_FAILED ดังนั้น migration 0007 เพิ่ม `order_hold_releases`: `release_order_holds` คืน stock และการใช้ voucher เฉพาะเมื่อมันเปลี่ยนแถวนั้นจาก held เป็น released การจ่ายช้าที่จองคืน (ADR 0004) ทำเครื่องหมายเป็น held อีกครั้ง expiry worker ใช้ function เดียวกัน

refund ที่ provider ปฏิเสธจะเป็น FAILED คืนยอดของมัน และออเดอร์ไป NEEDS_REVIEW refund ที่หมด retry คง PENDING เพราะ provider อาจทำไปแล้ว ยอดจึงยังถูกกันไว้ และ webhook ที่มาช้ายัง settle ได้

## ผลที่ตามมา (Consequences)

- provider ที่ค้างทำให้ออเดอร์เสียเวลาราว 13 s ต่อครั้ง แลกกับการไม่ต้องเชื่อ timeout
- ภายใต้โหลด refund รายงาน PENDING ก่อนแล้ว settle ทีหลัง API ตอบ 202
- `/stats` แสดง `<order_id>:<sku>` ไม่ใช่ order id อย่างเดียว
