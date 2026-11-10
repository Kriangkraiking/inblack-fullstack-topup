# ADR 0005: Session ลูกค้า, CSRF และ rate limit

สถานะ (Status): Draft สร้างใน `apps/api/src/customer-auth/` และ `apps/api/src/security/` พิสูจน์ด้วย `scripts/audit/security.mjs`

## บริบท (Context)

สเปกข้อ 8.4 ต้องการ OTP sign-in (6 หลัก, 5 นาที, ผิด 5 ครั้งล็อก 15 นาที, ใช้ครั้งเดียว), session cookie แบบ httpOnly + Secure + SameSite, การป้องกัน CSRF สำหรับ request ที่เปลี่ยนข้อมูล, rate limit บน `/orders/track` (10/min/IP, 5/min/order id, 429 พร้อม Retry-After) และคำตอบเดียวกันสำหรับ "ไม่มีออเดอร์นี้" กับ "อีเมลผิด" API รันสอง replica หลัง nginx จึงไม่มีอะไรอยู่ในหน่วยความจำของ process เดียวได้

## การตัดสินใจ (Decisions)

### Session

- session ลูกค้าเป็นแถวฝั่ง server ใน `customer_sessions` แยกจาก `admin_sessions` (migration 0009) token ของลูกค้าจึงไม่มีทางถูกอ่านเป็นของ admin เก็บเฉพาะ SHA-256 ของ token ขนาด 32 bytes
- cookie `inblack_session` และ `inblack_admin_session`: `HttpOnly; SameSite=Strict; Path=/`, `Secure` เมื่อ `COOKIE_SECURE=true` **Compose และ `.env.example` ตั้งเป็น true** (ผู้ใช้ตัดสินหลัง security review; เดิม default เป็น false) browser ถือว่า `http://localhost` เป็น secure context และเก็บ Secure cookie ไว้ได้ web app บน :3000 ที่เรียก API บน :8080 จึงยัง sign in ได้ ส่วน script ส่ง cookie ใน header `Cookie` เอง flag นี้จึงไม่กระทบ ตั้งเป็น false เฉพาะเมื่อเสิร์ฟ http ธรรมดาบน host อื่นที่ไม่ใช่ localhost ถ้าไม่ตั้งตัวแปร (รัน `node dist/main` นอก compose) ยังหมายถึง false

### OTP

- รหัสมาจาก `crypto.randomInt` เก็บเป็น HMAC-SHA256(`OTP_HASH_SECRET`, email + code) เพราะ hash ธรรมดาของรหัส 6 หลักย้อนกลับได้ด้วยการลองล้านรหัส
- ตัวนับและการล็อกอยู่ใน Postgres (`customer_otps`) ไม่ใช่ Redis การล็อกจึงยังทำงานเมื่อ Redis ล่ม verify หยิบแถวด้วย `SELECT ... FOR UPDATE` ตัดสินใน pure function (`decideVerify`) และ commit จำนวนครั้งที่ผิดก่อนตอบ เส้นทางสำเร็จยังใช้ conditional `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()` verify สิบครั้งพร้อมกันด้วยรหัสที่ถูกได้ session เดียว (audit `otp/race`)
- รหัสผิดขณะที่รหัสที่เก็บไว้ใช้ไปแล้วหรือหมดอายุนับเป็นความล้มเหลว แต่รหัสที่ถูกส่งซ้ำหลังใช้แล้วไม่นับ: เฉพาะคนที่มีรหัสเท่านั้นที่ส่งได้ และการกดซ้ำต้องไม่ล็อกคนที่เพิ่ง sign in รอบ audit แรกจับเรื่องนี้ได้ ดู AI_LOG
- การขอรหัสใหม่ไม่รีเซ็ตจำนวนครั้งที่ผิด และไม่เก็บหรือส่งรหัสขณะถูกล็อก การล็อกยังทิ้งรหัสด้วย
- `POST /auth/otp/request` ตอบ 202 ด้วย body เดียวกันสำหรับทุกอีเมลที่ valid ไม่ค้นหาออเดอร์ และส่งอีเมลเบื้องหลัง ทั้ง body และเวลาตอบจึงไม่ขึ้นกับที่อยู่อีเมล Postgres ยอมให้รหัสใหม่หนึ่งรหัสต่ออีเมลต่อ 30 s

### เพดานการ login ของ admin

ก่อน security review รหัสผ่าน admin เดาได้ไม่จำกัด ตอนนี้ตรวจก่อนที่ `verifyPassword` จะรัน:

- **ต่อ IP: 10 ครั้งต่อนาที** ใช้ Redis fixed window แบบเดียวกับ track นับก่อน parse body ถ้า Redis ล่มจะ fail open เหมือนเพดานต่อ IP อื่น ๆ
- **ต่ออีเมล: 5 ครั้งใน fixed window 15 นาที ใน Postgres** (`admin_login_attempts`, migration 0010) `admin_login_attempt()` นับครั้งใน upsert เดียวซึ่งถือ row lock สอง replica จึงปล่อยการเดาครั้งที่หกผ่านพร้อมกันไม่ได้ ครั้งที่ 6 เป็นต้นไปตอบ 429 `LOGIN_LOCKED` พร้อมวินาทีที่เหลือเป็น Retry-After **ไม่ fail open**: ถ้า Postgres ล่ม login ก็ล้มอยู่แล้ว login สำเร็จจะลบแถว แถวใช้ key เป็น SHA-256 ของอีเมลที่ normalise แล้ว window ที่จบแล้วถูกลบเมื่อมีใครพยายามครั้งถัดไป
- อีเมลที่ไม่รู้จักถูกนับและล็อกเหมือนอีเมลจริงทุกประการ และ 401 `INVALID_CREDENTIALS` มี bytes เดียวกันทั้งสองแบบ คำตอบจึงไม่เผยว่ามี admin คนนั้นหรือไม่
- Trade-off: ใครก็ล็อกอีเมล admin ที่รู้จักได้ 15 นาทีด้วยรหัสผิด 5 ครั้ง ยอมรับได้สำหรับ back office ที่มีสี่บัญชี เพดานต่อ IP ช่วยชะลอ และการปลดล็อกรายบัญชีต้องมีหน้าจัดการผู้ใช้ admin ซึ่ง release นี้ยังไม่มี
- **Sign in ด้วย username** (migration 0011 ขอมาสำหรับ admin dashboard ที่ redesign): `POST /admin/auth/login` รับ `{ login, password }` โดย `login` เป็นอีเมล (มี `@`) หรือ username และยังรับ `{ email, password }` แบบเดิม username ต้องตรง `^[A-Za-z0-9._-]{1,64}$` เทียบแบบไม่สนตัวพิมพ์ และ unique บน `lower(username)` การพยายามด้วย username นับใต้ key ของตัวเอง (SHA-256 ของ username ตัวพิมพ์เล็ก นับก่อน lookup ดังนั้น username ที่ไม่รู้จักถูกล็อกแบบเดียวกัน) **และ** เมื่อบัญชีมีอยู่จริง นับใต้ key อีเมลของบัญชีนั้นด้วย การสลับอีเมลกับ username จึงไม่ทำให้บัญชีเดียวได้เดาเกิน 5 ครั้งต่อ window 401 มี bytes เดียวกันสำหรับอีเมลที่ไม่รู้จัก, username ที่ไม่รู้จัก และรหัสผ่านผิด ยอมรับการรั่วเล็กน้อย: คนที่รู้อีเมลของ admin อยู่แล้วและล็อกมันไว้ จะรู้ได้ว่า username หนึ่งเป็นของบัญชีเดียวกันหรือไม่ (ตอบ 429 แทน 401)

Login และ `/auth/otp/verify` รับเฉพาะ `application/json` (ไม่เช่นนั้น 415 `UNSUPPORTED_MEDIA_TYPE`) สองตัวนี้ข้ามการตรวจ Origin เพราะไม่อ่าน cookie และ HTML form ข้ามเว็บสามารถ post แบบ urlencoded หรือ text/plain ได้โดยไม่มี preflight ซึ่งจะ sign browser ของเหยื่อเข้าบัญชีของผู้โจมตี (login CSRF) JSON จาก origin อื่นต้องผ่าน CORS preflight ซึ่ง allowlist ปฏิเสธ

### CSRF

SameSite=Strict กัน cookie ไม่ให้ไปกับ request ข้ามเว็บอยู่แล้ว เพิ่มจากนั้น `CsrfGuard` (global, ก่อน admin guard) ปฏิเสธด้วย 403 `CSRF_ORIGIN_MISMATCH` ทุก POST/PUT/PATCH/DELETE ที่มี session cookie เว้นแต่ header `Origin` อยู่ใน `CSRF_ALLOWED_ORIGINS` ตรงทุกตัวอักษร (default `http://localhost:8080,http://localhost:3000`) Origin ที่หายไปก็ถูกปฏิเสธ: browser ส่ง Origin ในทุก POST จึงมีแต่ client ที่ไม่ใช่ browser ที่ไม่ส่ง และ client แบบนั้นเพิ่มเองได้

ทำไมไม่ใช้ double-submit token: ต้องมี token endpoint, โค้ดฝั่ง client ในทุก request และการจัดการหมดอายุ SameSite=Strict บวก Origin allowlist แบบตรงตัวครอบคลุมการโจมตีเดียวกันสำหรับ browser ที่เรารองรับ โดย frontend ไม่ต้องทำอะไรนอกจากเรียกด้วย `credentials: 'include'` "Same site" อย่างเดียวไม่พอ เพราะ `localhost:3000` และ `localhost:8080` เป็น site เดียวกัน การตรวจ Origin แยกสองตัวนี้ออก

ยกเว้นด้วย `@SkipCsrf()` เพราะไม่เคยอ่าน cookie: payment webhook, `POST /orders`, `POST /orders/track`, `/auth/otp/*` CORS ใช้รายการ origin เดียวกันพร้อม credentials origin ที่อ่านคำตอบได้จึงเป็นชุดเดียวกับที่ส่ง request พร้อม cookie ได้

### Rate limit

- Fixed window หนึ่งนาทีใน Redis: Lua script เดียวทำ INCR และ PEXPIRE พร้อมกัน ทั้งสอง replica จึงใช้ตัวนับร่วมกันและไม่มี key ค้างโดยไม่มี expiry key เก็บ SHA-256 ของ subject ไม่ใช่ IP หรืออีเมล
- Client IP: nginx ตั้ง `X-Real-IP` และ `X-Forwarded-For` เป็น `$remote_addr` แทนที่ค่าที่ client ส่งมา (เดิมต่อท้าย X-Forwarded-For) API อ่าน X-Real-IP replica ไม่ได้ publish ออกนอก compose network จึงมีแต่ nginx ที่ตั้งได้ audit `track/spoof` แสดงว่า header จาก client ไม่รีเซ็ตตัวนับ
- Track นับ IP ก่อน parse และนับ order id หลัง parse request ที่ผิดรูปแบบจึงยังใช้โควตา IP
- **Redis ล่ม: fail open** limiter ปล่อย request ผ่าน โดยมี command timeout 300 ms และ warning ไม่เกินนาทีละครั้ง Track แค่อ่าน key ต่อออเดอร์ทำให้การเดาช้าขณะ Redis ปกติ และการปฏิเสธ tracking ทั้งหมดระหว่าง Redis ล่มจะทำให้ฟีเจอร์ลูกค้าล่มเพื่อแลกกับ control แบบ defence-in-depth ไม่มีอะไรที่ปกป้องเงินหรือการล็อก OTP พึ่ง Redis การส่ง OTP ยังถูกจำกัดหนึ่งครั้งต่ออีเมลต่อ 30 s โดย Postgres

### Enumeration บน track

ออเดอร์ที่ไม่รู้จักและอีเมลผิดรัน query เดียวกัน (`WHERE id = $1 AND email = $2`) และ throw `orderNotFound()` ตัวเดียวกัน audit เทียบ body ทีละ byte และเทียบ median ของ 60 request แต่ละแบบ (ต่างกันประมาณ 9%, เกณฑ์ 20%)

### การเปิดเผย (Exposure)

- ทุก port ที่ publish bind กับ 127.0.0.1 และ Redis ไม่ได้ publish เลย (ไม่มีอะไรบน host ใช้ integration test เริ่มตัวเอง) Postgres อยู่ที่ 127.0.0.1:5433 สำหรับ DB client บนเครื่อง
- nginx ปฏิเสธ `/metrics` ทุกรูปแบบการสะกดด้วย location แบบ regex ไม่สนตัวพิมพ์ และ API route path แบบสนตัวพิมพ์ (`configureHttp`) `/METRICS` จึงไม่ถึง handler แม้อยู่ใน network `server_tokens off`
- viewer ค้นรายการออเดอร์ admin ได้ด้วย order id เท่านั้น อีเมลใน `q` ตอบ 403 `EMAIL_SEARCH_FORBIDDEN` เพราะการค้นออเดอร์ด้วยอีเมลเต็มจะเปิดเผยผู้ซื้อที่รายการ mask ไว้

## ผลที่ตามมา (Consequences)

- client นอก browser ที่ใช้ session cookie (script, curl) ต้องส่ง Origin ที่อนุญาต `scripts/audit/invariants.mjs` ทำแบบนั้น
- frontend origin ของบุคคลที่สามต้องเพิ่มใน `CSRF_ALLOWED_ORIGINS`
- ถ้า web app proxy การเรียก API ผ่าน server ของตัวเองแทนการเรียก `:8080` จาก browser nginx จะเห็น address ของ web container และผู้ใช้ทุกคนจะใช้ rate limit bucket เดียวกัน browser ควรเรียก API โดยตรง
- ระหว่าง Redis ล่ม เพดาน track และเพดาน login admin ต่อ IP ไม่ถูกบังคับ แต่เพดาน login admin ต่ออีเมลและการล็อก OTP ยังทำงาน
- การรัน stack บน http ธรรมดาด้วยชื่ออื่นที่ไม่ใช่ localhost ต้องตั้ง `COOKIE_SECURE=false` ไม่เช่นนั้น browser จะทิ้ง session cookie
