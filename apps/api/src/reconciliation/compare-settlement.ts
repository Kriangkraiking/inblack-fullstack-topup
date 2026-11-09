import type { SettlementRow } from './settlement-csv.js';

/** The four kinds of mismatch in spec 8.5. */
export type MismatchType =
  | 'MISSING_IN_SYSTEM'
  | 'MISSING_AT_PROVIDER'
  | 'AMOUNT_MISMATCH'
  | 'STATUS_MISMATCH';

export interface Mismatch {
  type: MismatchType;
  event_id: string | null;
  order_id: string;
  detail: string;
  provider_amount_satang: number | null;
  system_amount_satang: number | null;
}

export interface SystemOrder {
  id: string;
  status: string;
  paidSatang: number;
}

export interface SystemEvent {
  eventId: string;
  type: string;
  orderId: string;
  amountSatang: number;
  occurredAt: Date;
  /** What the webhook did. Null for a refund only known from the answer to POST /refunds. */
  outcome: string | null;
  /** A settled row in refunds points at this event. */
  settledRefund: boolean;
}

/** A refund the system counts against the paid amount but the provider has not confirmed. */
export interface PendingRefund {
  refundRef: string;
  orderId: string;
  amountSatang: number;
  createdAt: Date;
  /** An open outbox job will still send it to the provider. */
  hasOpenJob: boolean;
}

export interface SystemSnapshot {
  events: SystemEvent[];
  orders: Map<string, SystemOrder>;
  pendingRefunds?: PendingRefund[];
}

/** A refund job retries for a few minutes at most, see REFUND_MAX_ATTEMPTS in ADR 0002. */
export const PENDING_REFUND_LIMIT_MS = 15 * 60 * 1000;

export interface Window {
  from?: Date;
  to?: Date;
}

const inWindow = (at: Date, { from, to }: Window) => (!from || at >= from) && (!to || at <= to);

/**
 * Every satang that moved must be on both sides with the same amount (spec 5.4 invariant 5).
 * payment.failed is left out: no money moved, and the provider's export does not list it.
 */
export function compareSettlement(
  rows: readonly SettlementRow[],
  system: SystemSnapshot,
  window: Window = {},
  now: Date = new Date(),
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const events = new Map(system.events.map((event) => [event.eventId, event]));
  const add = (
    type: MismatchType,
    eventId: string | null,
    orderId: string,
    detail: string,
    providerAmount: number | null,
    systemAmount: number | null,
  ) =>
    mismatches.push({
      type,
      event_id: eventId,
      order_id: orderId,
      detail,
      provider_amount_satang: providerAmount,
      system_amount_satang: systemAmount,
    });

  const inFile = new Set<string>();
  const refundedAtProvider = new Map<string, number>();

  for (const row of rows) {
    inFile.add(row.event_id);
    if (row.type === 'payment.failed') continue;
    if (row.type === 'payment.refunded') {
      refundedAtProvider.set(
        row.order_id,
        (refundedAtProvider.get(row.order_id) ?? 0) + row.amount_satang,
      );
    }

    const event = events.get(row.event_id);
    const order = system.orders.get(row.order_id);
    if (!event || !order) {
      add('MISSING_IN_SYSTEM', row.event_id, row.order_id,
        event ? 'the event was recorded but the order does not exist' : 'no such event in the system',
        row.amount_satang, null);
      continue;
    }
    if (event.type !== row.type || event.orderId !== row.order_id) {
      add('STATUS_MISMATCH', row.event_id, row.order_id,
        `provider says ${row.type}, system recorded ${event.type} for order ${event.orderId}`,
        row.amount_satang, event.amountSatang);
      continue;
    }
    if (event.amountSatang !== row.amount_satang) {
      add('AMOUNT_MISMATCH', row.event_id, row.order_id, 'the event amount differs',
        row.amount_satang, event.amountSatang);
      continue;
    }
    if (row.type === 'payment.succeeded') {
      if (event.outcome === 'duplicate_payment') {
        add('STATUS_MISMATCH', row.event_id, row.order_id,
          'a second payment on an order that was already paid', row.amount_satang, order.paidSatang);
      } else if (order.paidSatang !== row.amount_satang) {
        add('AMOUNT_MISMATCH', row.event_id, row.order_id, 'the paid amount on the order differs',
          row.amount_satang, order.paidSatang);
      }
    } else if (!event.settledRefund) {
      add('STATUS_MISMATCH', row.event_id, row.order_id,
        'the provider refunded this but no refund in the system is settled by it',
        row.amount_satang, null);
    }
  }

  for (const event of system.events) {
    if (inFile.has(event.eventId) || !system.orders.has(event.orderId)) continue;
    if (event.type === 'payment.failed' || !inWindow(event.occurredAt, window)) continue;
    add('MISSING_AT_PROVIDER', event.eventId, event.orderId, 'not in the settlement file',
      null, event.amountSatang);
  }

  // A file for part of the history cannot say whether an order is fully refunded.
  if (!window.from && !window.to) {
    const seen = new Set(rows.map((row) => row.order_id));
    for (const orderId of seen) {
      const order = system.orders.get(orderId);
      if (!order) continue;
      const refunded = refundedAtProvider.get(orderId) ?? 0;
      if (order.status === 'REFUNDED' && refunded !== order.paidSatang) {
        add('STATUS_MISMATCH', null, orderId, 'the order is REFUNDED but the provider refunded a different amount',
          refunded, order.paidSatang);
      } else if (order.status !== 'REFUNDED' && order.paidSatang > 0 && refunded === order.paidSatang) {
        add('STATUS_MISMATCH', null, orderId, `the provider refunded everything but the order is ${order.status}`,
          refunded, order.paidSatang);
      }
    }
  }

  // Money the system holds back from the customer with no answer from the provider. Nothing
  // will finish a refund with no open job, and one stuck past the limit needs a person.
  for (const refund of system.pendingRefunds ?? []) {
    const age = now.getTime() - refund.createdAt.getTime();
    if (refund.hasOpenJob && age <= PENDING_REFUND_LIMIT_MS) continue;
    add('STATUS_MISMATCH', null, refund.orderId,
      refund.hasOpenJob
        ? `refund ${refund.refundRef} is still PENDING after ${Math.floor(age / 60000)} minutes`
        : `refund ${refund.refundRef} is PENDING and no job will send it`,
      null, refund.amountSatang);
  }

  return mismatches;
}
