# Brief สำหรับ Claude Design — InBlack Top-Up

ไฟล์นี้คือ prompt ที่ใช้สร้างงานใน Claude Design ให้ตรงกับเว็บจริงใน `apps/web`
ค่าสี ระยะ และฟอนต์ทั้งหมดคัดมาจาก `apps/web/src/app/globals.css` (`:root`)

## วิธีใช้

1. เปิด Claude Design ด้วยบัญชี Claude ที่เปิดใช้ Claude Design แล้ว
2. สร้างโปรเจกต์ใหม่ แล้ววาง prompt ในหัวข้อถัดไปทั้งก้อน
3. เมื่อได้งานแล้ว ใช้เมนู export ของ Claude Design บันทึกเป็น **standalone HTML** และ **PDF**
4. วางทั้งสองไฟล์ในโฟลเดอร์นี้ (`design/`) เช่น `design/inblack-topup.html` และ `design/inblack-topup.pdf`
5. ถ้าใช้ handoff bundle ให้วางใน `design/handoff/` (ตาม SPEC 9.1)

## Prompt (คัดลอกทั้งหมด)

```
Design a game top-up web app called "InBlack Top-Up" (Thai-first UI, prices in Thai baht).
Visual direction: red and white, like a modern Thai game top-up store. Red full-width header with
a centred wordmark logo, menu button on the left, "TH · ฿" chip and a "เข้าสู่ระบบ" button on the
right. A full-width search bar under the header. Bold hero headline "ALL GAMES BY INBLACK" with
"INBLACK" in red, a short Thai subline, and a controller illustration. Rounded category chips
(selected chip = red fill). White rounded product cards with a soft shadow.

Design tokens (use exactly):
- Brand red #C8102E, hover #A10C24, strong #8E0B20, on-brand #FFFFFF, brand soft #FDE8EB
- Background #F5F5F7, surface #FFFFFF, surface-2 #F1F1F4, text #16161A, muted #5B5B66,
  border #E1E1E7, focus ring #0B57D0
- Status: danger #B42318 on #FDECEA, success #0F7A3D on #E5F5EC, warning #8A5A00 on #FFF4D6,
  info #1D4F91 on #E6EFFA, flash-sale badge #B3261E
- Spacing 4 / 8 / 12 / 16 / 24 / 32 / 48 px; radius 8 / 14 / 20 px and pill 999 px
- Shadow small: 0 1px 2px rgba(20,20,30,.06), 0 1px 3px rgba(20,20,30,.05);
  medium: 0 6px 20px rgba(20,20,30,.08)
- Font: Noto Sans Thai (fallback Leelawadee UI, Tahoma, system-ui). Sizes 14 / 16 / 20 / 28 px,
  hero 30–54 px, line height 1.6. No letter-spacing on Thai text.
- Provide a dark mode version of the same tokens.

Products (prices include VAT):
- 1,000 Diamonds ฿349.00 · 5,000 Diamonds ฿1,590.00
- Monthly Pass ฿179.00 (max 1 per order)
- Limited Skin (Flash Sale) ฿99.00, 100 in stock, max 2 per email, red "FLASH" badge

Screens, each for desktop (1366) and mobile (360), each with loading, empty and error states:
1. Home + catalog (search, hero, category chips, product cards, flash-sale stock left)
2. Checkout: item quantities, email, Game UID (4–32 letters, digits, - or _), payment method cards
   (PromptPay no fee / TrueMoney 1.5% / Card 2.9% + ฿3), voucher field, live summary:
   subtotal, discount, fee, total, VAT 7%. Example: 1,000 Diamonds ×2 + SAVE10 + Card =
   subtotal ฿698.00, discount −฿50.00, fee ฿21.80, total ฿669.80, VAT ฿43.82.
   Error text shown under the field it belongs to.
3. Mock payment page (scenario buttons) and the return to tracking
4. Tracking: order id + email form, order card, live timeline
   PENDING_PAYMENT → PAID → IN_QUEUE → IN_PROGRESS → COMPLETED, with a "status updated" toast
5. My Orders: email OTP sign-in (6 digits), tabs current / past, order cards
6. Admin (separate layout): login (username or email + password), dashboard with red sidebar
   (Orders, Products, Sign out), top bar with user + role, summary cards (orders today, sales
   today, orders per minute, fulfillment queue, open dead letters), status counts, orders table
   with filters (status, date range, exact order id or email) and cursor paging, order detail with
   timeline, webhooks, top-up attempts, refunds, and a 2-step refund dialog
   (enter amount → confirm amount and order id).

Components: status badge for every status (PENDING_PAYMENT, PAID, IN_QUEUE, IN_PROGRESS,
COMPLETED, FAILED, REFUNDED, EXPIRED, PAYMENT_FAILED, NEEDS_REVIEW), buttons in every state
(default, hover, focus, disabled, loading), input with error, order card, timeline, toast.
Accessibility: WCAG 2.2 AA contrast, visible focus ring, works at 320 px with no horizontal scroll,
reduced-motion friendly. Make the prototype clickable through:
pick a product → checkout → pay → tracking.
```

## หมายเหตุ

- เว็บจริงใช้ฟอนต์ระบบ (ไม่ได้ฝัง Noto Sans Thai) เพื่อให้ `docker compose build` ไม่ต้องต่อเน็ต
- เว็บจริงยังไม่มีรูปสินค้า ใช้กราฟิก SVG/CSS แทน และชิปหมวดหมู่ยังแสดงรหัสภาษาอังกฤษ
- ถ้า design ที่ได้ต่างจากโค้ด ให้บันทึกความต่างและเหตุผลใน `AI_LOG.md` ตาม SPEC 9.1
