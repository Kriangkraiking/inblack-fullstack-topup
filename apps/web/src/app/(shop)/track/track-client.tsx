"use client";

import { isValidOrderId } from "@inblack/domain";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ConnectionNote, OrderSummaryCard, Timeline } from "@/components/order-view";
import { api, describeError } from "@/lib/api";
import { statusLabel } from "@/lib/labels";
import { recallTrackEmail, rememberTrackEmail } from "@/lib/track-memory";
import type { OrderWithToken } from "@/lib/types";
import { useOrderEvents } from "@/lib/use-order-events";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function track(orderId: string, email: string) {
  return api<OrderWithToken>("/orders/track", { method: "POST", body: { order_id: orderId, email } });
}

export function TrackClient({ initialOrderId, paymentResult }: { initialOrderId: string; paymentResult: string | null }) {
  const [orderId, setOrderId] = useState(initialOrderId);
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<{ orderId?: string; email?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ order: OrderWithToken; email: string } | null>(null);
  const autoTried = useRef(false);

  const lookup = useCallback(async (id: string, mail: string) => {
    setLoading(true);
    setFormError(null);
    try {
      const order = await track(id, mail);
      rememberTrackEmail(id, mail);
      setResult({ order, email: mail });
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  // Coming back from mock-pay: the order id is in the URL and the email was kept
  // in sessionStorage at checkout, so the order opens without typing anything.
  useEffect(() => {
    if (autoTried.current || !isValidOrderId(initialOrderId)) return;
    autoTried.current = true;
    const remembered = recallTrackEmail(initialOrderId);
    if (!remembered) return;
    const timer = setTimeout(() => {
      setEmail(remembered);
      void lookup(initialOrderId, remembered);
    }, 0);
    return () => clearTimeout(timer);
  }, [initialOrderId, lookup]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = orderId.trim().toUpperCase();
    const mail = email.trim();
    const next: { orderId?: string; email?: string } = {};
    if (!isValidOrderId(id)) next.orderId = "เลขออเดอร์ไม่ถูกต้อง รูปแบบคือ ORD-ตัวเลข 13 หลัก-ตัวเลข 3 หลัก ตรวจสอบอีกครั้ง";
    if (!EMAIL_PATTERN.test(mail)) next.email = "กรอกอีเมลที่ใช้ตอนสั่งซื้อ";
    setErrors(next);
    if (next.orderId) {
      document.getElementById("order-id")?.focus();
      return;
    }
    if (next.email) {
      document.getElementById("track-email")?.focus();
      return;
    }
    void lookup(id, mail);
  }

  return (
    <div className="stack">
      {paymentResult === "failed" && (
        <p className="alert alert-error" role="alert">
          การชำระเงินไม่สำเร็จ คุณสามารถชำระใหม่ได้จากหน้านี้ก่อนออเดอร์หมดเวลา
        </p>
      )}
      {paymentResult === "succeeded" && (
        <p className="alert alert-success" role="status">
          ได้รับการชำระเงินแล้ว ระบบกำลังเติมเกมให้ สถานะด้านล่างจะอัปเดตเอง
        </p>
      )}

      <form className="card stack" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="order-id">เลขออเดอร์</label>
          <input
            id="order-id"
            className="input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="ORD-0000000000000-000"
            value={orderId}
            aria-invalid={errors.orderId ? true : undefined}
            aria-describedby={errors.orderId ? "order-id-error" : undefined}
            onChange={(e) => {
              setOrderId(e.target.value);
              setErrors((prev) => ({ ...prev, orderId: undefined }));
            }}
          />
          {errors.orderId && (
            <p id="order-id-error" className="error-text" role="alert">
              {errors.orderId}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="track-email">อีเมลที่ใช้สั่งซื้อ</label>
          <input
            id="track-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? "track-email-error" : undefined}
            onChange={(e) => {
              setEmail(e.target.value);
              setErrors((prev) => ({ ...prev, email: undefined }));
            }}
          />
          {errors.email && (
            <p id="track-email-error" className="error-text" role="alert">
              {errors.email}
            </p>
          )}
        </div>
        {formError && (
          <p className="alert alert-error" role="alert">
            {formError}
          </p>
        )}
        <div>
          <button type="submit" className="btn" disabled={loading}>
            {loading ? "กำลังค้นหา…" : "ดูสถานะ"}
          </button>
        </div>
      </form>

      {result && (
        <LiveOrder key={result.order.order_id} order={result.order} renew={() => track(result.order.order_id, result.email)} />
      )}
    </div>
  );
}

function LiveOrder({ order, renew }: { order: OrderWithToken; renew: () => Promise<OrderWithToken> }) {
  const { events, connection, announcement, currentStatus } = useOrderEvents({
    orderId: order.order_id,
    token: order.events_token,
    renewToken: async () => (await renew()).events_token,
  });
  const status = currentStatus ?? order.status;
  return (
    <div className="stack">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <OrderSummaryCard order={order} status={status} />
      {status === "PENDING_PAYMENT" && (
        <p>
          <a className="btn" href={order.payment_url}>
            ไปชำระเงิน
          </a>
        </p>
      )}
      <section className="card stack" aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">ความคืบหน้า</h2>
        <p>
          สถานะปัจจุบัน: <strong>{statusLabel(status)}</strong>
        </p>
        <ConnectionNote connection={connection} />
        <Timeline events={events} />
      </section>
    </div>
  );
}
