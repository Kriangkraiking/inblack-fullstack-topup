import { eventLabel, formatDateTime, PAYMENT_LABELS, statusLabel, statusTone } from "@/lib/labels";
import { formatBaht } from "@/lib/money";
import type { Order, TimelineEvent } from "@/lib/types";
import type { Connection } from "@/lib/use-order-events";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge tone-${statusTone(status)}`}>{statusLabel(status)}</span>;
}

/** All text from the API is rendered as React text nodes, never as HTML. */
export function Timeline({ events, showActor = false }: { events: TimelineEvent[]; showActor?: boolean }) {
  if (events.length === 0) return <p className="muted">ยังไม่มีความเคลื่อนไหว</p>;
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.event_id}>
          <div className="row">
            <strong>{eventLabel(event.event_type, event.status)}</strong>
            <StatusBadge status={event.status} />
          </div>
          <div className="small muted">
            <time dateTime={event.occurred_at}>{formatDateTime(event.occurred_at)}</time>
          </div>
          {showActor && (
            <div className="small">
              โดย {event.actor ?? "-"}
              {event.reason ? ` เหตุผล: ${event.reason}` : ""}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export function ConnectionNote({ connection }: { connection: Connection }) {
  const text: Record<Connection, string> = {
    connecting: "กำลังเชื่อมต่อสถานะสด…",
    live: "สถานะอัปเดตอัตโนมัติ",
    reconnecting: "การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่…",
    lost: "เชื่อมต่อสถานะสดไม่ได้ กรุณาโหลดหน้าใหม่",
  };
  return <p className={`small ${connection === "lost" ? "error-text" : "muted"}`}>{text[connection]}</p>;
}

export function OrderSummaryCard({ order, status }: { order: Order; status: string }) {
  return (
    <section className="card stack" aria-labelledby="order-heading">
      <div className="row spread">
        <h2 id="order-heading">{order.order_id}</h2>
        <StatusBadge status={status} />
      </div>
      <dl className="totals">
        <dt>Game UID</dt>
        <dd>{order.game_uid}</dd>
        <dt>อีเมล</dt>
        <dd>{order.email}</dd>
        <dt>ช่องทางชำระ</dt>
        <dd>{PAYMENT_LABELS[order.payment_method]?.label ?? order.payment_method}</dd>
        <dt>สร้างเมื่อ</dt>
        <dd>{formatDateTime(order.created_at)}</dd>
      </dl>
      <ul className="list-plain">
        {order.items.map((item) => (
          <li key={item.sku} className="row spread small">
            <span>
              {item.name} × {item.qty}
            </span>
            <span>{formatBaht(item.line_total_satang)}</span>
          </li>
        ))}
      </ul>
      <dl className="totals">
        <dt>ยอดสินค้า</dt>
        <dd>{formatBaht(order.subtotal_satang)}</dd>
        <dt>ส่วนลด{order.voucher_code ? ` (${order.voucher_code})` : ""}</dt>
        <dd>-{formatBaht(order.discount_satang)}</dd>
        <dt>ค่าธรรมเนียม</dt>
        <dd>{formatBaht(order.fee_satang)}</dd>
        <dt className="grand">ยอดชำระ</dt>
        <dd className="grand">{formatBaht(order.total_satang)}</dd>
        <dt>รวม VAT</dt>
        <dd>{formatBaht(order.vat_satang)}</dd>
        {order.refunded_satang > 0 && (
          <>
            <dt>คืนเงินแล้ว</dt>
            <dd>{formatBaht(order.refunded_satang)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
