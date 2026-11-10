# บันทึกการใช้ AI (AI Log)

## วิธีใช้ AI (How AI was used)

ทั้งโปรเจคสร้างด้วย Claude Code: session orchestrator หนึ่งตัวที่แบ่งงาน และ sub agent แปดตัวที่นิยามไว้ใน
`.claude/agents/` ทุกตัวได้รับ brief จาก `CLAUDE.md` (กฎของโปรเจค, ตัวเลขที่ต้องตรงเป๊ะ, เงื่อนไขตก) และ `docs/SPEC.md`

| Agent | ใช้สำหรับ |
|---|---|
| `domain-engineer` | pricing, checksum เลขออเดอร์, state machine, schema และ migration, การสร้างออเดอร์ |
| `payments-fulfillment-engineer` | webhook, mock-pay, mock-game, worker, outbox, retry/DLQ, refund, reconciliation |
| `platform-engineer` | docker compose, nginx, real-time ข้าม replica, health/metrics/logs |
| `frontend-engineer` | หน้า Next.js, SSE UI, a11y, SEO พื้นฐาน |
| `test-engineer` | unit, integration, e2e runner, CI |
| `invariant-auditor` | พยายามทำลาย invariant ด้านเงิน/ของอย่างอิสระด้วย concurrency จริง (`scripts/audit/invariants.mjs`); ไม่อนุญาตให้แก้โค้ด production |
| `security-reviewer` | ตรวจอิสระเรื่อง IDOR, enumeration, OTP, session/CSRF, headers, PII (`scripts/audit/security.mjs`); ไม่อนุญาตให้แก้โค้ด production |
| `docs-writer` | README, ARCHITECTURE, ADR, RUNBOOK, SEO.md และไฟล์นี้ |

วิธีตรวจผลงาน:

- **ไม่รับคำว่า "ผ่านแล้ว" ของ agent ตัวไหนโดยไม่ตรวจ** orchestrator รัน test ของทุก agent, compose build และ
  audit script ใหม่เองก่อนรับแต่ละ stage หลายครั้งจาก fresh clone ที่ไม่มี `.env` หลายรายการด้านล่างพบด้วยวิธีนี้
- **auditor และ security reviewer ทำงานอิสระ** จาก agent ที่เขียนโค้ด และเขียน script ของตัวเอง
  ความล้มเหลวที่พบถูกส่งกลับไปให้ agent เจ้าของเป็น bug
- **Prompt สำคัญ** คือ brief ของ agent ใน `.claude/agents/*.md` และ `CLAUDE.md`: "Postgres is
  the truth, Redis may vanish", "concurrency is solved in the DB, not in process memory",
  "anything external can repeat, reorder or disappear", "never a float for money", "report only
  results you actually ran" แต่ละ stage brief ปิดท้ายด้วยเกณฑ์ done ที่ชัดเจน (คำสั่งที่ต้องผ่าน) แทนคำอธิบายโค้ด

## Claude Design handoff เทียบกับโค้ด (Claude Design handoff vs. code)

ใน repo ไม่มี Claude Design export หรือ handoff bundle (`design/` ไม่มีอยู่) จึงไม่มีดีไซน์ให้เทียบ
UI token อยู่ใน `apps/web/src/app/globals.css` (light และ dark ผ่าน `prefers-color-scheme`) เรื่องนี้ระบุว่ายังไม่ทำใน README

## ความผิดพลาดของ AI ที่จับได้ (AI mistakes caught)

AI เสนออะไร ทำไมผิด จับได้อย่างไร แก้อย่างไร จัดกลุ่มตาม stage ตามลำดับการสร้าง
ทุกรายการเดิมคงไว้ไม่เปลี่ยน (เพิ่มหมายเหตุการแก้ภายหลังหนึ่งรายการ)

### P0 scaffold

- **P0 scaffold, flag ของ `docker compose`:** agent รัน `docker compose up --build -d --progress plain` Compose ปฏิเสธด้วย `unknown flag: --progress` เพราะ `--progress` เป็น global flag ไม่ใช่ flag ของ `up` รอบที่ล้มไม่ได้ build อะไรเลย รอบ acceptance ใช้ `docker compose up --build -d` ตามเดิมพร้อม `BUILDKIT_PROGRESS=plain`

### P1 domain, database และ orders

- **P1 domain, type ของแหล่งสุ่มเลขออเดอร์:** agent กำหนด type ของ random callback เป็น `Uint8Array` ธรรมดา unit test ทั้ง 161 ตัวผ่านเพราะ vitest ไม่ typecheck แต่ `tsc` ปฏิเสธด้วย TS2345 เทียบกับ `getRandomValues` ตอนนี้ type คือ `Uint8Array<ArrayBuffer>` นี่คือเหตุผลที่รัน typecheck ควบคู่กับ test
- **P1 db, ค่าคาดหวังผิดใน proof 100 คู่:** proof script ของ agent คาดว่าคู่สถานะ 77 จาก 100 คู่จะถูก trigger ปฏิเสธ ผลจริงคืออนุญาต 23, ปฏิเสธ 67 และไม่ถูกปฏิเสธ 10 ทั้ง 10 เป็น update สถานะเดิม ซึ่งไม่เปลี่ยนอะไรและไม่เขียน event trigger จึงไม่มี transition ให้ปฏิเสธ trigger ถูก ค่าคาดหวังผิด domain layer ยังปฏิเสธการย้ายไปสถานะเดิมใน `assertTransition`
- **P1 orders, เพดาน connection ของ nginx:** scaffold ทิ้ง `events {}` ไว้ใน `nginx.conf` nginx จึงใช้ค่า default 512 connection ต่อ worker รอบทดสอบ oversell 400 request แรกตายด้วย `ECONNRESET` และรอบซ้ำนับได้ 138 จาก 400 request ถูก proxy reset burst ภายใน compose network ก็ reset เช่นกัน จึงตัดเรื่อง port forward ของ Docker Desktop ออก stock ถูกต้องตลอด ขายได้ 100 พอดี จึงไม่มี test ที่ดูข้อมูลออเดอร์จับเรื่องนี้ได้ ตอนนี้ `worker_connections` เป็น 8192 และ 1000 request ขนานได้คำตอบครบ
- **P1 orders, test ที่เขียนผ่าน script:** agent เพิ่ม domain test ด้วยการเขียนไฟล์ใหม่จาก Python script และ escaped `
` กลายเป็นการขึ้นบรรทัดจริงภายใน string literal `tsc`, `oxlint` และ vitest ปฏิเสธไฟล์ด้วย parse error ในการตรวจครั้งถัดไป ก่อนที่จะ commit อะไร ตอนนี้สร้างค่าด้วย `String.fromCharCode(10)`
- **P1 orders, รูปแบบ error ที่ proxy:** รอบแรกของ request ผิดรูปแบบ 58 ตัวล้ม 3 ตัว `%00` หรือ percent sequence ที่เสียใน path ไม่ถึง API เพราะ nginx ปฏิเสธด้วยหน้า HTML 400 ของตัวเอง กฎ "รูปแบบ error เดียว" จึงไม่เป็นจริงที่ proxy ถ้าทดสอบ API อย่างเดียวจะพลาดเรื่องนี้ ตอนนี้ `nginx.conf` ตอบ problem+json สำหรับ error ที่มันสร้างเอง
- **P1 orders, การแก้ครั้งแรกสำหรับ error ของ proxy:** การแก้ครั้งแรกของ agent ใช้ `error_page 400` กับ named location รอบเต็มถัดไปแสดงว่าแย่ลง: 3 request เดิมเปลี่ยนจาก HTML 400 เป็น HTML 500 ขณะที่ 503 สำหรับ API ที่หยุดอยู่ทำงานได้ named location เสิร์ฟ request ที่ nginx ปฏิเสธ URI ไปแล้วไม่ได้ ตอนนี้ config redirect ไปยัง URI จริง ซึ่งลองใน container ทิ้งก่อนรันรอบเต็มอีกครั้ง

### P1 payments, worker, refunds และ reconciliation

- **P1 mock-pay, เลขคณิตของ restart test:** restart test แรกของ agent ใช้ backoff base 50 ms ลำดับ retry ทั้งหมดจึงต้องใช้ราว 12.75 s แต่ test รอแค่ 8 s และล้มด้วย timeout server ถูกต้อง ตอนนี้ test ใช้ base 20 ms ของ suite (ราว 5.1 s) และตรวจ backoff default จริงกับ image ที่ build แล้วด้วย
- **P1 worker, reference เดียวต่อออเดอร์:** schema และแผนเดิมมี `reference` เดียวและสำเร็จครั้งเดียวต่อออเดอร์ แต่ `POST /topups` รับหนึ่ง sku การส่งแต่ละบรรทัดของออเดอร์สองบรรทัดด้วย reference เดียวกันจะทำให้ `/stats` แสดง 2 ซึ่งอ่านได้ว่าเติมซ้ำ agent จับได้ตอนอ่าน `mock-game` ก่อนเขียน worker ตอนนี้ reference คือ `<order_id>:<sku>` และ migration 0006 เปลี่ยน unique index ให้ตรงกัน
- **P1 worker, ตัวแปร PL/pgSQL ชื่อซ้ำกับคอลัมน์:** draft แรกของ `release_order_holds` มี `WHERE code = code` โดยมีตัวแปรชื่อ `code` agent สังเกตได้ตอนอ่านซ้ำก่อน migration จะรัน ตอนนี้ตัวแปรชื่อ `v_code`
- **P1 refund, build ล้มที่ถูก `tail` ซ่อน:** การแก้ `refunds.service.ts` ด้วย script ลงไปแค่บางส่วน image ของ API จึง compile ไม่ผ่าน agent pipe `docker compose up --build` ผ่าน `tail -1` ซึ่งซ่อนความล้มเหลว และ container เก่ายังรันอยู่ test รอบเต็มผ่านกับโค้ดเก่า response ที่บอก `at most 0 satang` ซึ่งเป็นข้อความที่ agent เพิ่งลบไป เผยความจริง ตอนนี้ helper script รายงาน exit code ของ compose และผลทุกตัวถูกเก็บใหม่หลัง rebuild
- **P1 reconciliation, upload ขนาดเกิน:** รอบ input ผิดรูปแบบได้ HTML 413 ราวหนึ่งในสามครั้ง API ตอบทันทีที่ไฟล์เกิน 10 MB ซึ่งปิด connection กลางการ upload nginx จึงมองว่า upstream เสียและไปที่ error location ซึ่ง body limit default 1 MB สร้าง 413 ของตัวเอง รอบเดียวอาจผ่านได้เพราะโชค ตอนนี้ API อ่านจนจบก่อนตอบ และตั้ง limit สำหรับทั้ง server block รอบซ้ำสี่รอบสะอาด
- **P1 refund, acceptance ที่จ่ายผ่าน mock-pay อย่างเดียว:** refund test ทั้งหมดของ agent จ่ายที่ mock-pay และผ่าน รายงานจึงบอกว่า refund ขนาน 6 จาก 24 ถูกรับ สเปกบอกว่าทีมตรวจยิง webhook เอง script แยกของ orchestrator จ่ายด้วย signed webhook แทน: mock-pay ตอบ `PAYMENT_NOT_FOUND` แต่ละ refund กลายเป็น `FAILED` และคืนโควตา และ 24 จาก 24 ได้ 202 ขณะที่ออเดอร์ย้ายไป `NEEDS_REVIEW` ไม่มีเงินเคลื่อน จึงไม่ใช่ over-refund แต่ flow refund ใช้ไม่ได้กับออเดอร์ที่จ่ายแบบนั้น ตอนอ่านครั้งแรก แถวรวม 120000 satang ดูเหมือน over-refund คอลัมน์สถานะ refund ยืนยันว่าไม่ใช่ ตอนนี้การตรวจนับเฉพาะแถวที่ไม่ใช่ `FAILED`
- **P1 refund, การจับคู่ด้วยยอดเท่ากัน:** refund check 43 ตัวและ worker crash check ของ agent ผ่านทั้งหมด แต่ audit พบ refund ค้าง `PENDING` หลัง `docker kill worker` webhook `payment.refunded` ไม่ระบุ refund `settle_refund` จึงจับคู่ด้วยยอดและอาจ settle แถวที่ไม่เคยส่ง แถวที่ส่งจริงจึงได้ `already_settled` และ job ปิด เงินยังไม่เกินยอดที่จ่าย การตรวจ over-refund จึงผ่าน แต่ลูกค้าได้ไม่ครบ reconciliation ก็รายงาน 0 mismatch orchestrator ทำซ้ำได้จาก fresh clone ด้วย `--only s3`: ผ่าน 14 ล้ม 3 ยังไม่ได้แก้ ณ เวลาที่เขียนบันทึกนี้ **แก้ภายหลัง:** ทุก refund job ส่ง `refund_id` ของตัวเองเว้นแต่แถวเป็น FAILED (ADR 0002 หัวข้อ "Refunds") `--only s3` และ invariant audit เต็มผ่านตั้งแต่นั้น
- **P1 refund fix, test module ไม่ได้อัปเดต:** agent เพิ่ม `MockPayResetClient` ใน reset controller และ `AppModule` แต่ไม่ได้เพิ่มใน module เล็กใน `http-contract.spec.ts` lint และ typecheck ผ่าน vitest ทำให้ worker crash ด้วย Nest initialization error test 9 ตัวในไฟล์นั้นไม่ได้รัน แต่ summary ยังบอก "99 passed" ตอนนี้ spec provide client เป็น mock และตรวจว่าไม่มีอะไรถูกล้างเมื่อ reset mock-pay ไม่ได้
- **P1 mock-pay, test ที่สมมติลำดับการส่ง:** test ที่เขียนใน stage ก่อนอ่าน `calls[2]` เป็น payment webhook แต่ refund webhook จากขั้นก่อนหน้าถูกส่งในเวลาเดียวกัน ผ่านเมื่อรันเดี่ยว และล้มราว 1 ใน 2 รอบของ `pnpm -r test` เต็ม ตอนนี้ test หา webhook ด้วย `order_id`
- **P1 refund fix, SQL integration test แรก:** draft แรก insert ออเดอร์โดยไม่มี `app.actor`/`app.reason` ซึ่ง status trigger ต้องการ และใช้อีเมลเดียวกับทุก SAVE10 redemption ซึ่ง unique index ต่ออีเมลปฏิเสธ test 4 จาก 5 ล้มด้วยเหตุ setup ก่อน logic ของ refund จะรัน แก้ทั้งสองอย่างใน test ไม่ใช่ใน schema

### Clean clone และ audit script

- **Clean clone, typecheck ก่อน build:** `pnpm -r typecheck` ล้มด้วย TS2307 บน fresh clone เพราะแอปอ่าน `@inblack/domain` จาก `dist` และยังไม่มีอะไร build มัน การตรวจก่อนหน้าทุกครั้งรันใน container ที่ build ไปแล้ว มีแต่ clean clone ที่แสดงปัญหานี้ ตอนนี้ `typecheck` ของ domain package emit output ด้วย และ pnpm รันมันก่อนแอป
- **Audit script, เวอร์ชันแรกที่อ่อน:** script แรกของ auditor มี 3 pass ที่พิสูจน์ได้น้อยเกินไป: ทุก request ไปลง replica เดียว, การ kill มาหลังงานจบแล้ว และไม่มีออเดอร์ไหนถึง `FAILED` auditor แก้ทั้งสามข้อ และรอบสุดท้ายรายงานว่า request แบ่งระหว่าง replica อย่างไร และมีกี่ออเดอร์อยู่ใน `IN_PROGRESS` ตอนแต่ละ kill

### Web UI stage

- **Web UI stage, สมมติลำดับ timeline จาก API:** `Timeline` ของ agent แสดง event ตามลำดับที่ได้รับ หน้าลูกค้าถูกเพราะ SSE hook เรียงตาม event id แต่การตรวจใน browser ครั้งแรกของหน้า admin detail แสดง `COMPLETED` อยู่เหนือ `order.created`: `GET /admin/orders/{id}` ไม่ได้รับประกันลำดับ ตอนนี้ `Timeline` เรียงตาม bigint event id เอง
- **Web UI stage, commit ที่มีแต่การลบ:** `git add` ครั้งแรกของ agent ระบุไฟล์ที่ลบไปแล้วด้วย `git rm` git จึงปฏิเสธทั้งรายการ และ commit ได้แค่การลบที่ stage ไว้ `git show --stat` จับได้ก่อน commit อื่น และ commit นั้น (local ยังไม่ push) ถูก amend ด้วยไฟล์ที่ตั้งใจ

### Security stage

- **Security stage, OTP race ที่ล็อกผู้ชนะ:** `decideVerify` แรกของ agent นับทุกรหัสที่ถูกปฏิเสธเป็นการเดาผิด รวมถึงรหัสที่ถูกซึ่งส่งซ้ำหลังใช้แล้ว unit test ผ่านเพราะ verify ทีละ request รอบแรกของ `scripts/audit/security.mjs` ส่ง verify 10 ครั้งพร้อมกันด้วยรหัสที่ถูก: ได้ session แถวเดียวตามที่ต้องการ แต่คำตอบคือ `[200, 401×4, 429×5]` ตัวที่แพ้จึงล็อกอีเมล 15 นาทีทันทีหลัง sign in การกดปุ่มสองครั้งก็ทำแบบเดียวกัน ตอนนี้รหัสที่ถูกหลังใช้แล้วหรือหมดอายุถูกปฏิเสธโดยไม่นับ (เฉพาะคนที่มีรหัสเท่านั้นที่ส่งได้) unit test ส่งซ้ำอีก 9 ครั้งและตรวจว่าตัวนับยังเป็น 0 และ audit แสดง `[200, 401×9]`
- **Security stage, track rate limit กับ audit ที่มีอยู่:** เพดาน 10/min/IP ใหม่บน `/orders/track` จะทำให้ `scripts/audit/sse.mjs` ล้ม เพราะมันเรียก track หนึ่งครั้งต่อออเดอร์ (ราว 11 ครั้งต่อนาที) จาก IP เดียว agent นับจำนวนการเรียกก่อนรัน ตอนนี้ SSE audit รอให้ 429 ผ่านไปตาม `Retry-After` เหมือน client จริง ไม่มี stream check ไหนถูกทำให้อ่อนลง
- **P2 security, case-sensitive routing ที่ไม่มีผล:** การแก้ `/METRICS` ครั้งแรกของ agent ตั้ง `case sensitive routing` ของ Express หลัง `NestFactory.create` Express สร้าง router ตอนใช้ครั้งแรก ซึ่งเกิดไปแล้ว การตั้งค่าจึงถูกเพิกเฉย unit test ใหม่ (`metrics-path.spec.ts`) ได้ 200 สำหรับ `/METRICS`, `/Metrics` และ `/metricS` ตอนนี้ `configureHttp` ตั้ง `caseSensitive` บน router เองด้วยก่อน `init()` จะเพิ่ม route nginx ปฏิเสธทุกการสะกดอยู่แล้ว
- **P2 security, line ending จาก script บน Windows:** การแก้ด้วย Python ที่รันบน Windows เขียน CRLF ลงในไฟล์ source LF สี่ไฟล์ `git diff` เตือนก่อน commit และไฟล์ถูกแปลงกลับ

### P2 real-time และ platform

- **P2 SSE, เรียง event เป็น text:** query event ของ agent select `id::text AS id` และจบด้วย `ORDER BY id` ซึ่ง Postgres ตีความเป็น text alias event 10 จึงเรียงก่อน event 9 guard กันซ้ำของ stream จึงทิ้ง 9 unit test ใหม่ผ่านทั้งหมดเพราะใช้ source ในหน่วยความจำ และ scenario แรกของ SSE audit ก็ผ่านเพราะออเดอร์มี id 1 ถึง 5 scenario reconnect ของ `scripts/audit/sse.mjs` ล้ม: resume จาก Last-Event-ID 8 คืนแค่ event 10 ตอนนี้ query เรียงด้วย `e.id` ซึ่งเป็นคอลัมน์ bigint และ audit เดียวกันผ่าน 10 จาก 10
- **P2 readiness, Redis client ที่ retry ทุกวินาที:** check P2 ทั้งหมดและ `sse.mjs` ผ่าน แต่ invariant audit เต็มล้ม 2 จาก 76 ใน `s7`: ทุก refund ได้ `503 DATABASE_UNAVAILABLE` ขณะ Redis ถูก kill หลัง `timeout exceeded when trying to connect` 10 s บนทั้งสอง replica ในเวลาเดียวกัน โดยไม่มีอะไรใน log ของ Postgres agent เพิ่ม Redis client สองตัวต่อ API (stream signal และ `/readyz`) ที่ reconnect ทุกวินาที เมื่อ Redis container หายไป การ lookup `redis` ใช้ 5011 ms (`EAI_AGAIN` วัดใน api-1) และ lookup รันใน thread pool 4 thread ของ libuv การ connect Postgres จึงต่อคิวข้างหลัง ตอนนี้ `/readyz` ping บน signal connection, reconnect back off ไปที่ 3 s (5 s ใน worker relay) และ compose ตั้ง `UV_THREADPOOL_SIZE=16` สำหรับ api และ worker
- **P2 platform, แก้ผ่าน shell one-liner:** agent แก้ `nginx.conf` และไฟล์ TypeScript สองไฟล์ด้วย inline `node -e` script ใน bash bash ขยาย `$host`, `$request_id` และ template literal ก่อนที่ node จะเห็น ทิ้งบรรทัด `proxy_set_header Host ;` และ `const requestId = ... : ;` ไว้ในไฟล์ agent เห็นความเสียหายใน diff output ก่อน build หรือ commit และแก้ใหม่ด้วย editor tool

- **Final audit, host sleep ถูกอ่านเป็น bug:** final audit เต็มล้ม `s7/refund-redis-down` ด้วยการปฏิเสธ 20 ครั้ง (`409 ORDER_NOT_REFUNDABLE`) orchestrator สงสัย expiry worker ก่อน เพราะออเดอร์หนึ่งดูหมดอายุก่อน `expires_at` 37 s ออเดอร์นั้นเป็นตัวอย่างที่ผิด: audit script เองเขียน `expires_at` ใหม่ด้วย `expireNow()` จากนั้น auditor พบสาเหตุจริงใน Windows System log: laptop เข้า Modern Standby ตั้งแต่ 12:45:59 ถึง 13:09:05 และแช่แข็งทุก container 23 นาที เกิน TTL 900 s เป้าหมาย refund หมดอายุ การจ่ายช้าของพวกมันถูก refund อัตโนมัติครั้งเดียวต่อออเดอร์ (ADR 0004) และ 409 ถูกต้อง ตอนนี้ script เลือกเป้าหมาย refund จากออเดอร์ที่ `COMPLETED` จริงในฐานข้อมูล และล้มถ้าไม่มีเลย รอบรันใหม่บน fresh clone ที่ `75ea4df` ได้ 76 passed, 0 failed

### Redesign API stage

- **Integration test สมมติ id ของ seed:** `admin-username.int.spec.ts` แรกคาดว่าบัญชี role ทั้งสี่อยู่ที่ id 1 ถึง 4 และ `Admin` ที่ id 5 บนฐานข้อมูลใหม่ migration 0011 รันก่อน seed `Admin` จึงได้ id 1 และ test ล้ม ไม่มีอะไรอ่าน admin id เป็นตัวเลข (ตรวจแล้ว) ตอนนี้ test เรียงตามอีเมลแทนการเปลี่ยน migration
- **Live-stack check ที่อาจล้างข้อมูล:** ระหว่างตรวจทุก route กับ stack ที่รันอยู่ agent ใส่ `POST /api/v1/_test/reset` ลงใน batch ของ curl ที่ยิงไปยัง stack ที่ผู้ใช้เปิดอยู่ permission check ปฏิเสธ batch ก่อนรัน route check ที่เขียนข้อมูลจึงปล่อยให้ unit และ integration test ทำ และรายงานระบุว่า route ไหนไม่ได้เรียกแบบ live
