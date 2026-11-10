# Runbook

สำหรับทีม on-call คำสั่งทั้งหมดสมมติว่ารัน compose stack จาก root ของ repo (ชื่อคอนเทนเนอร์ `inblack-*`)
ทุกคำสั่งด้านล่างรันจริงกับ stack บนเครื่องที่ commit `4407e13` ยกเว้นที่ระบุว่า
**not run** (คำสั่งเหล่านั้นเปลี่ยนเงินหรือสถานะ) คอลัมน์เงินมีหน่วยเป็นสตางค์

ทางลัดที่ใช้ด้านล่าง:

```sh
# SQL as the table owner (test credentials from docker-compose.yml)
alias ibsql='docker compose exec -T postgres psql -U inblack_user -d inblack_topup'
# admin session for curl (finance can refund and reconcile; support can retry)
curl -s -c fin.jar -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"email":"finance@inblackm.test","password":"Finance-Test-2026"}' \
  http://localhost:8080/api/v1/admin/auth/login
# same with support@inblackm.test / Support-Test-2026 into sup.jar for retry-fulfillment
# every cookie request that changes data needs -b fin.jar -H 'Origin: http://localhost:3000'
```

admin login จำกัด 10 ครั้ง/นาทีต่อ IP และ 5 ครั้งต่ออีเมลต่อ 15 นาที (429 `LOGIN_LOCKED`)

<a id="general-rules"></a>
## กฎทั่วไป

- **Postgres คือความจริง** ห้าม "แก้" ด้วยการแก้ Redis หรือส่งไป mock-game ใหม่ด้วยมือ
- **ห้าม POST ไป mock-game เอง** ตรวจ `GET http://localhost:4020/topups/<order_id>:<sku>` ก่อนเสมอ worker ก็ทำแบบเดียวกัน
- **การเปลี่ยนสถานะต้องผ่าน `transition_order()`** ซึ่งเขียนแถว `order_events` และตรวจกับ edge ที่อนุญาต การสั่ง `UPDATE orders SET status` ตรง ๆ จะถูก trigger ปฏิเสธ เว้นแต่ตั้ง `app.actor`/`app.reason` ไว้ ให้ใช้ function นี้
- **`docker kill` ไม่กลับมาเอง** `restart: unless-stopped` ไม่ restart คอนเทนเนอร์ที่ถูก kill (ทดสอบแล้วกับทุก restart policy) ให้นำกลับมาด้วย `docker compose start <service>` หรือ `docker compose up -d`

<a id="health-and-metrics"></a>
## Health และ metrics

```sh
docker compose ps                                   # every service should be (healthy)
curl -s http://localhost:8080/healthz               # liveness of whichever replica answers
curl -s http://localhost:8080/readyz                # {"status":"ready","checks":{"postgres":"ok","redis":"ok"}}, 503 NOT_READY otherwise
docker compose exec -T api-1 wget -qO- localhost:3000/metrics    # /metrics is 404 through nginx
docker compose exec -T api-2 wget -qO- localhost:3000/metrics
```

`http_request_duration_seconds` แยกต่อ replica (ต้องรวมสองตัว) ส่วน gauge `inblack_*` มาจาก
Postgres และเท่ากันทั้งสองตัว: `inblack_orders{status=...}`, `inblack_queue_depth{topic=...}`,
`inblack_fulfillment_retries`, `inblack_outbox_job_retries`, `inblack_dead_letters{state="open"}`,
`inblack_metrics_db_up` worker ไม่มีพอร์ต HTTP สุขภาพของมันดูจากไฟล์ heartbeat ที่ compose ตรวจ
(`/tmp/worker-heartbeat`, ถือว่าค้างหลัง 90 s)

สิ่งที่ต้องเฝ้าดู: `inblack_dead_letters{state="open"} > 0`, `inblack_orders{status="NEEDS_REVIEW"}`
เพิ่มขึ้นเรื่อย ๆ, `inblack_queue_depth` เพิ่มขึ้นทั้งที่ worker healthy, `/readyz` ตอบ 503

<a id="following-one-request-logs"></a>
## ติดตาม request เดียว (logs)

Log เป็น JSON ทีละบรรทัดพร้อม `request_id` nginx ตั้ง `X-Request-Id` ให้ถ้า client ไม่ได้ส่งมา (และ
ส่งกลับใน response) webhook เก็บค่านี้ไว้ในงาน outbox และ worker ส่งต่อให้ mock-game
จึงติดตามการจ่ายเงินหนึ่งครั้งได้ตั้งแต่ต้นจนจบ:

```sh
docker compose logs --no-log-prefix api-1 api-2 worker mock-game | grep <request_id>
# all requests for one route with a given status:
docker compose logs --no-log-prefix api-1 api-2 | grep '"route":"/api/v1/webhooks/payment"' | grep '"status":401'
```

อีเมลใน log ถูก mask ส่วน token, cookie และลายเซ็นไม่ถูก log เลย

<a id="orders-stuck-in-needs_review"></a>
## ออเดอร์ค้างใน NEEDS_REVIEW

**อาการ:** `inblack_orders{status="NEEDS_REVIEW"}` เพิ่มขึ้น; ใช้ตัวกรอง `NEEDS_REVIEW` ในรายการของ admin

```sh
curl -s -b fin.jar 'http://localhost:8080/api/v1/admin/orders?status=NEEDS_REVIEW'
ibsql -c "SELECT o.id, o.total_satang, o.paid_satang, o.refunded_satang, e.reason, e.created_at
          FROM orders o JOIN LATERAL (SELECT reason, created_at FROM order_events
            WHERE order_id = o.id ORDER BY id DESC LIMIT 1) e ON true
          WHERE o.status = 'NEEDS_REVIEW' ORDER BY e.created_at;"
ibsql -c "SELECT reference, attempt_no, status, http_status, error FROM fulfillment_attempts WHERE order_id = '<id>' ORDER BY id;"
curl -s http://localhost:4020/topups/<order_id>:<sku>      # for every line of the order
```

`reason` ของ event ล่าสุดบอกสาเหตุ ตัดสินใจทีละออเดอร์:

| สิ่งที่พบ | การดำเนินการ |
|---|---|
| ทุกบรรทัดพบที่ mock-game | ทำเครื่องหมายว่าส่งแล้ว: `ibsql -c "SELECT transition_order('<id>','NEEDS_REVIEW','COMPLETED','ops:<your name>','confirmed via GET /topups');"` (คืน `t` เมื่อสำเร็จ) ยังไม่มี admin endpoint สำหรับ edge นี้ จากนั้น resolve dead letter ของมัน (ด้านล่าง) |
| ไม่พบบรรทัดใดเลย, จ่ายครบ, ไม่เคย refund | Retry: `curl -s -b sup.jar -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' -d '{"reason":"..."}' http://localhost:8080/api/v1/admin/orders/<id>/retry-fulfillment` (support ขึ้นไป) จะย้าย NEEDS_REVIEW → PAID → IN_QUEUE, resolve dead letter ที่เปิดอยู่ และ worker จะ GET ก่อน POST ทุกครั้ง ถูกปฏิเสธด้วย 409 ถ้าออเดอร์มี refund, จ่ายไม่ครบ หรือไม่เคยถึงขั้น fulfillment |
| จ่ายยอดผิด (`paid_satang <> total_satang`) หรือมีเงินเข้าในออเดอร์ที่ failed/expired | refund ยอดที่จ่ายมา (finance) ดูหัวข้อ "Refund" ด้านล่าง |
| ส่งไปบางบรรทัด บางบรรทัดยังไม่ส่ง | refund เฉพาะบรรทัดที่ยังไม่ส่ง (partial refund) ห้าม retry ทั้งออเดอร์ |

<a id="dead-letters-dlq"></a>
## Dead letters (DLQ)

**อาการ:** `inblack_dead_letters{state="open"} > 0`

```sh
ibsql -c "SELECT id, topic, aggregate_id, attempts, last_error, created_at FROM dead_letters WHERE resolved_at IS NULL ORDER BY id;"
```

- `fulfillment.requested`: ออเดอร์อยู่ใน `NEEDS_REVIEW` หรือ `FAILED` จัดการออเดอร์ตามหัวข้อข้างบน
  ออเดอร์ที่ `FAILED` ได้ refund อัตโนมัติไปแล้วใน transaction เดียวกัน (ตรวจที่ `refunds`)
- `refund.requested`: refund retry จนหมดโควตาและค้างเป็น `PENDING` (ผู้ให้บริการอาจทำไปแล้ว)
  ดู "Refund ค้างใน PENDING"

หลังจัดการออเดอร์ด้วยมือ (ไม่ใช่ผ่าน retry-fulfillment ซึ่งทำขั้นนี้ให้เอง):

```sh
ibsql -c "UPDATE dead_letters SET resolved_at = now(), resolved_by = 'ops:<your name>' WHERE id = <id> AND resolved_at IS NULL;"
```

**Not run** ในการตรวจครั้งนี้ (เปลี่ยนสถานะ) ให้ escalate ถ้า dead letter ยังเกิดกับออเดอร์ใหม่เรื่อย ๆ
ทั้งที่ mock-game และ mock-pay healthy: นั่นคือ bug ไม่ใช่ outage

<a id="refund"></a>
## Refund

ทำโดย finance, idempotent ตาม key (key เดิมได้คำตอบเดิมทุก byte) refund บางส่วนได้
ไม่เกิน `paid_satang − refunded_satang` **Not run** ในที่นี้:

```sh
curl -s -b fin.jar -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"amount_satang": 26187, "reason": "..."}' \
  http://localhost:8080/api/v1/admin/orders/<id>/refund          # 202, refund PENDING until settled
```

<a id="refund-stuck-in-pending"></a>
## Refund ค้างใน PENDING

```sh
ibsql -c "SELECT id, order_id, amount_satang, status, created_at FROM refunds WHERE status = 'PENDING' ORDER BY created_at;"
ibsql -c "SELECT id, attempts, available_at, last_error FROM outbox WHERE topic = 'refund.requested' AND processed_at IS NULL;"
docker compose logs --no-log-prefix worker | grep refund | tail -20
```

- มีงาน outbox เปิดอยู่: ยังอยู่ระหว่าง retry (backoff สูงสุด 60 s) ตรวจสุขภาพ mock-pay แล้วรอ
- ไม่มีงานเปิดอยู่: retry หมดแล้วโดยไม่ได้คำตอบ ยอดเงินยังถูกจองไว้ จึงไม่มี refund ที่สองที่จะ
  เกินยอดที่จ่ายได้ เทียบกับผู้ให้บริการ: `curl -s http://localhost:4010/settlements.csv | grep <order_id>`
  ถ้าผู้ให้บริการแสดงว่า refund แล้ว webhook `payment.refunded` ที่มาช้าจะ settle แถวนั้นเอง ถ้า
  ไม่มาเลยให้ escalate (การ settle ด้วยมือหมายถึงเรียก `settle_refund` พร้อม provider event id)
- **ห้าม** สร้าง refund ใหม่สำหรับเงินก้อนเดียวกันขณะที่ยังมีรายการ PENDING อยู่

Reconciliation จะรายงาน refund ที่ PENDING นานกว่า 15 นาทีเป็น `STATUS_MISMATCH` ด้วย

<a id="reconciliation-mismatch"></a>
## Reconciliation ไม่ตรง

รัน (finance) พร้อมไฟล์ของผู้ให้บริการ:

```sh
curl -s http://localhost:4010/settlements.csv -o settlements.csv
curl -s -b fin.jar -H 'Origin: http://localhost:3000' -H 'Content-Type: text/csv' \
  --data-binary @settlements.csv http://localhost:8080/api/v1/admin/reconciliation
# {"rows":1,"counts":{"MISSING_IN_SYSTEM":0,"MISSING_AT_PROVIDER":0,"AMOUNT_MISMATCH":0,"STATUS_MISMATCH":0},"mismatches":[]}
```

ใส่ `?from=...&to=...` (เวลา ISO) เพื่อจำกัดช่วงเวลาได้ (ไม่บังคับ) แต่ละ mismatch ระบุ `event_id` และ `order_id`

| ประเภท | ความหมาย | สิ่งที่ต้องทำ |
|---|---|---|
| `MISSING_IN_SYSTEM` | ผู้ให้บริการรับเงินไปแล้วแต่เราไม่มี webhook (webhook หาย เช่น Postgres ล่มนานกว่ารอบ retry ~4 นาทีของ mock-pay) | หาออเดอร์ ถ้ายังเป็น PENDING_PAYMENT/EXPIRED ต้องนำการจ่ายเงินไปใช้หรือ refund การส่ง webhook ที่ลงลายเซ็นซ้ำคือทางที่ปลอดภัย (`event_id` เดิมเป็น idempotent) ไม่เช่นนั้นให้ escalate ไป finance เพื่อ refund ด้วยมือ |
| `MISSING_AT_PROVIDER` | เราบันทึกการจ่ายเงินที่ไฟล์ของผู้ให้บริการไม่มี | ตรวจช่วงเวลาของไฟล์ก่อน ถ้าเป็นจริง ห้าม fulfill ออเดอร์นี้ต่อ: ส่งเข้า review และ escalate (อาจมี webhook ปลอม แปลว่า secret รั่ว) |
| `AMOUNT_MISMATCH` | `paid_satang` ของ event หรือออเดอร์ต่างจากยอดของผู้ให้บริการ | ออเดอร์ควรเป็น NEEDS_REVIEW อยู่แล้ว ให้ refund ส่วนต่างหรือทั้งยอดที่จ่าย |
| `STATUS_MISMATCH` | ยอด refund รวมไม่ตรง, มี `payment.succeeded` ซ้ำ (event `payment.duplicate`) หรือ refund PENDING ที่ไม่มีใครส่ง / ค้างนานกว่า 15 นาที | ตัดเงินซ้ำ: ยืนยันกับผู้ให้บริการแล้ว partial refund ส่วน PENDING: ดูข้างบน |

ให้ escalate ไป finance สำหรับ mismatch ใดก็ตามที่อธิบายไม่ได้จาก `webhook_events` และ `order_events`

<a id="mock-game-down-for-a-whole-day"></a>
## mock-game ล่มทั้งวัน

สิ่งที่ระบบทำเอง: GET ของแต่ละออเดอร์ไม่ได้คำตอบ worker จึงไม่ POST เลย หลังครบ
5 claim (ประมาณหนึ่งนาที) ออเดอร์จะไป `NEEDS_REVIEW` พร้อม dead letter ไม่มีเงินเคลื่อนและ
ไม่มีอะไรถูกส่งซ้ำ ถ้า mock-game ทำงานแต่ปฏิเสธทุก POST ออเดอร์จะจบที่ `FAILED` พร้อม
refund เต็มจำนวนอัตโนมัติเมื่อ GET ยืนยันว่าไม่มีอะไรถูกส่ง

1. **ยืนยัน:** `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4020/healthz`, `docker compose ps mock-game`, log ของ worker
2. **ทางเลือก ชะลอการสะสม:** `docker compose stop worker` ทำให้งานใหม่ค้างอยู่ใน outbox
   แทนที่จะถูกส่งเข้า review ผลข้างเคียง: expiry, refund และการส่งต่อสัญญาณ SSE จะหยุดด้วย
   (stream ถอยไปใช้ polling ทุก 5 s) และลูกค้าจะเห็น IN_QUEUE เริ่มกลับด้วย
   `docker compose start worker` **Not run** ในที่นี้ ถ้าปล่อย worker ทำงานต่อ ออเดอร์จะ
   ไปกองอยู่ใน NEEDS_REVIEW ซึ่งก็ปลอดภัยเช่นกัน
3. **ลูกค้า:** หน้า status / banner แจ้งว่าการเติมล่าช้า และออเดอร์ที่จ่ายแล้วจะได้รับของ
   หรือได้เงินคืน ไม่ต้องจ่ายใหม่ อย่าสัญญาเวลาจนกว่า mock-game จะกลับมา
4. **เมื่อ mock-game กลับมา:** retry ทุกออเดอร์ที่เป็น NEEDS_REVIEW (ตามตารางข้างบน) worker จะ GET ทุก
   reference ก่อน ดังนั้น top-up ที่เข้าไปแล้วก่อน outage จะไม่ถูกทำซ้ำ
5. **ถ้าฝ่ายธุรกิจตัดสินใจ refund แทน (batch):** ทำเฉพาะออเดอร์ที่ทุกบรรทัด
   `GET /topups/<order_id>:<sku>` เป็น 404 และ `refunded_satang = 0` ใช้ `Idempotency-Key`
   คงที่หนึ่งค่าต่อออเดอร์ (เช่น `outage-<date>-<order_id>`) เพื่อให้การรัน batch ซ้ำไม่ refund
   สองครั้ง DB ก็ปฏิเสธ refund ที่เกิน `paid_satang` อยู่แล้ว การ refund ออเดอร์ NEEDS_REVIEW
   จะไม่คืน stock (เราพิสูจน์ไม่ได้ว่าไม่มีอะไรถูกส่ง) **Not run** ในที่นี้

ให้ escalate เมื่อ outage เกิน 30 นาที หรือทันทีถ้า `/stats` แสดง reference ใดมี count เกิน 1

<a id="many-webhooks-rejected-401-invalid_signature"></a>
## Webhook ถูกปฏิเสธจำนวนมาก (401 INVALID_SIGNATURE)

```sh
docker compose logs --no-log-prefix api-1 api-2 | grep '"route":"/api/v1/webhooks/payment"' | grep -c '"status":401'
docker compose exec -T api-1 date -u; date -u                  # clock skew: more than 300 s is refused
docker compose exec -T api-1 printenv PAYMENT_WEBHOOK_SECRET   # compare with mock-pay's (do not paste it anywhere)
docker compose exec -T mock-pay printenv PAYMENT_WEBHOOK_SECRET
```

สาเหตุ: หมุน secret ฝั่งเดียว, clock skew, proxy แก้ body (ลายเซ็นคำนวณบน
raw bytes, header `X-IBM-Signature: t=<unix>,v1=<hex hmac>`) webhook ที่ถูกปฏิเสธไม่เปลี่ยนอะไร
และผู้ให้บริการจะ retry ดังนั้นแก้ secret/นาฬิกาให้ทันภายในรอบ retry ของ mock-pay (ประมาณ
4 นาที) แล้ว backlog จะส่งเข้ามาเอง ตัวที่เลยช่วงนั้นจะโผล่เป็น `MISSING_IN_SYSTEM` ให้ escalate
ทันทีถ้าลายเซ็นล้มเหลวทั้งที่ secret ตรงกัน: อาจมีคนปลอม webhook

<a id="redis-down"></a>
## Redis ล่ม

อาการ: `/readyz` ตอบ 503 (check `redis`), มี warning จาก rate limiter ผลกระทบ: live tracking
ถอยไปใช้ polling ทุก 1 s, worker ยังคง poll outbox ทุกวินาที, ลิมิตของ track และลิมิต admin
login ต่อ IP ไม่ถูกบังคับ (OTP lock และ admin lock ต่ออีเมลยังทำงาน) ข้อมูลไม่มีความเสี่ยง

```sh
docker compose ps redis
docker compose start redis      # or: docker compose up -d redis
```

ให้ escalate ถ้า Redis ไม่อยู่ได้นาน ระหว่างนั้นเฝ้าดู traffic ของ `/orders/track` ว่ามีการ abuse หรือไม่

<a id="postgres-down"></a>
## Postgres ล่ม

อาการ: API ตอบ 503 `DATABASE_UNAVAILABLE`, `/readyz` 503, `inblack_metrics_db_up 0`, worker ว่างงาน
ไม่มีอะไรถูกตอบรับโดยไม่มี commit ดังนั้นออเดอร์และ webhook จะถูกปฏิเสธแล้ว retry เท่านั้น

```sh
docker compose ps postgres
docker compose logs --tail 50 postgres
docker compose start postgres   # or: docker compose up -d postgres
```

หลังกลับมา: ตรวจ `/readyz` แล้วรัน reconciliation สำหรับช่วงเวลาที่ล่ม (webhook ที่ค้างนานเกิน
รอบ retry ของ mock-pay จะโผล่เป็น `MISSING_IN_SYSTEM`) ให้ escalate ทันทีถ้า data volume
เสียหาย เพราะ setup นี้ไม่มี backup หรือ replica
