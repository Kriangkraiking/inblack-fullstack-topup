import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { OrderCursor } from './order-cursor.js';

/** Read-only SQL for order lists and detail pages. Nothing here takes a lock or writes. */

export interface OrderListRow {
  id: string;
  email: string;
  game_uid: string;
  status: string;
  payment_method: string;
  total_satang: string;
  paid_satang: string;
  refunded_satang: string;
  created_at: Date;
  created_us: string;
}

export interface AdminOrderFilter {
  statuses: readonly string[] | null;
  from: Date | null;
  to: Date | null;
  orderId: string | null;
  email: string | null;
}

export interface ItemSummaryRow {
  order_id: string;
  sku: string;
  name_snapshot: string;
  qty: number;
}

export interface EventRow {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  reason: string;
  created_at: Date;
}

export interface WebhookRow {
  event_id: string;
  type: string;
  amount_satang: string | null;
  currency: string | null;
  occurred_at: Date | null;
  received_at: Date;
  processed_at: Date | null;
  outcome: string | null;
}

export interface AttemptRow {
  id: string;
  reference: string;
  attempt_no: number;
  status: string;
  http_status: number | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export interface RefundRow {
  id: string;
  amount_satang: string;
  status: string;
  actor: string;
  reason: string;
  created_at: Date;
  completed_at: Date | null;
}

const LIST_COLUMNS = `o.id, o.email, o.game_uid, o.status, o.payment_method, o.total_satang,
  o.paid_satang, o.refunded_satang, o.created_at,
  (extract(epoch FROM o.created_at) * 1000000)::bigint::text AS created_us`;

// Row comparison on (created_at, id) walks the (… created_at DESC, id DESC) indexes of 0002.
const AFTER_CURSOR = `($1::bigint IS NULL
  OR (o.created_at, o.id) < (timestamptz 'epoch' + $1::bigint::float8 * interval '1 microsecond', $2::text))`;
// float8 holds every microsecond count below 2^53 (year 2255) exactly, so the round trip is exact.

@Injectable()
export class OrderQueryRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Fixed SQL with optional filters. node-postgres sends unnamed statements, which Postgres
   * plans with the actual values, so a filter left NULL drops out of the plan.
   */
  async listForAdmin(
    filter: AdminOrderFilter,
    cursor: OrderCursor | null,
    limit: number,
  ): Promise<OrderListRow[]> {
    const { rows } = await this.db.query<OrderListRow>(
      `SELECT ${LIST_COLUMNS}
       FROM orders o
       WHERE ${AFTER_CURSOR}
         AND ($3::text[] IS NULL OR o.status = ANY($3::text[]))
         AND ($4::timestamptz IS NULL OR o.created_at >= $4::timestamptz)
         AND ($5::timestamptz IS NULL OR o.created_at < $5::timestamptz)
         AND ($6::text IS NULL OR o.id = $6::text)
         AND ($7::text IS NULL OR o.email = $7::text)
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $8`,
      [
        cursor?.createdUs ?? null,
        cursor?.id ?? null,
        filter.statuses,
        filter.from,
        filter.to,
        filter.orderId,
        filter.email,
        limit,
      ],
    );
    return rows;
  }

  async listForEmail(
    email: string,
    statuses: readonly string[],
    cursor: OrderCursor | null,
    limit: number,
  ): Promise<OrderListRow[]> {
    const { rows } = await this.db.query<OrderListRow>(
      `SELECT ${LIST_COLUMNS}
       FROM orders o
       WHERE ${AFTER_CURSOR}
         AND o.email = $3 AND o.status = ANY($4::text[])
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $5`,
      [cursor?.createdUs ?? null, cursor?.id ?? null, email, statuses, limit],
    );
    return rows;
  }

  async findItemsOf(orderIds: readonly string[]): Promise<ItemSummaryRow[]> {
    const { rows } = await this.db.query<ItemSummaryRow>(
      `SELECT order_id, sku, name_snapshot, qty FROM order_items
       WHERE order_id = ANY($1::text[]) ORDER BY order_id, sku`,
      [orderIds],
    );
    return rows;
  }

  async findEvents(orderId: string): Promise<EventRow[]> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT id::text AS id, event_type, from_status, to_status, actor, reason, created_at
       FROM order_events WHERE order_id = $1 ORDER BY id`,
      [orderId],
    );
    return rows;
  }

  /** raw_body is left out: the parsed fields say the same, and the page should not echo input. */
  async findWebhooks(orderId: string): Promise<WebhookRow[]> {
    const { rows } = await this.db.query<WebhookRow>(
      `SELECT event_id, type, amount_satang, currency, occurred_at, received_at, processed_at, outcome
       FROM webhook_events WHERE order_id = $1 ORDER BY received_at, event_id`,
      [orderId],
    );
    return rows;
  }

  async findAttempts(orderId: string): Promise<AttemptRow[]> {
    const { rows } = await this.db.query<AttemptRow>(
      `SELECT id::text AS id, reference, attempt_no, status, http_status, error, started_at, finished_at
       FROM fulfillment_attempts WHERE order_id = $1 ORDER BY attempt_no`,
      [orderId],
    );
    return rows;
  }

  async findRefunds(orderId: string): Promise<RefundRow[]> {
    const { rows } = await this.db.query<RefundRow>(
      `SELECT id::text AS id, amount_satang, status, actor, reason, created_at, completed_at
       FROM refunds WHERE order_id = $1 ORDER BY id`,
      [orderId],
    );
    return rows;
  }
}
