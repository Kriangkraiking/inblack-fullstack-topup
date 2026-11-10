"use client";

import {
  calculatePrice,
  DomainError,
  isValidGameUid,
  normalizeVoucherCode,
  PAYMENT_METHODS,
  type PaymentMethod,
  type PriceBreakdown,
} from "@inblack/domain";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { useProducts } from "@/lib/use-products";
import { api, ApiError, describeError, isRetryable } from "@/lib/api";
import { PAYMENT_LABELS } from "@/lib/labels";
import { formatBaht } from "@/lib/money";
import { rememberTrackEmail } from "@/lib/track-memory";
import type { Order, Product } from "@/lib/types";
import { KNOWN_VOUCHERS } from "@/lib/vouchers";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_MAX_QTY = 99;

type Field = "items" | "email" | "gameUid" | "voucher";
type FieldErrors = Partial<Record<Field, string>>;

function maxQty(product: Product): number {
  let max = product.max_qty_per_order ?? product.max_qty_per_email ?? DEFAULT_MAX_QTY;
  if (product.max_qty_per_email !== null) max = Math.min(max, product.max_qty_per_email);
  if (product.stock !== null) max = Math.min(max, product.stock);
  return Math.max(0, max);
}

interface Preview {
  price: PriceBreakdown;
  voucherNote: string | null;
}

/** The same calculatePrice the API runs, so the preview matches it to the satang. */
function previewPrice(
  products: Product[],
  qty: Record<string, number>,
  method: PaymentMethod,
  voucherInput: string,
): Preview | null {
  const lines = products
    .filter((p) => (qty[p.sku] ?? 0) > 0)
    .map((p) => ({ unitPriceSatang: p.price_satang, qty: qty[p.sku] }));
  if (lines.length === 0) return null;
  const code = normalizeVoucherCode(voucherInput);
  const rule = code ? KNOWN_VOUCHERS[code] : undefined;
  if (code && !rule) {
    return {
      price: calculatePrice({ lines, discount: null, paymentMethod: method }),
      voucherNote: "ระบบจะตรวจโค้ดนี้ตอนกดสั่งซื้อ ยอดด้านล่างยังไม่รวมส่วนลด",
    };
  }
  try {
    return { price: calculatePrice({ lines, discount: rule ?? null, paymentMethod: method }), voucherNote: null };
  } catch (error) {
    if (error instanceof DomainError && error.code === "VOUCHER_MIN_SUBTOTAL" && rule) {
      return {
        price: calculatePrice({ lines, discount: null, paymentMethod: method }),
        voucherNote: `โค้ด ${code} ใช้ได้เมื่อยอดสินค้าตั้งแต่ ${formatBaht(rule.minSubtotalSatang)}`,
      };
    }
    throw error;
  }
}

function fieldForProblem(error: ApiError): Field | null {
  switch (error.code) {
    case "OUT_OF_STOCK":
    case "PER_ORDER_LIMIT":
    case "PRODUCT_NOT_FOUND":
    case "EMPTY_CART":
    case "INVALID_QUANTITY":
      return "items";
    case "VOUCHER_EXHAUSTED":
    case "VOUCHER_NOT_FOUND":
    case "VOUCHER_INACTIVE":
    case "VOUCHER_MIN_SUBTOTAL":
      return "voucher";
    case "PER_CUSTOMER_LIMIT":
      return /voucher/i.test(error.detail) ? "voucher" : "items";
    default:
      return null;
  }
}

export function CheckoutForm({
  initialProducts,
  preselectedSku,
}: {
  initialProducts: Product[] | null;
  preselectedSku: string | null;
}) {
  const { products, error: loadError, reload } = useProducts(initialProducts);
  const [qty, setQty] = useState<Record<string, number>>(() => (preselectedSku ? { [preselectedSku]: 1 } : {}));
  const [email, setEmail] = useState("");
  const [gameUid, setGameUid] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("PROMPTPAY");
  const [voucher, setVoucher] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // One key per press of "Pay". It is kept when the request fails on the network
  // or with a 5XX, so pressing again cannot create a second order. Any change to
  // the form starts a new key, since the API refuses a key reused with a new body.
  const idempotencyKey = useRef<string | null>(null);
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const changed = () => {
    idempotencyKey.current = null;
    setFormError(null);
  };

  const preview = useMemo(
    () => (products ? previewPrice(products, qty, method, voucher) : null),
    [products, qty, method, voucher],
  );

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!products?.some((p) => (qty[p.sku] ?? 0) > 0)) next.items = "เลือกสินค้าอย่างน้อย 1 ชิ้น";
    const trimmedEmail = email.trim();
    if (!trimmedEmail) next.email = "กรอกอีเมลสำหรับรับใบเสร็จ";
    else if (!EMAIL_PATTERN.test(trimmedEmail) || trimmedEmail.length > 254) next.email = "รูปแบบอีเมลไม่ถูกต้อง";
    if (!isValidGameUid(gameUid.trim()))
      next.gameUid = "Game UID ต้องยาว 4–32 ตัว ใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข - และ _";
    if (voucher.trim().length > 64) next.voucher = "โค้ดยาวเกิน 64 ตัวอักษร";
    return next;
  }

  function focusField(field: Field) {
    const target = formRef.current?.querySelector<HTMLElement>(`[data-field="${field}"]`);
    target?.focus();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !products) return;
    const found = validate();
    setErrors(found);
    const first = (["items", "email", "gameUid", "voucher"] as const).find((f) => found[f]);
    if (first) {
      focusField(first);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setFormError(null);
    idempotencyKey.current ??= crypto.randomUUID();
    const trimmedEmail = email.trim();
    try {
      const order = await api<Order>("/orders", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.current },
        body: {
          email: trimmedEmail,
          game_uid: gameUid.trim(),
          payment_method: method,
          voucher_code: voucher.trim() || null,
          items: products
            .filter((p) => (qty[p.sku] ?? 0) > 0)
            .map((p) => ({ sku: p.sku, qty: qty[p.sku] })),
        },
      });
      rememberTrackEmail(order.order_id, trimmedEmail);
      const target = new URL(order.payment_url);
      if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("unexpected payment_url");
      window.location.assign(target.toString());
      // Leave the button disabled while the browser navigates away.
      return;
    } catch (error) {
      if (error instanceof ApiError && !isRetryable(error)) {
        const field = fieldForProblem(error);
        if (field) {
          setErrors({ [field]: describeError(error) });
          focusField(field);
        } else {
          setFormError(describeError(error));
        }
      } else {
        setFormError(`${describeError(error)} กดชำระเงินอีกครั้งได้ ระบบจะไม่สร้างออเดอร์ซ้ำ`);
      }
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  if (!products) {
    if (loadError) {
      return (
        <div className="alert alert-error" role="alert">
          <p>โหลดรายการสินค้าไม่สำเร็จ: {loadError}</p>
          <button type="button" className="btn btn-secondary" onClick={reload}>
            ลองโหลดอีกครั้ง
          </button>
        </div>
      );
    }
    return (
      <p className="card" aria-busy="true">
        กำลังโหลดสินค้า…
      </p>
    );
  }

  const describedBy = (field: Field, hintId?: string) =>
    [hintId, errors[field] ? `${field}-error` : null].filter(Boolean).join(" ") || undefined;

  return (
    <form ref={formRef} className="stack" onSubmit={onSubmit} noValidate>
      <fieldset aria-describedby={describedBy("items")}>
        <legend>สินค้า</legend>
        {products.length === 0 && <p>ยังไม่มีสินค้าเปิดขาย</p>}
        <ul className="list-plain">
          {products.map((product, index) => {
            const max = maxQty(product);
            const inputId = `qty-${product.sku}`;
            const hintId = `${inputId}-hint`;
            return (
              <li key={product.sku} className="row spread">
                <div>
                  <label htmlFor={inputId} className="label">
                    {product.name}
                  </label>
                  <div id={hintId} className="hint">
                    {formatBaht(product.price_satang)} ต่อชิ้น
                    {product.stock !== null && ` · เหลือ ${product.stock} ชิ้น (อาจไม่ตรงทันที)`}
                    {max < DEFAULT_MAX_QTY && ` · สั่งได้สูงสุด ${max} ชิ้น`}
                  </div>
                </div>
                <div className="qty">
                  <input
                    id={inputId}
                    className="input"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={max}
                    step={1}
                    data-field={index === 0 ? "items" : undefined}
                    value={qty[product.sku] ?? 0}
                    disabled={max === 0}
                    aria-invalid={errors.items ? true : undefined}
                    aria-describedby={describedBy("items", hintId)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const n = /^[0-9]+$/.test(raw) ? Math.min(Number(raw), max) : 0;
                      setQty((prev) => ({ ...prev, [product.sku]: n }));
                      setErrors((prev) => ({ ...prev, items: undefined }));
                      changed();
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        {errors.items && (
          <p id="items-error" className="error-text" role="alert">
            {errors.items}
          </p>
        )}
      </fieldset>

      <div className="field">
        <label htmlFor="email">อีเมล</label>
        <input
          id="email"
          data-field="email"
          className="input"
          type="email"
          autoComplete="email"
          value={email}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={describedBy("email", "email-hint")}
          onChange={(e) => {
            setEmail(e.target.value);
            setErrors((prev) => ({ ...prev, email: undefined }));
            changed();
          }}
        />
        <span id="email-hint" className="hint">
          ใช้รับใบเสร็จและติดตามออเดอร์
        </span>
        {errors.email && (
          <p id="email-error" className="error-text" role="alert">
            {errors.email}
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="game-uid">Game UID</label>
        <input
          id="game-uid"
          data-field="gameUid"
          className="input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={32}
          value={gameUid}
          aria-invalid={errors.gameUid ? true : undefined}
          aria-describedby={describedBy("gameUid", "game-uid-hint")}
          onChange={(e) => {
            setGameUid(e.target.value);
            setErrors((prev) => ({ ...prev, gameUid: undefined }));
            changed();
          }}
        />
        <span id="game-uid-hint" className="hint">
          4–32 ตัว ตัวอักษรอังกฤษ ตัวเลข - หรือ _ ดูได้ในหน้าโปรไฟล์ในเกม
        </span>
        {errors.gameUid && (
          <p id="gameUid-error" className="error-text" role="alert">
            {errors.gameUid}
          </p>
        )}
      </div>

      <fieldset>
        <legend>ช่องทางชำระเงิน</legend>
        {PAYMENT_METHODS.map((m) => (
          <label key={m} className="radio">
            <input
              type="radio"
              name="payment_method"
              value={m}
              checked={method === m}
              onChange={() => {
                setMethod(m);
                changed();
              }}
            />
            <span>
              {PAYMENT_LABELS[m].label}
              <span className="hint"> · {PAYMENT_LABELS[m].fee}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="field">
        <label htmlFor="voucher">โค้ดส่วนลด (ถ้ามี)</label>
        <input
          id="voucher"
          data-field="voucher"
          className="input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          value={voucher}
          aria-invalid={errors.voucher ? true : undefined}
          aria-describedby={describedBy("voucher", preview?.voucherNote ? "voucher-note" : undefined)}
          onChange={(e) => {
            setVoucher(e.target.value);
            setErrors((prev) => ({ ...prev, voucher: undefined }));
            changed();
          }}
        />
        {preview?.voucherNote && (
          <span id="voucher-note" className="hint">
            {preview.voucherNote}
          </span>
        )}
        {errors.voucher && (
          <p id="voucher-error" className="error-text" role="alert">
            {errors.voucher}
          </p>
        )}
      </div>

      <section className="card" aria-labelledby="summary-heading">
        <h2 id="summary-heading">สรุปยอด</h2>
        {preview ? (
          <dl className="totals" aria-live="polite">
            <dt>ยอดสินค้า</dt>
            <dd>{formatBaht(preview.price.subtotalSatang)}</dd>
            <dt>ส่วนลด</dt>
            <dd>-{formatBaht(preview.price.discountSatang)}</dd>
            <dt>ค่าธรรมเนียม ({PAYMENT_LABELS[method].label})</dt>
            <dd>{formatBaht(preview.price.feeSatang)}</dd>
            <dt className="grand">ยอดชำระ</dt>
            <dd className="grand">{formatBaht(preview.price.totalSatang)}</dd>
            <dt>รวม VAT 7%</dt>
            <dd>{formatBaht(preview.price.vatSatang)}</dd>
          </dl>
        ) : (
          <p className="muted">เลือกสินค้าเพื่อดูยอดชำระ</p>
        )}
        <p className="hint">ยอดสุดท้ายคำนวณโดยระบบตอนสร้างออเดอร์</p>
      </section>

      {formError && (
        <div className="alert alert-error" role="alert">
          {formError}
        </div>
      )}

      <button type="submit" className="btn" disabled={submitting} aria-disabled={submitting}>
        {submitting ? "กำลังสร้างออเดอร์…" : preview ? `ชำระเงิน ${formatBaht(preview.price.totalSatang)}` : "ชำระเงิน"}
      </button>
    </form>
  );
}
