"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ConnectionNote, OrderSummaryCard, Timeline } from "@/components/order-view";
import { api, ApiError, describeError } from "@/lib/api";
import { statusLabel } from "@/lib/labels";
import type { OrderDetail } from "@/lib/types";
import { useOrderEvents } from "@/lib/use-order-events";

export function OrderDetailClient({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<{ notFound: boolean; message: string } | null>(null);

  const fetchOrder = useCallback(() => api<OrderDetail>(`/orders/${encodeURIComponent(orderId)}`), [orderId]);

  const load = useCallback(async () => {
    try {
      setOrder(await fetchOrder());
      setError(null);
    } catch (err) {
      setError({ notFound: err instanceof ApiError && err.status === 404, message: describeError(err) });
    }
  }, [fetchOrder]);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  if (error && !order) {
    return error.notFound ? (
      <div className="card stack">
        <p>ไม่พบออเดอร์นี้ในบัญชีของคุณ หรือคุณยังไม่ได้เข้าสู่ระบบ</p>
        <Link className="btn" href="/my-orders">
          ไปหน้าเข้าสู่ระบบ
        </Link>
      </div>
    ) : (
      <div className="alert alert-error" role="alert">
        <p>{error.message}</p>
        <button type="button" className="btn btn-secondary" onClick={load}>
          ลองอีกครั้ง
        </button>
      </div>
    );
  }
  if (!order) return <p aria-busy="true">กำลังโหลดออเดอร์…</p>;
  return <LiveDetail key={order.order_id} order={order} renew={fetchOrder} />;
}

function LiveDetail({ order, renew }: { order: OrderDetail; renew: () => Promise<OrderDetail> }) {
  const { events, connection, announcement, currentStatus } = useOrderEvents({
    orderId: order.order_id,
    token: order.events_token,
    initialEvents: order.timeline,
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
