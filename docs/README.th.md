# InBlack Top-Up: คู่มือภาษาไทย

เอกสารนี้สรุปเป็นภาษาไทยจาก [README.md](../README.md), [ARCHITECTURE.md](../ARCHITECTURE.md) และ ADR
เขียนให้คนที่ถนัด React/JavaScript และกำลังเรียน backend อ่านเข้าใจ ถ้าเนื้อหาตรงไหนไม่ตรงกับเอกสารภาษาอังกฤษ
ให้ยึดฉบับภาษาอังกฤษ (ฉบับนั้นอัปเดตก่อน) สรุปนี้เขียนเทียบกับ commit `99c88c9`

---

## 1. ภาพรวมระบบ

ร้านเติมเกม มีหน้ารายการสินค้า หน้า checkout ที่คิดค่าธรรมเนียมและโค้ดส่วนลด ระบบจ่ายเงินจำลอง (mock-pay)
worker ที่ไปเติมเกมผ่าน API เกมจำลอง (mock-game) หน้าติดตามออเดอร์แบบสด ลูกค้า login ด้วย OTP
และหลังบ้าน admin ที่คืนเงินและกระทบยอดได้

เป้าหมายข้อเดียว: **ไม่เสียเงินและไม่เสียของ** แม้ service ใดตายตอนไหนก็ตาม
เงินเก็บเป็น **จำนวนเต็มหน่วยสตางค์** ทุกชั้น (ไม่มี float เลย เช่น 349 บาท = `34900`)

### Stack

| ส่วน | เทคโนโลยี | หน้าที่ |
|---|---|---|
| `apps/web` | Next.js App Router + TypeScript | หน้าร้าน, checkout, tracking, My Orders, หลังบ้าน `/admin` |
| `apps/api` | NestJS (TypeScript) รัน 2 ตัว `api-1`, `api-2` หลัง nginx | REST API + SSE |
| `apps/worker` | Node process แยก | งานใน outbox (เติมเกม, คืนเงิน), หมดอายุออเดอร์, ส่งต่อสัญญาณ real-time |
| `apps/mock-pay`, `apps/mock-game` | Node (`server.js`) | ผู้ให้บริการจ่ายเงินและ API เกมจำลองตามสเปกข้อ 6 และ 7 |
| `packages/domain` | TypeScript ล้วน ไม่มี I/O | คิดราคา, เลขออเดอร์ checksum, state machine |
| PostgreSQL 16 | | **แหล่งความจริงเดียว** |
| Redis 7 | | แค่สัญญาณ pub/sub และตัวนับ rate limit ถ้าหายก็ไม่เสียข้อมูล |
| Mailpit | | กล่องจดหมายทดสอบสำหรับ OTP และใบเสร็จ |

แผนภาพระบบและ sequence diagram เต็มอยู่ใน [ARCHITECTURE.md](../ARCHITECTURE.md)

---

## 2. วิธีรัน

ต้องมี Docker ที่มี Compose v2 **ไม่ต้องสร้าง `.env`** เพราะทุกตัวแปรใน `docker-compose.yml` มีค่า default สำหรับทดสอบแล้ว

```sh
docker compose up --build -d --wait     # หรือไม่ใส่ -d --wait เพื่อดู log
docker compose down                      # หยุด (down -v = ลบข้อมูลด้วย)
```

ทุก port ผูกกับ `127.0.0.1` เท่านั้น

| Service | URL | หมายเหตุ |
|---|---|---|
| Web (Next.js) | http://localhost:3000 | หน้าร้าน, `/checkout`, `/track`, `/my-orders`, `/admin`, `/admin/products` |
| API (nginx กระจายไป `api-1`, `api-2`) | http://localhost:8080 | `/api/v1/...`, `/healthz`, `/readyz` (`/metrics` ตรงนี้ตอบ 404 โดยตั้งใจ ดู [RUNBOOK](../RUNBOOK.md#health-and-metrics)) |
| mock-pay | http://localhost:4010 | หน้าจ่ายเงินที่มีปุ่มเลือก scenario, `GET /settlements.csv` |
| mock-game | http://localhost:4020 | `GET /stats`, `GET /topups/{reference}` |
| Mailpit | http://localhost:8025 | อ่าน OTP และใบเสร็จ (SMTP ที่ 127.0.0.1:1025) |
| Postgres 16 | `127.0.0.1:5433` | db `inblack_topup`, user `inblack_user` / `change_this_local_password` (ค่าทดสอบ) |

Redis, worker และ API แต่ละ replica ไม่ได้เปิด port ออกมา ไม่มี Jaeger (ยังไม่ได้ทำ OpenTelemetry)

### บัญชีทดสอบ (ค่าทดสอบเท่านั้น ไม่ใช่บัญชีจริง)

seed โดย `db/seed/seed.sql` (เก็บแค่ hash) ที่มา: [docs/SEED_CREDENTIALS.md](SEED_CREDENTIALS.md)

**บัญชีหลักของ admin dashboard (http://localhost:3000/admin):** username `Admin` รหัส `Admin3324` (superadmin,
username ไม่สนตัวพิมพ์เล็กใหญ่) ช่อง login รับได้ทั้ง username และอีเมล

| Role | ล็อกอินด้วย | รหัสผ่าน | ทำอะไรได้ |
|---|---|---|---|
| superadmin | username `Admin` (`admin@inblackm.test`) | `Admin3324` | ทุกอย่าง บัญชีหลักสำหรับจัดการออเดอร์ |
| viewer | `viewer@inblackm.test` | `Viewer-Test-2026` | ดูออเดอร์ (อีเมลถูก mask, ค้นได้แค่เลขออเดอร์) |
| support | `support@inblackm.test` | `Support-Test-2026` | + สั่ง retry การเติมเกม |
| finance | `finance@inblackm.test` | `Finance-Test-2026` | + คืนเงิน, กระทบยอด, audit log |
| superadmin | `superadmin@inblackm.test` | `Superadmin-Test-2026` | + แก้สินค้า (ชื่อ ราคา stock) |

role เรียงเป็นลำดับขั้น role ล่างได้สิทธิ์ของ role บนทั้งหมด (ดู `RequireRole` ใน `apps/api/src/admin/admin-roles.ts`)

**ลูกค้า** ไม่มีรหัสผ่าน: ใส่อีเมลใดก็ได้ที่ http://localhost:3000/my-orders แล้วเปิด http://localhost:8025
คัดลอกรหัส 6 หลัก (ใช้ได้ 5 นาที ใช้ได้ครั้งเดียว ผิด 5 ครั้งอีเมลนั้นถูกล็อก 15 นาที)

### ตัวแปรที่ควรรู้

| ตัวแปร | ค่าเริ่มต้น | ทำไมสำคัญ |
|---|---|---|
| `COOKIE_SECURE` | `true` | cookie เป็น `Secure` เบราว์เซอร์ยอมเก็บบน `http://localhost` แต่ **ถ้าเปิดผ่าน IP หรือ hostname อื่นด้วย http ธรรมดา ต้องตั้งเป็น `false`** ไม่อย่างนั้น login แล้วไม่ติด |
| `APP_ENV` | `development` | ค่า `test` เปิด `POST /api/v1/_test/reset` |
| `CSRF_ALLOWED_ORIGINS` | `http://localhost:8080,http://localhost:3000` | origin ที่ส่ง request พร้อม cookie ได้ |
| `ORDER_TTL_SECONDS` | `900` | เวลาจ่ายเงินก่อนออเดอร์ EXPIRED |
| `FAIL_RATE`, `TIMEOUT_RATE`, `SUCCESS_BUT_TIMEOUT_RATE`, `LATENCY_MS` | `0` | ฉีดความผิดพลาดให้ mock-game |

ถ้าจะ override ให้คัดลอก `.env.example` เป็น `.env` secret ทุกตัวใน `docker-compose.yml` / `.env.example` เป็นค่าทดสอบ
ต้องเปลี่ยนก่อน deploy จริง

---

## 3. ลองใช้งานทีละขั้น

1. **ซื้อ:** http://localhost:3000 → เลือกสินค้า → checkout ค่าธรรมเนียมและ VAT เปลี่ยนสดเมื่อเปลี่ยนวิธีจ่ายหรือโค้ด
   ตัวอย่าง: MONTHLY-PASS + FLASH-SKIN-01, `FLAT20`, TrueMoney ได้ยอดรวม ฿261.87 (fee ฿3.87, VAT ฿17.13) และ mock-pay ได้รับ `26187`
2. **จ่ายเงิน:** ระบบพาไป mock-pay แต่ละปุ่มคือ scenario ตามสเปกข้อ 6 (สำเร็จ, ล้มเหลว, webhook ซ้ำ ×5, webhook ช้า, ยอดผิด ฯลฯ)
3. **ติดตามสด:** กลับมาที่หน้าออเดอร์ timeline อัปเดตผ่าน SSE จนเติมเสร็จ `/track` หาออเดอร์ใดก็ได้ด้วยเลขออเดอร์ + อีเมล
   ดู http://localhost:4020/stats จะเห็นว่าแต่ละ `<order_id>:<sku>` ถูกเติมครั้งเดียว
4. **My Orders ด้วย OTP:** http://localhost:3000/my-orders → ใส่อีเมล → เอารหัสจาก Mailpit
5. **Admin dashboard:** login `Admin` / `Admin3324` จะเห็น sidebar สีแดง การ์ดสรุปจาก `GET /api/v1/admin/stats`
   (รีเฟรชทุก 10 วินาที) จำนวนตามสถานะ และตารางออเดอร์
6. **คืนเงิน 2 ขั้น:** login เป็น `finance` (หรือ superadmin) → เปิดออเดอร์ → refund → ใส่ยอด → ยืนยันอีกขั้น
   คืนบางส่วนได้ แต่รวมไม่เกินยอดที่จ่าย
7. **แก้สินค้า:** login เป็น superadmin → http://localhost:3000/admin/products ถ้าแก้ stock แล้ว stock ในระบบไม่ตรงกับที่เห็นอยู่
   จะได้ 409 `STOCK_CHANGED` (กันการเขียนทับข้อมูลที่คนอื่นเพิ่งเปลี่ยน)

---

## 4. แผนที่เอกสาร

| ไฟล์ | มีอะไร | อ่านเมื่อไร |
|---|---|---|
| [README.md](../README.md) | วิธีรัน, บัญชีทดสอบ, วิธีรัน test, ผลล่าสุด, ตารางสถานะ, ข้อจำกัด | อ่านก่อนเป็นอันดับแรก |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | แผนภาพ Mermaid ทุก service, sequence จ่ายเงิน → เติมเกม → SSE, ตาราง failure, data model และ constraint | อยากเข้าใจว่าระบบทำงานยังไงและพังแล้วเกิดอะไร |
| [RUNBOOK.md](../RUNBOOK.md) | อาการ → คำสั่งตรวจ (SQL/curl/docker) → วิธีแก้ → เมื่อไรต้อง escalate: NEEDS_REVIEW, DLQ, refund ค้าง, reconciliation ไม่ตรง, mock-game ล่มทั้งวัน, webhook ถูกปฏิเสธ, Redis/Postgres ล่ม | ตอน on-call หรือมีเหตุ |
| [SEO.md](../SEO.md) | สิ่งที่ทำ (robots, sitemap, noindex) สิ่งที่ไม่ได้ทำ และเหตุผลที่หน้า track/my-orders/admin ต้อง noindex | งาน SEO |
| [AI_LOG.md](../AI_LOG.md) | ใช้ AI ส่วนไหน agent ไหน และ "AI mistakes caught" แยกตามช่วงงาน | อยากรู้ว่า AI ทำผิดอะไรและจับได้ยังไง |
| [openapi.yaml](../openapi.yaml) | สเปก REST API | เขียน client หรือทดสอบ API |
| [docs/SEED_CREDENTIALS.md](SEED_CREDENTIALS.md) | บัญชีทดสอบ admin และรูปแบบ hash | หา password ทดสอบ |
| [docs/SPEC.md](SPEC.md) | โจทย์ต้นฉบับ | ตรวจว่าทำตามสเปกไหม |
| `apps/api/README.md`, `apps/web/README.md`, `apps/worker/README.md` | ส่วนใหญ่ยังเป็นข้อความ starter ของ framework | ไม่ต้องอ่าน ใช้เอกสารที่ root แทน |

### สรุป ADR (ปัญหา → ตัดสินใจ → ผลที่ตามมา)

| ADR | สรุป |
|---|---|
| [0001 กัน oversell](adr/0001-prevent-oversell.md) | **ปัญหา:** API มี 2 replica จะใช้ตัวแปรใน memory กัน stock/voucher ไม่ได้ **ตัดสินใจ:** ตัดสินทุกอย่างใน Postgres ใน transaction เดียว: `UPDATE ... WHERE stock >= $n`, `used_count < max_uses`, advisory lock ต่ออีเมล, idempotency key insert เป็นคำสั่งแรกใน transaction เดียวกัน **ผล:** ไม่มีสถานะ "กำลังทำ" ค้าง แลกกับ request ที่รอกิน connection ระหว่างรอ |
| [0002 idempotency ของ webhook และการเติมเกม](adr/0002-webhook-and-fulfillment-idempotency.md) | **ปัญหา:** webhook มาซ้ำ/สลับ/หายได้ และ mock-game นับทุก POST เป็นการเติมใหม่ (รวมกรณีเติมแล้วไม่ตอบ) **ตัดสินใจ:** กันซ้ำด้วย primary key ของ `webhook_events`, เขียนงานลง outbox ใน transaction เดียวกับการเปลี่ยนสถานะ, เติมเกมเฉพาะเมื่อ GET ได้ 404, คืนเงินด้วย `refund_id` **ผล:** ไม่มีเติมซ้ำ แต่ยังมีช่วงที่ต้องให้คนตัดสิน (NEEDS_REVIEW) |
| [0003 real-time ข้าม replica](adr/0003-realtime-across-replicas.md) | **ปัญหา:** ลูกค้าต่อ SSE อยู่ที่ api-1 แต่การเปลี่ยนสถานะเกิดที่ api-2 หรือ worker **ตัดสินใจ:** event มาจาก `order_events` เท่านั้น trigger ส่ง `NOTIFY` → worker ส่งต่อไป Redis → API อ่าน Postgres ใหม่ และมี polling สำรอง **ผล:** ปกติหน่วงระดับสิบ ms, Redis ล่มยังได้ภายใน ~1 วินาที, ใช้ `Last-Event-ID` ต่อได้โดยไม่ซ้ำไม่ข้าม |
| [0004 จ่ายเงินหลังออเดอร์หมดอายุ](adr/0004-late-payment-after-expiry.md) | **ปัญหา:** สเปกข้อ 6 บอกให้จองใหม่หรือคืนเงินอัตโนมัติ แต่แผนภาพ 5.3 ไม่มีเส้นออกจาก EXPIRED **ตัดสินใจ:** เพิ่มเส้นน้อยที่สุด (EXPIRED → PAID/REFUNDED, NEEDS_REVIEW → PAID/COMPLETED/REFUNDED) และจองใหม่ทั้ง stock, limit ต่ออีเมล, voucher **ผล:** จ่ายช้าก็ไม่ทำให้ voucher หรือ limit เกิน ถ้าจองไม่ได้ก็คืนเงินเต็ม |
| [0005 session, CSRF และ rate limit](adr/0005-sessions-and-csrf.md) | **ปัญหา:** ต้องมี OTP, cookie ปลอดภัย, CSRF, rate limit โดยไม่เก็บอะไรใน memory ของ process **ตัดสินใจ:** session เก็บฝั่ง server (hash ของ token), OTP เก็บเป็น HMAC และตัวนับ/ล็อกอยู่ใน Postgres, CSRF ด้วย SameSite=Strict + Origin allowlist **ผล:** ล็อก OTP ยังทำงานแม้ Redis ล่ม แต่ rate limit ที่อยู่ใน Redis จะ fail open |

---

## 5. หลักการกันเสียเงิน/เสียของ (เทียบกับ React)

| หลักการ | เปรียบกับ React | ในระบบนี้ |
|---|---|---|
| **Conditional update + row lock** | เหมือน `setState(prev => ...)` แบบ functional update ที่คิดจากค่าล่าสุดจริง ไม่ใช่ค่าเก่าที่ capture ไว้ใน closure แต่ทำที่ฐานข้อมูลซึ่งทุก replica ใช้ร่วมกัน | `UPDATE products SET stock = stock - $n WHERE sku = $s AND stock >= $n` ถ้าได้ 0 แถว = `OUT_OF_STOCK` มี `CHECK (stock >= 0)` เป็นด่านสุดท้าย การเปลี่ยนสถานะออเดอร์ตรวจทั้งใน `packages/domain` และ trigger ของ DB (ADR 0001, 0004) |
| **Idempotency key / `event_id` / `refund_id`** | เหมือนใส่ `key` ให้ item ใน list: ของที่ key ซ้ำคือของชิ้นเดิม ไม่ใช่ชิ้นใหม่ หรือเหมือนกัน double-click ปุ่ม submit | `POST /orders` ส่ง `Idempotency-Key` ซ้ำได้คำตอบเดิมแบบ byte-identical, key เดิมแต่ body ต่าง = `IDEMPOTENCY_KEY_REUSED`; webhook กันซ้ำด้วย `event_id`; refund ส่ง `refund_id` เดิมได้ผลเดิม (ADR 0001, 0002) |
| **Transactional outbox + GET ก่อน POST** | outbox เหมือน `useEffect`: side effect (ยิง mock-game) ไม่ทำกลางการ "render" (transaction) แต่จดไว้ให้ทำหลัง commit ส่วน GET ก่อน POST เหมือนเช็ก cache ก่อน fetch เพื่อไม่ส่งซ้ำ | การเปลี่ยนสถานะ + `order_events` + แถว outbox commit พร้อมกัน worker หยิบงานด้วย `FOR UPDATE SKIP LOCKED` ก่อน POST ไป mock-game จะ commit `fulfillment_attempts` แล้ว GET `/topups/{order_id}:{sku}` ก่อน ถ้าไม่ได้ 404 ชัดเจนจะไม่ POST (รับมือ `SUCCESS_BUT_TIMEOUT`) worker ตายก็กู้ได้จาก DB (ADR 0002) |
| **SSE ข้าม replica: Postgres NOTIFY → Redis** | เหมือน state กลาง (store) ที่ทุก component subscribe อยู่: ข้อความแจ้งแค่ว่า "มีของใหม่" แล้ว component ไปอ่านจาก store เอง ไม่ได้เชื่อข้อมูลในข้อความ | trigger บน `order_events` ส่ง `NOTIFY` (ส่งเมื่อ commit เท่านั้น) → worker `LISTEN` แล้ว publish `order:{id}` ไป Redis → API replica ที่ถือ stream ของออเดอร์นั้นอ่าน Postgres ใหม่ด้วย `id > last` ถ้า Redis ล่มก็ poll ทุก 1 วินาที (ADR 0003) |

กฎรวม: **Postgres คือความจริง** Redis หายได้โดยไม่เสียข้อมูล และทุกอย่างจากภายนอก (webhook, job, คำสั่ง admin) ถือว่าซ้ำ สลับ หรือหายได้เสมอ

---

## 6. การทดสอบ

```sh
make test                       # lint, typecheck, unit, integration, e2e หยุดที่ขั้นแรกที่ล้ม
node scripts/ci/test-all.mjs    # เหมือนกันแต่ไม่ต้องมี make (Windows) หรือ pnpm test:all
make lint | typecheck | unit | integration | e2e    # รันทีละขั้น
INVARIANTS=s7,s8 make e2e        # รันแค่บาง scenario ของ invariant audit
```

ต้องมี Docker (Compose v2) และ Node ถ้า Node < 22.12 ขั้น pnpm จะรันใน image `node:22`

- **integration** (`*.int.spec.ts`): รันกับ Postgres 16 + Redis 7 จริงที่ว่างเปล่า
- **e2e**: ยก stack ด้วย `docker compose up --build -d --wait` แล้วรันสคริปต์ใน `scripts/audit/`
  - `scripts/audit/invariants.mjs`: พิสูจน์ invariant เรื่องเงิน/ของด้วย concurrency จริง (เช่น 600 ออเดอร์พร้อมกันขาย FLASH-SKIN-01 ได้ 100 พอดี, ฆ่า worker 3 ครั้งก็ไม่มีเติมซ้ำ, คืนเงินพร้อมกันจาก 2 session ไม่เกินยอดจ่าย, SAVE10 ใช้ได้ 10 ครั้งพอดีจาก 150 อีเมล)
  - `scripts/audit/sse.mjs`: real-time ข้าม replica
  - `scripts/audit/security.mjs`: IDOR, OTP, CSRF, header ฯลฯ
  - ไม่มี Playwright (ชั้น e2e คือสคริปต์เหล่านี้)

**CI** (`.github/workflows/ci.yml`) มี 6 job: `lint` → `typecheck` → `unit` → `integration` → `e2e` → `build-image`
ใน CI ขั้น e2e รันเฉพาะ `--invariants s1a,s2b,s3,s4` (หนึ่ง scenario ต่อ invariant) ส่วน scenario ที่เหลือรันครบด้วย `make e2e` ในเครื่อง

### ผลล่าสุด (คัดจาก README)

| ตรวจ | ผล | ที่ commit |
|---|---|---|
| `scripts/audit/invariants.mjs` (ทุก scenario, clone ใหม่) | ผ่าน 76 ล้ม 0 | `75ea4df` และ `d92e744` หลัง redesign |
| `scripts/audit/security.mjs` | 44/44 | `4407e13`, `6a7d274` และ API รอบ redesign |
| `scripts/audit/sse.mjs` | 10/10 | `4407e13`, `6a7d274` และ API รอบ redesign |
| GitHub Actions ทั้ง 6 job | เขียว | `fd91f78`, `7cb51ba`, `4407e13`, `33d1db2`, `d92e744` |

audit เต็มใช้เวลาประมาณ 10 นาที ให้รันบนเครื่องที่ไม่ sleep (ถ้าเครื่องหลับกลางทาง container จะค้างเกิน TTL 15 นาทีของออเดอร์)

---

## 7. สถานะตามจริง

### เสร็จและมี test

- คิดราคาตาม 3 ตัวอย่างในสเปก, เงินเป็นสตางค์จำนวนเต็มตลอดทาง, เลขออเดอร์ checksum (CSPRNG + mod 997 และมี `CHECK` ใน DB), state machine ทั้งใน domain และ trigger ของ DB
- `Idempotency-Key` บน `POST /orders`, ออเดอร์หมดอายุ
- ไม่ oversell, limit ต่ออีเมล, limit ของ voucher, ไม่เติมซ้ำ, ไม่คืนเงินเกิน ภายใต้ concurrency จริง
- Webhook มีลายเซ็น HMAC (คลาดเวลาได้ 300 วินาที), ซ้ำ, สลับลำดับ, มาหลัง EXPIRED, ยอดผิด → NEEDS_REVIEW
- Transactional outbox, worker มี lease + backoff + dead letter, กู้ได้หลังถูก kill, `SUCCESS_BUT_TIMEOUT` ใช้ GET ก่อน POST
- mock-pay และ mock-game ตามสเปก
- คืนเงินบางส่วน/พร้อมกัน/idempotent, reconciliation API (อัปโหลด CSV, mismatch 4 ประเภท)
- SSE ข้าม replica, ต่อด้วย `Last-Event-ID`, polling สำรองเมื่อไม่มี Redis
- `/healthz`, `/readyz`, Prometheus `/metrics`, log JSON มี `request_id` ตลอด api → worker → mock-game
- OTP, session ฝั่ง server, CSRF, rate limit, IDOR → 404, mask PII, security header + nonce CSP, RBAC ของ admin
- Admin: ตารางออเดอร์ + filter, รายละเอียด + timeline, คืนเงิน 2 ขั้น, retry การเติม (API), superadmin แก้สินค้า
- Frontend: catalog, checkout (fee สด, voucher, ตรวจ Game UID), tracking ด้วย SSE + `aria-live`, My Orders (OTP), dark mode, `prefers-reduced-motion`
- SEO: robots.txt, sitemap.xml ที่ไม่มีหน้าส่วนตัว, `noindex` + `X-Robots-Tag` บน track / my-orders / admin
- Unit, integration (Postgres/Redis จริง), e2e ผ่านสคริปต์ audit, `make test`, GitHub Actions 6 job

**เพิ่มในรอบ redesign:**
- ดีไซน์ตามแนวทางของ inblackm.com (แดง-ขาว, header แดงโลโก้กลาง, ช่องค้นหา, hero, ชิปหมวด, การ์ดสินค้า) โดย **ไม่ได้คัดลอกโลโก้หรือรูปใดจากเว็บนั้น** โลโก้และกราฟิกวาดด้วย SVG/CSS เอง
- Admin dashboard แยก layout (sidebar แดง, top bar แสดงผู้ใช้และ role, การ์ดสรุปจาก `GET /api/v1/admin/stats` รีเฟรชทุก 10 วินาที)
- Login admin ด้วย username (`Admin`) หรืออีเมลก็ได้

### บางส่วน / ยังไม่ได้ทำ

| เรื่อง | สถานะ |
|---|---|
| WCAG 2.2 AA / 320 px / checkout ด้วยคีย์บอร์ดล้วน | ⚠️ ออกแบบโดยคำนึงถึง แต่ยังไม่ได้ audit จริง |
| OpenTelemetry / Jaeger | ❌ |
| Live dashboard ตามสเปก | ❌ ในตาราง README (dashboard ที่มีคือการ์ดสรุปที่รีเฟรชทุก 10 วินาที ไม่ใช่ live ผ่าน SSE) |
| หน้า reconciliation ใน UI | ❌ มีแค่ API `POST /api/v1/admin/reconciliation` |
| หน้าสินค้า `/products/[slug]` + JSON-LD + OG image แบบ dynamic | ❌ |
| i18n `/th` `/en` + hreflang | ❌ มีแต่ภาษาไทย |
| SSG/ISR | ❌ โดยตั้งใจ เพราะ nonce CSP ต้อง render ต่อ request (ดู [SEO.md](../SEO.md)) |
| Lighthouse | ❌ ยังไม่ได้วัด |
| Claude Design export ใน `design/` | ❌ ไม่มีโฟลเดอร์นี้ ณ ตอนเขียน |
| Playwright E2E, contract test | ❌ |
| seed 100k ออเดอร์ + วัด p95 | ❌ |
| Mobile app, deploy | ❌ |

### ข้อจำกัดที่รู้อยู่

- **ชิปหมวดสินค้ายังเป็นอังกฤษ:** ชื่อหมวดมาจากคอลัมน์ `category` ใน seed (`currency`, `pass`, `skin`) ซึ่งแสดงตามค่านั้นตรงๆ ชื่อสินค้าใน seed ก็เป็นอังกฤษ (เช่น `Monthly Pass`)
- **ไม่มีรูปสินค้าจริง:** seed มี `image_path` เช่น `/images/products/diamond-1000.png` แต่ไม่มีไฟล์รูปใน repo การ์ดใช้กราฟิก SVG/CSS แทน
- **`COOKIE_SECURE=true` เป็นค่าเริ่มต้น:** เปิดผ่าน IP/hostname อื่นด้วย http ต้องตั้ง `false` ไม่อย่างนั้น login ไม่ติด
- **worker มีตัวเดียว:** การรัน 2 worker ยังไม่ได้ทดสอบ
- **rate limit fail open เมื่อ Redis ล่ม** (track และ admin login ต่อ IP) แต่ล็อก OTP และล็อก admin login ต่ออีเมลอยู่ใน Postgres จึงยังทำงาน
- **ค้นหาใน admin เป็น exact match** (เลขออเดอร์หรืออีเมลเต็ม)
- **Postgres ล่มนานเกินการ retry ของ mock-pay** (ราว 4 นาที) webhook จะหาย reconciliation จะรายงานเป็น `MISSING_IN_SYSTEM` ให้คนจัดการ
- **NEEDS_REVIEW → COMPLETED ยังไม่มี endpoint** ตอนนี้ต้องทำด้วย SQL ตาม [RUNBOOK](../RUNBOOK.md#orders-stuck-in-needs_review)
- **mock-pay เชื่อ `paid_satang`** สำหรับ payment ที่ตัวเองไม่เคยเห็น (ยอมรับได้เพราะเป็น mock)
- `/metrics` ค่า latency แยกต่อ instance, `docker kill` จะไม่ restart เอง (ใช้ `docker compose start <service>`)
- รายการเต็มอยู่ใน [README.md](../README.md#known-limitations-and-accepted-trade-offs)
