# ADR 0004: การชำระเงินที่มาถึงหลังออเดอร์หมดอายุ

สถานะ (Status): Draft สร้างไว้ใน webhook และ worker ดู ADR 0002

## บริบท (Context)

สเปกข้อ 6 บอกว่า `payment.succeeded` บนออเดอร์ EXPIRED ต้องจองใหม่แล้วไปต่อ หรือ refund อัตโนมัติเมื่อไม่มี stock แต่แผนภาพในข้อ 5.3 ไม่มีเส้นออกจาก EXPIRED และไม่มีเส้นออกจาก NEEDS_REVIEW ด้วย ข้อ 5.3 ยังบอกว่า transition ใดที่อยู่นอกแผนภาพต้องถูกปฏิเสธ สองข้อจึงขัดกัน

## การตัดสินใจ (Decision)

ข้อ 6 เป็นกฎที่เจาะจงกว่า จึงเพิ่มเส้นให้น้อยที่สุดที่ทำให้ใช้งานได้ `ORDER_TRANSITIONS` ใน `packages/domain/src/order-state.ts` และ `order_status_transitions` ใน `db/migrations/0002_orders.sql` เก็บรายการเดียวกัน และมี test ที่ล้มถ้าสองที่ไม่ตรงกัน

| เส้นที่เพิ่ม | เมื่อไหร่ |
|---|---|
| EXPIRED → PAID | ยอดชำระตรงกับ total และจองคืน stock, สิทธิ์ต่ออีเมล และ voucher ได้ครบ |
| EXPIRED → REFUNDED | ยอดชำระตรงกับ total แต่จองคืนบางอย่างไม่ได้ เมื่อ refund อัตโนมัติ settle แล้ว |
| NEEDS_REVIEW → PAID | คนยืนยันว่าการชำระถูกต้อง fulfilment ไปต่อจาก PAID |
| NEEDS_REVIEW → COMPLETED | คนยืนยันว่าเติมเกมถึงแล้ว เช่นจาก `GET /topups/{reference}` |
| NEEDS_REVIEW → REFUNDED | คน refund ออเดอร์เต็มจำนวน |

EXPIRED → NEEDS_REVIEW มีอยู่แล้วจากบรรทัดสุดท้ายของแผนภาพ และเป็นเส้นทางของการจ่ายช้าที่ยอดไม่ตรง

### การจัดการการจ่ายเงินช้า

`decideLatePayment` ใน domain package เป็นผู้ตัดสิน webhook handler ทำใน transaction เดียว:

1. ตั้ง `paid_satang` ถ้ายอดไม่ตรงไป NEEDS_REVIEW และหยุดตรงนี้
2. จองคืน stock ด้วย conditional UPDATE, ตรวจเพดานต่ออีเมลซ้ำ และจองคืน voucher ด้วยแถว `voucher_redemptions` ใหม่และ conditional UPDATE บน `used_count`
3. ถ้าสำเร็จ เปลี่ยน EXPIRED → PAID ไม่เช่นนั้น rollback เฉพาะขั้นที่ 2, insert refund สถานะ PENDING เต็มจำนวน และเขียน outbox job ออเดอร์คงเป็น EXPIRED จนกว่า refund settle แล้วจึงเป็น REFUNDED

voucher และเพดานต่ออีเมลถูกตรวจซ้ำเช่นเดียวกับ stock ไม่เช่นนั้นออเดอร์ที่หมดอายุอาจทำให้ SAVE10 เกิน 10 ครั้ง หรือ FLASH-SKIN-01 เกิน 2 ชิ้นต่ออีเมล หลังจากสิทธิ์นั้นไปเป็นของคนอื่นแล้ว ซึ่งละเมิด invariant 4

### Partial refund

partial refund ไม่เปลี่ยนสถานะ ออเดอร์คงสถานะเดิมและ `refunded_satang` เพิ่มขึ้น trigger บน `orders` ยอมให้เป็น REFUNDED เฉพาะเมื่อ refund ที่ SUCCEEDED รวมได้เท่ากับ `paid_satang` พอดี

## กรณีอื่น ๆ (Other cases)

- `payment.failed` หลัง `payment.succeeded`: ไม่มีเส้นจากสถานะที่จ่ายแล้วไป PAYMENT_FAILED จึงบันทึก event แล้วเพิกเฉย
- `payment.succeeded` บน PAYMENT_FAILED: ไป NEEDS_REVIEW สเปกไม่ได้ครอบคลุม และควรให้คนดูเงินที่ได้รับบนออเดอร์ที่เราแจ้งลูกค้าไปแล้วว่าล้มเหลว
- Admin retry ออเดอร์ FAILED: FAILED → NEEDS_REVIEW → PAID → IN_QUEUE ใช้เส้นข้างบนซ้ำแทนการเพิ่ม FAILED → IN_QUEUE

## การตัดสินใจระหว่างการสร้าง (Decisions made while building it)

- **การจ่ายช้าที่ fulfil ไม่ได้:** ออเดอร์คง EXPIRED ขณะ refund เป็น PENDING พร้อม event `payment.late_refund` ที่ระบุเหตุผล แล้วเป็น REFUNDED เมื่อ settle ถ้า provider ปฏิเสธ refund จะไป NEEDS_REVIEW
- **`payment.succeeded` ขณะอยู่ใน NEEDS_REVIEW:** บันทึกไว้ และตั้ง `paid_satang` ถ้าเดิมเป็น 0 ให้คนตัดสินต่อ
- **`payment.succeeded` ครั้งที่สองด้วย `event_id` ใหม่บนออเดอร์ที่จ่ายแล้ว:** สถานะไม่เปลี่ยน เขียน event `payment.duplicate` และ reconciliation รายงานเป็น STATUS_MISMATCH ไม่ refund อัตโนมัติ เพราะจากฝั่งเรา การส่งซ้ำของ provider กับการตัดเงินซ้ำจริงดูเหมือนกัน
- **Refund ออเดอร์ NEEDS_REVIEW:** ทำได้ไม่เกิน `paid_satang` รวมถึงกรณียอดไม่ตรง refund เต็มจำนวนจะย้ายไป REFUNDED
- **Stock เมื่อ refund:** FAILED ไป REFUNDED คืน stock และ voucher เพราะ GET ยืนยันว่าไม่มีอะไรถูกส่ง COMPLETED ไป REFUNDED ไม่คืน เพราะผู้เล่นได้ของแล้ว NEEDS_REVIEW ไป REFUNDED ไม่คืน เพราะเราไม่รู้ ผิดพลาดไปทางขายน้อยลงเสมอ ไม่เคยไปทาง oversell
- **Admin retry:** เฉพาะ FAILED หรือ NEEDS_REVIEW และเฉพาะเมื่อออเดอร์จ่ายครบ เคยถึง IN_QUEUE (จึงยังถือ stock และ voucher อยู่) และไม่มี refund ในทางปฏิบัติออเดอร์ FAILED แทบทุกตัวมี refund อัตโนมัติแล้ว retry จึงใช้กับ NEEDS_REVIEW เป็นหลัก

## ผลที่ตามมา (Consequences)

- state machine ใหญ่กว่าแผนภาพในสเปก และผู้ตรวจต้องอ่าน ADR นี้เพื่อเข้าใจเหตุผล
- PAYMENT_FAILED และ EXPIRED ไม่ใช่สถานะปลายทางโดยสมบูรณ์
- การเปลี่ยนเส้นต้องมี migration ใหม่และแก้ domain ด้วย และ drift test บังคับทั้งสองที่
