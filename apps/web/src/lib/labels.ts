import type { PaymentMethod } from "@inblack/domain";

/** Four groups from the design brief, plus the end states that sit outside them. */
export type StatusTone = "waiting" | "queued" | "working" | "done" | "problem" | "neutral";

const STATUS: Record<string, { label: string; tone: StatusTone }> = {
  PENDING_PAYMENT: { label: "รอชำระเงิน", tone: "waiting" },
  PAID: { label: "ชำระเงินแล้ว", tone: "queued" },
  IN_QUEUE: { label: "อยู่ในคิว", tone: "queued" },
  IN_PROGRESS: { label: "กำลังเติมเกม", tone: "working" },
  COMPLETED: { label: "เติมสำเร็จ", tone: "done" },
  FAILED: { label: "เติมไม่สำเร็จ", tone: "problem" },
  REFUNDED: { label: "คืนเงินแล้ว", tone: "neutral" },
  EXPIRED: { label: "หมดเวลาชำระ", tone: "neutral" },
  PAYMENT_FAILED: { label: "ชำระเงินไม่สำเร็จ", tone: "problem" },
  NEEDS_REVIEW: { label: "รอเจ้าหน้าที่ตรวจสอบ", tone: "problem" },
};

export function statusLabel(status: string): string {
  return STATUS[status]?.label ?? status;
}

export function statusTone(status: string): StatusTone {
  return STATUS[status]?.tone ?? "neutral";
}

export const PAYMENT_LABELS: Record<PaymentMethod, { label: string; fee: string }> = {
  PROMPTPAY: { label: "พร้อมเพย์", fee: "ไม่มีค่าธรรมเนียม" },
  TRUEMONEY: { label: "TrueMoney Wallet", fee: "ค่าธรรมเนียม 1.5%" },
  CARD: { label: "บัตรเครดิต/เดบิต", fee: "ค่าธรรมเนียม 2.9% + ฿3" },
};

export function eventLabel(eventType: string, status: string): string {
  if (eventType === "order.created") return "สร้างออเดอร์";
  if (eventType === "refund.settled") return "คืนเงินบางส่วนแล้ว";
  return statusLabel(status);
}

const dateFormatter = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "Asia/Bangkok",
});

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormatter.format(date);
}
