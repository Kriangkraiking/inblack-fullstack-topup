# InBlack Top-Up

ภาษาไทย: [docs/README.th.md](docs/README.th.md)

ร้านเติมเกม: แคตตาล็อกสินค้า, checkout พร้อมค่าธรรมเนียมและโค้ดส่วนลด, ผู้ให้บริการชำระเงินจำลอง (mock),
worker ที่เติมเกมผ่าน mock game API, ติดตามออเดอร์แบบสด, ลูกค้าเข้าสู่ระบบด้วย OTP และหลังบ้าน admin
ที่ทำ refund และ reconciliation ได้ เป้าหมายของการออกแบบคือ "ไม่เสียเงิน ไม่เสียของ" แม้ service ใดจะตาย
ได้ทุกเมื่อ เงินเป็นจำนวนเต็มหน่วยสตางค์ทุกชั้น

เพิ่มเติม: [ARCHITECTURE.md](ARCHITECTURE.md) · [RUNBOOK.md](RUNBOOK.md) · [SEO.md](SEO.md) ·
[AI_LOG.md](AI_LOG.md) · [docs/adr/](docs/adr/) · [openapi.yaml](openapi.yaml) · โจทย์: [docs/SPEC.md](docs/SPEC.md)

## วิธีรัน

ต้องมี Docker พร้อม Compose v2 ไม่ต้องมีไฟล์ `.env`: ทุกตัวแปรใน `docker-compose.yml`
มีค่า default สำหรับทดสอบในเครื่องอยู่แล้ว

```sh
docker compose up --build -d --wait     # or without -d --wait to watch the logs
```

จาก clone ใหม่ที่ไม่มี `.env` คำสั่งนี้จบด้วย exit 0 และทุก service healthy (ตรวจหลายครั้ง
ครั้งล่าสุดที่ `4407e13`) ทุกพอร์ตที่เปิดออกมา bind กับ `127.0.0.1` เท่านั้น

| Service | URL | หมายเหตุ |
|---|---|---|
| Web (Next.js) | http://localhost:3000 | แคตตาล็อก, `/checkout`, `/track`, `/my-orders`, `/admin`, `/admin/products` |
| API (nginx round-robin ระหว่าง `api-1`, `api-2`) | http://localhost:8080 | `/api/v1/...`, `/healthz`, `/readyz` ส่วน `/metrics` ตั้งใจให้เป็น 404 ที่นี่ ดู [RUNBOOK](RUNBOOK.md#health-and-metrics) |
| mock-pay | http://localhost:4010 | หน้า hosted checkout พร้อมปุ่มเลือก scenario, `GET /settlements.csv` |
| mock-game | http://localhost:4020 | `GET /stats`, `GET /topups/{reference}` |
| Mailpit | http://localhost:8025 | อีเมล OTP และใบเสร็จ (SMTP ที่ 127.0.0.1:1025) |
| Postgres 16 | `127.0.0.1:5433` | db `inblack_topup`, owner `inblack_user` / `change_this_local_password` (ค่าทดสอบ) |

Redis, worker และ API replica ไม่ได้เปิดพอร์ตออกมา หยุดด้วย `docker compose down`
(`down -v` จะลบ data volume ด้วย)

## ค่าทดสอบสำหรับเข้าสู่ระบบ

seed โดย `db/seed/seed.sql` (เก็บเฉพาะ hash) ที่มา: [docs/SEED_CREDENTIALS.md](docs/SEED_CREDENTIALS.md)
ค่าเหล่านี้เป็นค่าทดสอบสำหรับใช้ในเครื่องและการตรวจงานเท่านั้น ไม่ใช่บัญชีจริง

**Admin dashboard (http://localhost:3000/admin):** username `Admin`, password `Admin3324`
(superadmin, username ไม่สนตัวพิมพ์เล็ก/ใหญ่) ช่อง login รับได้ทั้ง username หรืออีเมล

| Role | อีเมล | รหัสผ่าน | ทำอะไรได้ |
|---|---|---|---|
| superadmin | username `Admin` (`admin@inblackm.test`) | `Admin3324` | ทุกอย่างด้านล่าง เป็นบัญชีหลักสำหรับจัดการออเดอร์ |
| viewer | `viewer@inblackm.test` | `Viewer-Test-2026` | อ่านออเดอร์ (อีเมลถูก mask; ค้นได้ด้วยเลขออเดอร์เท่านั้น) |
| support | `support@inblackm.test` | `Support-Test-2026` | + retry fulfillment |
| finance | `finance@inblackm.test` | `Finance-Test-2026` | + refund, reconciliation, audit log |
| superadmin | `superadmin@inblackm.test` | `Superadmin-Test-2026` | + แก้ไขสินค้า (ชื่อ, ราคา, stock) |

Role เรียงเป็นลำดับขั้น: แต่ละ role มีสิทธิ์ของ role ที่อยู่ด้านบนด้วย (`RequireRole` ใน `apps/api/src/admin/admin-roles.ts`)

**ลูกค้า** ไม่มีรหัสผ่าน ใส่อีเมลใดก็ได้ที่ http://localhost:3000/my-orders แล้วเปิด
http://localhost:8025 เพื่อคัดลอกรหัส 6 หลัก (ใช้ได้ 5 นาที ใช้ครั้งเดียว ใส่ผิด 5 ครั้งจะล็อก
อีเมลนั้น 15 นาที)

## ดีไซน์

หน้าร้านใช้แนวทางภาพแบบ inblackm.com (แดง-ขาว, header สีแดงมีโลโก้ตรงกลาง, ช่องค้นหา, hero
ตัวหนา, chip หมวดหมู่และการ์ดสินค้ามุมโค้ง) ไม่ได้คัดลอกโลโก้ รูปภาพ หรือ asset ใดจากเว็บนั้น: โลโก้และ
กราฟิกวาดเองด้วย SVG/CSS ส่วน admin มี layout ของตัวเองตามสไตล์ admin dashboard template ทั่วไป:
sidebar สีแดง, top bar แสดงผู้ใช้ที่ login และ role, การ์ดสรุปจาก `GET /api/v1/admin/stats` (รีเฟรชทุก 10 วินาที),
จำนวนตามสถานะ และตารางออเดอร์ ยังไม่มีไฟล์ export จาก Claude Design ใน `design/` มีแค่ prompt
สำหรับสร้างงานใน Claude Design ที่ [design/CLAUDE_DESIGN_BRIEF.md](design/CLAUDE_DESIGN_BRIEF.md)

## ลองใช้งาน

1. **ซื้อ:** http://localhost:3000 → เลือกสินค้า → checkout (ค่าธรรมเนียมและ VAT อัปเดตเมื่อเปลี่ยน
   วิธีชำระเงินหรือโค้ดส่วนลด) ตัวอย่างจากการรันในเบราว์เซอร์จริง: MONTHLY-PASS + FLASH-SKIN-01,
   `FLAT20`, TrueMoney แสดงยอดรวม ฿261.87, ค่าธรรมเนียม ฿3.87, VAT ฿17.13 และ mock-pay ได้รับ 26187
2. **ชำระเงิน:** ระบบส่งไปที่ mock-pay แต่ละปุ่มคือ scenario จากโจทย์ข้อ 6 (สำเร็จ,
   ล้มเหลว, webhook ซ้ำ ×5, webhook ช้า, ยอดไม่ตรง, ...)
3. **ติดตามแบบสด:** กลับมาที่หน้าออเดอร์ timeline อัปเดตผ่าน SSE จนเติมเกมเสร็จ
   `/track` หาออเดอร์ใดก็ได้ด้วยเลขออเดอร์ + อีเมล http://localhost:4020/stats แสดงการเติม 1 ครั้งต่อ `<order_id>:<sku>`
4. **Admin refund:** login ที่ http://localhost:3000/admin ด้วย `finance` เปิดออเดอร์ กด refund →
   ใส่ยอด → ยืนยันในขั้นที่สอง refund บางส่วนได้ไม่เกินยอดที่ชำระ
5. **แก้ไขสินค้า:** login ด้วย `superadmin` → http://localhost:3000/admin/products การแก้ stock
   ต้องตรงกับ stock ที่เห็นอยู่ ไม่เช่นนั้นจะได้ 409 `STOCK_CHANGED`

## การรัน test

```sh
make test                       # lint, typecheck, unit, integration, e2e; stops at the first failure
node scripts/ci/test-all.mjs    # the same without make (Windows); also: pnpm test:all
```

รันทีละขั้น: `make lint | typecheck | unit | integration | e2e` (หรือ
`node scripts/ci/test-all.mjs <step> ...`); `make up` / `make down` สำหรับ stack หลัก
ต้องมี Docker (Compose v2) และ Node ถ้า Node < 22.12 ขั้นที่ใช้ pnpm จะรันใน image `node:22`
บนสำเนาของ working tree (pnpm store cache ไว้ใน volume `inblack-ci-pnpm-store`)

- **integration**: `*.int.spec.ts` รันกับ Postgres 16 + Redis 7 จริงที่ว่างเปล่า: ในเครื่องใช้
  `scripts/ci/integration.compose.yml` (project `inblack-ci-int`, พอร์ต 55432/56379, ลบทิ้งเมื่อจบ)
  ใน CI ใช้ service container ผ่าน `TEST_DATABASE_URL` test จะ apply migration และ seed เอง
  ขั้นนี้จะล้มถ้ามี test ใดถูก skip หรือไม่มี test ผ่านเลย
- **e2e**: `docker compose up --build -d --wait` จาก working tree (project `inblack-e2e`) แล้วรัน
  `scripts/audit/sse.mjs`, `scripts/audit/invariants.mjs --reuse` กับ stack นั้น และ
  `scripts/audit/security.mjs` ถ้ามีไฟล์อยู่; จบด้วย `down -v` (`--keep` จะปล่อย stack ไว้) จะไม่ยอม
  เริ่มถ้ามี container `inblack-*` ของ project อื่นอยู่ (ชื่อ container ตายตัว)
  นี่คือชั้น end-to-end; ไม่มีชุด Playwright บนเบราว์เซอร์

CI (`.github/workflows/ci.yml`) รันขั้นเดียวกัน: lint → typecheck → unit → integration → e2e →
`docker compose build` ขั้น e2e ใน CI รันแค่ `--invariants s1a,s2b,s3,s4` คือหนึ่ง scenario ต่อหนึ่ง
invariant ด้านเงินหรือของ (s1a oversell burst, s2b webhook ซ้ำ/replay, s3 refund พร้อมกันบวก
reconciliation, s4 ขีดจำกัดโค้ดส่วนลด) ส่วนที่เหลือ (s1b-s1d, s2a, s7, s8) ทดสอบ invariant เดิมซ้ำ
ผ่านการหมดอายุ, การ kill worker และ api-1/Redis ล่ม ซึ่งกินเวลาส่วนใหญ่ของการรัน ดังนั้น `make e2e`
จะรันทั้งหมดในเครื่อง (`INVARIANTS=s7,s8 make e2e` สำหรับบางส่วน)

### ผลล่าสุด

| การตรวจ | ผล | ที่ commit |
|---|---|---|
| `scripts/audit/invariants.mjs` (ทุก scenario, clone ใหม่) | 76 passed, 0 failed | `75ea4df` และ `d92e744` หลัง redesign (orchestrator) |
| `scripts/audit/security.mjs` | 44/44 | `4407e13`, `6a7d274` และ API หลัง redesign (orchestrator) |
| `scripts/audit/sse.mjs` | 10/10 | `4407e13`, `6a7d274` และ API หลัง redesign (orchestrator) |
| GitHub Actions ทั้ง 6 job | เขียว | `fd91f78`, `7cb51ba`, `4407e13`, `33d1db2`, `d92e744` |

ให้รัน audit เต็มบนเครื่องที่จะไม่ sleep: ใช้เวลาประมาณ 10 นาที และถ้าเครื่อง suspend กลางทาง
ทุก container จะค้างจนเลย order TTL 15 นาที (ดู AI_LOG)

สิ่งที่ invariant audit แสดง: ออเดอร์ FLASH-SKIN-01 พร้อมกัน 600 รายการขายได้ 100 พอดี; ออเดอร์ที่จ่ายแล้ว
100 รายการโดย kill worker 3 ครั้ง ไม่มี reference ใดถูกเติมเกิน 1 ครั้ง; refund พร้อมกัน
จาก admin 2 session ไม่เคยเกินยอดที่ชำระ และยอดรวมใน DB เท่ากับของผู้ให้บริการ; SAVE10 ถูกใช้
10 ครั้งพอดีจาก 150 อีเมล

## สถานะงาน (ตามจริง)

เลขข้อของโจทย์อยู่ในวงเล็บ ✅ เสร็จและมี test · ⚠️ บางส่วน · ❌ ยังไม่ทำ

| หมวด | รายการ | สถานะ |
|---|---|---|
| Domain และเงิน | Pricing ตาม 3 ตัวอย่างในโจทย์, สตางค์จำนวนเต็มตลอดทาง, checksum เลขออเดอร์ (CSPRNG + mod 997 และเป็น `CHECK` ใน DB ด้วย), state machine ใน domain + DB trigger | ✅ |
| | Idempotency-Key บน `POST /orders` (replay แบบ byte-identical, `IDEMPOTENCY_KEY_REUSED`), การหมดอายุของออเดอร์ | ✅ |
| Concurrency [5.4] | ไม่ oversell, จำกัดต่ออีเมล, จำกัดโค้ดส่วนลด, ไม่เติมเกมซ้ำ, ไม่ refund เกิน — ทั้งหมดภายใต้ concurrency จริง | ✅ |
| Payments [6] | Webhook ที่เซ็น (HMAC, skew 300 วินาที), ซ้ำ, สลับลำดับ, มาหลัง EXPIRED (จองใหม่หรือ refund อัตโนมัติ), ยอดไม่ตรง → NEEDS_REVIEW | ✅ |
| Fulfillment [7] | Transactional outbox, worker พร้อม lease + backoff + dead letter, กู้คืนหลังถูก kill, จัดการ `SUCCESS_BUT_TIMEOUT` ด้วย GET-before-POST | ✅ |
| | mock-pay และ mock-game เขียนตามสเปก | ✅ |
| | Refund: บางส่วน, พร้อมกัน, idempotent; reconciliation API (อัปโหลด CSV, mismatch 4 ประเภท) | ✅ |
| Real-time [8.3] | SSE ข้าม replica ผ่าน Postgres NOTIFY → worker → Redis pub/sub, resume ด้วย `Last-Event-ID`, fallback เป็น polling เมื่อไม่มี Redis | ✅ |
| Observability | `/healthz`, `/readyz`, Prometheus `/metrics` (latency histogram, ออเดอร์ตามสถานะ, queue depth, retries, dead letters), JSON log พร้อม `request_id` ข้าม api → worker → mock-game | ✅ |
| | OpenTelemetry / Jaeger | ❌ |
| Security [8.4] | OTP sign-in, session ฝั่ง server, CSRF (SameSite=Strict + Origin allowlist), rate limit บน track / OTP / admin login, IDOR → 404, PII masking, security headers + nonce CSP, admin RBAC | ✅ |
| Admin | ตารางออเดอร์พร้อมตัวกรอง, รายละเอียด + timeline, dialog refund 2 ขั้น, retry fulfillment (API), superadmin แก้ไขสินค้า | ✅ |
| | Live dashboard | ❌ |
| | หน้า UI reconciliation | ❌ (มีแค่ API: `POST /api/v1/admin/reconciliation`) |
| Frontend [9.2] | แคตตาล็อก, checkout (ค่าธรรมเนียมสด, โค้ดส่วนลด, ตรวจ Game UID), tracking ด้วย SSE + `aria-live`, My Orders (OTP), dark mode, `prefers-reduced-motion` | ✅ |
| | WCAG 2.2 AA / 320 px / checkout ด้วยคีย์บอร์ดอย่างเดียว | ⚠️ สร้างโดยคำนึงถึงเรื่องเหล่านี้ แต่ยังไม่ได้ audit อย่างเป็นทางการ |
| | หน้าสินค้า `/products/[slug]` พร้อม JSON-LD และ OG image แบบ dynamic | ❌ |
| | i18n `/th` `/en` + hreflang | ❌ (ภาษาไทยอย่างเดียว) |
| | SSG/ISR | ❌ โดยตั้งใจ: nonce CSP ต้อง render ต่อ request ดู [SEO.md](SEO.md) |
| | Lighthouse | ❌ ยังไม่ได้วัด |
| Design [9.1] | Claude Design export ใน `design/` (HTML + PDF) | ❌ ยังไม่มีไฟล์ export (มีแค่ brief) |
| SEO | robots.txt, sitemap.xml ไม่มีหน้าส่วนตัว, meta `noindex` + `X-Robots-Tag` บน track / my-orders / admin | ✅ |
| Testing และ CI | Unit, integration (Postgres/Redis จริง), e2e ผ่าน audit script, `make test`, GitHub Actions 6 job | ✅ |
| | Playwright browser E2E, contract test | ❌ |
| | seed 100k ออเดอร์ + วัด p95 | ❌ |
| Bonus | Mobile app, deploy | ❌ |

## Configuration ที่สำคัญ

คัดลอก `.env.example` เป็น `.env` เฉพาะเมื่อต้องการ override ค่า default

| ตัวแปร | Default | ทำไมสำคัญ |
|---|---|---|
| `COOKIE_SECURE` | `true` | Session cookie เป็น `Secure` เบราว์เซอร์ยังเก็บไว้บน `http://localhost` **ถ้าเปิดเว็บด้วย IP หรือ hostname อื่นผ่าน http ธรรมดา ให้ตั้งเป็น `false`** ไม่เช่นนั้นการ login จะไม่ติด |
| `APP_ENV` | `development` | `test` เปิดใช้ `POST /api/v1/_test/reset` (และ reset ของ mock-pay) ค่าอื่นจะลบฟังก์ชัน reset ออกจาก DB |
| `CSRF_ALLOWED_ORIGINS` | `http://localhost:8080,http://localhost:3000` | Origin ที่อนุญาตให้ส่ง request พร้อม cookie สคริปต์ที่ใช้ cookie ของ admin ต้องส่งค่าใดค่าหนึ่งนี้เป็น `Origin` |
| `ORDER_TTL_SECONDS` | `900` | ช่วงเวลาชำระเงินก่อนเป็น EXPIRED |
| `FAIL_RATE`, `TIMEOUT_RATE`, `SUCCESS_BUT_TIMEOUT_RATE`, `LATENCY_MS` | `0` | การฉีด fault ของ mock-game |

**ทุก secret ใน `docker-compose.yml` / `.env.example` เป็นค่าทดสอบ และต้องเปลี่ยนก่อน
deploy จริง:** `PAYMENT_WEBHOOK_SECRET`, `ORDER_EVENTS_TOKEN_SECRET`,
`OTP_HASH_SECRET`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` และรหัสผ่าน admin ที่ seed ไว้ ไม่มี
`.env` ถูก commit

<a id="known-limitations-and-accepted-trade-offs"></a>
## ข้อจำกัดที่ทราบและ trade-off ที่ยอมรับ

- **Worker ตัวเดียว** Compose รัน worker ตัวเดียว งานถูก claim ด้วย `FOR UPDATE SKIP LOCKED` และ
  fence ด้วย `(id, attempts)` แต่ยังไม่ได้ทดสอบการรัน 2 worker ADR 0002 หัวข้อ "What remains"
  อธิบายช่วง stall ที่มีแต่ผู้ให้บริการที่มี idempotency จริงเท่านั้นจะปิดได้
- **mock-pay เชื่อ `paid_satang` สำหรับการชำระที่ตัวเองไม่เคยเห็น** ผู้ตรวจเซ็น webhook เอง
  worker จึงส่งยอดที่ชำระไปพร้อมทุก refund และ mock-pay จะบันทึกยอดนั้นถ้าไม่มีการชำระของออเดอร์นั้น
  ยอมรับได้เพราะเป็นแค่ mock เท่านั้น (ADR 0002)
- **Rate limit fail open เมื่อ Redis ล่ม** (track, admin login ต่อ IP) การล็อก OTP และการล็อก
  admin login ต่ออีเมลอยู่ใน Postgres จึงยังทำงาน (ADR 0005)
- **การค้นหาของ admin เป็น exact match** (เลขออเดอร์หรืออีเมลเต็ม) ค้นหาบางส่วนไม่ได้
- **latency ใน `/metrics` เป็นต่อ instance** ให้ scrape `api-1` และ `api-2` แยกกัน gauge ที่มาจาก DB
  มีค่าเท่ากันทั้งสองตัว
- **Postgres ล่มนานจะทำให้ webhook ของผู้ให้บริการหายหลัง retry หมด** mock-pay retry 8 ครั้ง
  แบบ exponential backoff (รวมประมาณ 4 นาที) หลังจากนั้น reconciliation จะรายงานการชำระเป็น
  `MISSING_IN_SYSTEM` และต้องจัดการด้วยมือ ([RUNBOOK](RUNBOOK.md#reconciliation-mismatch))
- **NEEDS_REVIEW → COMPLETED ไม่มี admin endpoint** transition นี้มีอยู่ใน state machine;
  ตอนนี้ operator ทำผ่าน SQL ([RUNBOOK](RUNBOOK.md#orders-stuck-in-needs_review))
- **ปัญหาความปลอดภัยระดับต่ำที่ยังไม่แก้:** open redirect ผ่าน `return_url` ของ mock-pay
  (เฉพาะ mock); webhook parse JSON ก่อนตรวจ signature (จำกัด body ไว้ 100 kb)
- **`docker kill` จะไม่ถูก restart** โดย `restart: unless-stopped`; ใช้ `docker compose start <service>`
- `apps/api/README.md`, `apps/worker/README.md` และ `apps/web/README.md` ส่วนใหญ่ยังเป็นข้อความ
  starter ของ framework; เอกสารที่ root คือแหล่งอ้างอิง
