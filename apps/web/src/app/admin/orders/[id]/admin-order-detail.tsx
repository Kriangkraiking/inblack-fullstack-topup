"use client";

import { REFUNDABLE_STATUSES, type OrderStatus } from "@inblack/domain";
import { useCallback, useEffect, useState } from "react";
import { OrderSummaryCard, Timeline } from "@/components/order-view";
import { api, ApiError, describeError } from "@/lib/api";
import { formatDateTime } from "@/lib/labels";
import { formatBaht } from "@/lib/money";
import type { AdminIdentity, AdminOrderDetail as Detail } from "@/lib/types";
import { hasRole, useAdminSession } from "@/lib/use-admin";
import { RefundDialog } from "./refund-dialog";

const RETRYABLE: readonly string[] = ["FAILED", "NEEDS_REVIEW"];

/** The admin shell only renders this when signed in, so the identity is always there. */
export function AdminOrderDetail({ orderId }: { orderId: string }) {
  const { identity } = useAdminSession();
  return <DetailBody orderId={orderId} identity={identity} />;
}

function DetailBody({ orderId, identity }: { orderId: string; identity: AdminIdentity }) {
  const [order, setOrder] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrder(await api<Detail>(`/admin/orders/${encodeURIComponent(orderId)}`));
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404 ? "ไม่พบออเดอร์นี้" : describeError(err),
      );
    }
  }, [orderId]);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function retry() {
    setRetrying(true);
    setNotice(null);
    try {
      await api(`/admin/orders/${encodeURIComponent(orderId)}/retry-fulfillment`, {
        method: "POST",
        body: { reason: "retry requested from admin UI" },
      });
      setNotice("ส่งเข้าคิวเติมเกมใหม่แล้ว");
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRetrying(false);
      setConfirmRetry(false);
    }
  }

  if (!order) {
    return error ? (
      <div className="alert alert-error" role="alert">
        <p>{error}</p>
        <button type="button" className="btn btn-secondary" onClick={load}>
          ลองอีกครั้ง
        </button>
      </div>
    ) : (
      <p aria-busy="true">กำลังโหลดออเดอร์…</p>
    );
  }

  const remaining = order.paid_satang - order.refunded_satang;
  const canRefund =
    hasRole(identity, "finance") && REFUNDABLE_STATUSES.includes(order.status as OrderStatus) && remaining > 0;
  const canRetry = hasRole(identity, "support") && RETRYABLE.includes(order.status);

  return (
    <div className="stack">
      {notice && (
        <p className="alert alert-success" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        {canRefund && (
          <RefundDialog
            orderId={order.order_id}
            remainingSatang={remaining}
            onDone={(message) => {
              setNotice(message);
              void load();
            }}
          />
        )}
        {canRetry &&
          (confirmRetry ? (
            <>
              <span>ยืนยันส่งออเดอร์นี้เข้าคิวเติมเกมอีกครั้ง?</span>
              <button type="button" className="btn" disabled={retrying} onClick={retry}>
                {retrying ? "กำลังส่ง…" : "ยืนยันเติมใหม่"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmRetry(false)}>
                ยกเลิก
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmRetry(true)}>
              เติมเกมใหม่
            </button>
          ))}
        <button type="button" className="btn btn-secondary" onClick={load}>
          โหลดข้อมูลล่าสุด
        </button>
      </div>

      <OrderSummaryCard order={order} status={order.status} />
      <p className="small">
        ชำระแล้ว {formatBaht(order.paid_satang)} คืนแล้ว {formatBaht(order.refunded_satang)} คงเหลือคืนได้{" "}
        {formatBaht(Math.max(0, remaining))}
      </p>

      <section className="card stack" aria-labelledby="tl-heading">
        <h2 id="tl-heading">Timeline</h2>
        <Timeline events={order.timeline} showActor />
      </section>

      <section className="card stack" aria-labelledby="wh-heading">
        <h2 id="wh-heading">Webhook จากผู้ให้บริการชำระเงิน</h2>
        {order.webhooks.length === 0 ? (
          <p className="muted">ยังไม่มี webhook</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">event_id</th>
                  <th scope="col">ประเภท</th>
                  <th scope="col">ยอด</th>
                  <th scope="col">ได้รับเมื่อ</th>
                  <th scope="col">ผล</th>
                </tr>
              </thead>
              <tbody>
                {order.webhooks.map((w) => (
                  <tr key={w.event_id}>
                    <td className="small">{w.event_id}</td>
                    <td>{w.type}</td>
                    <td>{w.amount_satang === null ? "-" : formatBaht(w.amount_satang)}</td>
                    <td className="small">{formatDateTime(w.received_at)}</td>
                    <td>{w.outcome ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack" aria-labelledby="fa-heading">
        <h2 id="fa-heading">ประวัติการเติมเกม</h2>
        {order.fulfillment_attempts.length === 0 ? (
          <p className="muted">ยังไม่มีการเติม</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">ครั้งที่</th>
                  <th scope="col">สถานะ</th>
                  <th scope="col">HTTP</th>
                  <th scope="col">ข้อผิดพลาด</th>
                  <th scope="col">เริ่ม</th>
                </tr>
              </thead>
              <tbody>
                {order.fulfillment_attempts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.attempt_no}</td>
                    <td>{a.status}</td>
                    <td>{a.http_status ?? "-"}</td>
                    <td className="small">{a.error ?? "-"}</td>
                    <td className="small">{formatDateTime(a.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack" aria-labelledby="rf-heading">
        <h2 id="rf-heading">การคืนเงิน</h2>
        {order.refunds.length === 0 ? (
          <p className="muted">ยังไม่มีการคืนเงิน</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">ยอด</th>
                  <th scope="col">สถานะ</th>
                  <th scope="col">โดย</th>
                  <th scope="col">เหตุผล</th>
                  <th scope="col">เมื่อ</th>
                </tr>
              </thead>
              <tbody>
                {order.refunds.map((r) => (
                  <tr key={r.id}>
                    <td>{formatBaht(r.amount_satang)}</td>
                    <td>{r.status}</td>
                    <td className="small">{r.actor}</td>
                    <td className="small">{r.reason}</td>
                    <td className="small">{formatDateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
