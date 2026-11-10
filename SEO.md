# SEO

สั้นและตรงไปตรงมา: พื้นฐานการควบคุมการ crawl ทำไว้แล้ว ส่วนรายการ SEO ที่ลึกกว่าในโจทย์ข้อ 9.2/9.3
ยังไม่ได้ทำ

## สิ่งที่ทำแล้ว

- **`robots.txt`** (`apps/web/src/app/robots.ts`): `Allow: /` พร้อม URL ของ sitemap path ส่วนตัว
  **ไม่ได้** ใส่เป็น `Disallow` เพราะรายการ Disallow จะประกาศ path ที่เราไม่อยากให้ใครเจอ
  (`/admin`, หน้าออเดอร์) ออกไปตรง ๆ จึงกันไม่ให้ถูก index ด้วย `noindex` แทน
- **`sitemap.xml`** (`apps/web/src/app/sitemap.ts`): มีแค่ `/` และ `/checkout` ไม่มี `/track`,
  `/my-orders` หรือ `/admin`
- **`noindex` สองชั้นบนหน้าส่วนตัว:** `robots: { index: false, follow: false }` ใน metadata ของหน้า
  (track, my-orders, my-orders/[id], admin layout, admin/products) และ response header
  `X-Robots-Tag: noindex, nofollow` จาก `apps/web/next.config.ts` สำหรับ `/track`,
  `/my-orders/*` และ `/admin/*` ตรวจบน stack ที่รันอยู่ด้วย `curl -I` header นี้ยัง
  ครอบคลุม response ที่ไม่ใช่ HTML และหน้าที่ metadata อาจหายไประหว่าง refactor

## ทำไมหน้า tracking, my-orders และ admin ต้องไม่ถูก index

- **ข้อมูลส่วนบุคคล:** หน้าเหล่านี้แสดงรายการในออเดอร์, game UID และอีเมล (ที่ mask แล้ว) ผลการค้นหา
  คือสำเนาที่เราเรียกคืนไม่ได้
- **ไม่มีคุณค่าการค้นหา:** ไม่มีใครค้นหาออเดอร์ของคนอื่น หน้าเหล่านี้มีแต่เพิ่มหน้าบางและซ้ำ
- **Crawl budget:** URL เฉพาะออเดอร์ที่ไม่มีที่สิ้นสุดจะแย่งเวลา crawl ไปจากแคตตาล็อก
- **การเดาเลขออเดอร์:** การแสดงรายการหรือ index URL ออเดอร์จะเท่ากับแจกเลขออเดอร์ที่ใช้ได้จริง และ API
  ถูกออกแบบให้เลขออเดอร์ผิดหรืออีเมลผิดตอบ 404 เหมือนกัน (มี rate limit, ADR 0005)
  หน้า admin ต้อง login อยู่แล้ว การ index โครงหน้าของมันมีแต่บอกผู้โจมตีว่าควรลองที่ไหน

## สิ่งที่ยังไม่ได้ทำ

| รายการ | สถานะ |
|---|---|
| SSG/ISR สำหรับแคตตาล็อก | ไม่ได้ใช้ โดยตั้งใจ ทุกหน้ามี nonce ต่อ request ใน CSP (`apps/web/src/proxy.ts`) และหน้าที่ generate แบบ static ไม่สามารถมี nonce ใหม่ได้ หน้าจึง render ต่อ request (`Cache-Control: private, no-cache`) trade-off คือแลกความเร็วกับ CSP ที่ไม่มี `unsafe-inline` |
| หน้าสินค้า `/products/[slug]` | ยังไม่ได้สร้าง (API มี `GET /api/v1/products/{slug}`) |
| JSON-LD Product/Offer | ยังไม่ได้ทำ (ไม่มีหน้าสินค้า) |
| OG image แบบ dynamic | ยังไม่ได้ทำ |
| i18n `/th` + `/en` พร้อม hreflang | ยังไม่ได้ทำ เว็บมีภาษาไทยอย่างเดียว |
| Lighthouse (mobile) | ยังไม่ได้วัด จึงไม่อ้างคะแนนใด ๆ |
