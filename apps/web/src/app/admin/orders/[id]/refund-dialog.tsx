"use client";

import { useRef, useState, type FormEvent } from "react";
import { api, ApiError, describeError, isRetryable } from "@/lib/api";
import { formatBaht, parseBahtToSatang } from "@/lib/money";

/**
 * Two-step refund. Step 1: amount in baht, read as a string into integer satang.
 * Step 2: shows the exact satang and the order id to confirm. One
 * Idempotency-Key covers one confirmed amount and reason, so pressing confirm
 * again after a timeout cannot refund twice.
 */
export function RefundDialog({
  orderId,
  remainingSatang,
  onDone,
}: {
  orderId: string;
  remainingSatang: number;
  onDone: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const [amountSatang, setAmountSatang] = useState(0);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const keyFor = useRef<{ key: string; body: string } | null>(null);

  function open() {
    setStep(1);
    setAmountText("");
    setReason("");
    setFieldError(null);
    setSendError(null);
    keyFor.current = null;
    dialogRef.current?.showModal();
  }

  function close() {
    dialogRef.current?.close();
  }

  function toConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const satang = parseBahtToSatang(amountText);
    if (satang === null || satang <= 0) {
      setFieldError("กรอกยอดเป็นบาท เช่น 120 หรือ 120.50 (ทศนิยมไม่เกิน 2 ตำแหน่ง)");
      return;
    }
    if (satang > remainingSatang) {
      setFieldError(`ยอดคืนเกินยอดที่คืนได้ (${formatBaht(remainingSatang)})`);
      return;
    }
    if (!reason.trim()) {
      setFieldError("กรอกเหตุผลการคืนเงิน");
      return;
    }
    setFieldError(null);
    setAmountSatang(satang);
    setStep(2);
  }

  async function confirm() {
    const body = { amount_satang: amountSatang, reason: reason.trim() };
    const serialized = JSON.stringify(body);
    if (!keyFor.current || keyFor.current.body !== serialized) {
      keyFor.current = { key: crypto.randomUUID(), body: serialized };
    }
    setSending(true);
    setSendError(null);
    try {
      const res = await api<{ amount_satang: number; remaining_satang: number }>(
        `/admin/orders/${encodeURIComponent(orderId)}/refund`,
        { method: "POST", headers: { "Idempotency-Key": keyFor.current.key }, body },
      );
      close();
      onDone(
        `บันทึกการคืนเงิน ${formatBaht(res.amount_satang)} แล้ว กำลังส่งให้ผู้ให้บริการ คงเหลือคืนได้ ${formatBaht(res.remaining_satang)}`,
      );
    } catch (err) {
      setSendError(
        err instanceof ApiError && !isRetryable(err)
          ? describeError(err)
          : `${describeError(err)} กดยืนยันอีกครั้งได้ ระบบจะไม่คืนเงินซ้ำ`,
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-danger" onClick={open}>
        คืนเงิน
      </button>
      <dialog ref={dialogRef} aria-labelledby="refund-title">
        <h2 id="refund-title">คืนเงินออเดอร์ {orderId}</h2>
        {step === 1 ? (
          <form className="stack" onSubmit={toConfirm} noValidate>
            <p className="small">คืนได้สูงสุด {formatBaht(remainingSatang)}</p>
            <div className="field">
              <label htmlFor="refund-amount">ยอดคืน (บาท)</label>
              <input
                id="refund-amount"
                className="input"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amountText}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? "refund-error" : undefined}
                onChange={(e) => setAmountText(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="refund-reason">เหตุผล</label>
              <input
                id="refund-reason"
                className="input"
                type="text"
                maxLength={500}
                value={reason}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? "refund-error" : undefined}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {fieldError && (
              <p id="refund-error" className="error-text" role="alert">
                {fieldError}
              </p>
            )}
            <div className="row">
              <button type="submit" className="btn">
                ถัดไป
              </button>
              <button type="button" className="btn btn-secondary" onClick={close}>
                ยกเลิก
              </button>
            </div>
          </form>
        ) : (
          <div className="stack">
            <p className="alert alert-warning">
              ยืนยันคืนเงิน <strong>{formatBaht(amountSatang)}</strong> ({amountSatang.toLocaleString("en-US")} สตางค์)
              ให้ออเดอร์ <strong>{orderId}</strong> การคืนเงินยกเลิกไม่ได้
            </p>
            <p className="small">เหตุผล: {reason}</p>
            {sendError && (
              <p className="error-text" role="alert">
                {sendError}
              </p>
            )}
            <div className="row">
              <button type="button" className="btn btn-danger" disabled={sending} onClick={confirm}>
                {sending ? "กำลังคืนเงิน…" : `ยืนยันคืน ${formatBaht(amountSatang)}`}
              </button>
              <button type="button" className="btn btn-secondary" disabled={sending} onClick={() => setStep(1)}>
                แก้ไขยอด
              </button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
