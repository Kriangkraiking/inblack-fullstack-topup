import { Injectable } from '@nestjs/common';
import type { OrderStatus } from '@inblack/domain';
import type { Tx } from '../db/db.service.js';

/** SQL that changes an order after it was created: status, money, outbox, refunds. */

export const FULFILLMENT_TOPIC = 'fulfillment.requested';
export const REFUND_TOPIC = 'refund.requested';

export interface LockedOrder {
  id: string;
  email: string;
  status: OrderStatus;
  voucher_code: string | null;
  total_satang: string;
  paid_satang: string;
  refunded_satang: string;
}

@Injectable()
export class OrderOpsRepository {
  /** Immutable, so reading it before the order lock is safe. See the lock order in ADR 0001. */
  async findEmail(tx: Tx, orderId: string): Promise<string | undefined> {
    const { rows } = await tx.query<{ email: string }>('SELECT email FROM orders WHERE id = $1', [
      orderId,
    ]);
    return rows[0]?.email;
  }

  async lockOrder(tx: Tx, orderId: string): Promise<LockedOrder | undefined> {
    const { rows } = await tx.query<LockedOrder>(
      `SELECT id, email, status, voucher_code, total_satang, paid_satang, refunded_satang
       FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    return rows[0];
  }

  /** Writes the order_events row too, through the trigger on orders. */
  async transition(
    tx: Tx,
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    actor: string,
    reason: string,
  ): Promise<boolean> {
    const { rows } = await tx.query<{ changed: boolean }>(
      'SELECT transition_order($1, $2, $3, $4, $5) AS changed',
      [orderId, from, to, actor, reason],
    );
    return rows[0].changed;
  }

  /** An event that leaves the status alone, so the timeline still shows it happened. */
  async note(
    tx: Tx,
    orderId: string,
    eventType: string,
    status: OrderStatus,
    actor: string,
    reason: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO order_events (order_id, event_type, from_status, to_status, actor, reason)
       VALUES ($1, $2, $3, $3, $4, $5)`,
      [orderId, eventType, status, actor, reason],
    );
  }

  async setPaid(tx: Tx, orderId: string, amount: number): Promise<void> {
    await tx.query('UPDATE orders SET paid_satang = $2 WHERE id = $1', [orderId, amount]);
  }

  async releaseHolds(tx: Tx, orderId: string): Promise<void> {
    await tx.query('SELECT release_order_holds($1)', [orderId]);
  }

  /** Returns false when the order already has an open job, which the partial index forbids. */
  async enqueueFulfillment(tx: Tx, orderId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO outbox (topic, aggregate_id) VALUES ($1, $2)
       ON CONFLICT (aggregate_id)
         WHERE topic = 'fulfillment.requested' AND processed_at IS NULL
       DO NOTHING`,
      [FULFILLMENT_TOPIC, orderId],
    );
    return rowCount === 1;
  }

  /** The trigger on refunds adds to refunded_satang, which holds the refund within paid. */
  async insertRefund(
    tx: Tx,
    orderId: string,
    amount: number,
    idempotencyKey: string,
    actor: string,
    reason: string,
  ): Promise<{ id: string; refund_ref: string }> {
    const { rows } = await tx.query<{ id: string; refund_ref: string }>(
      `INSERT INTO refunds (order_id, amount_satang, idempotency_key, actor, reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, refund_ref`,
      [orderId, amount, idempotencyKey, actor, reason],
    );
    await tx.query(
      `INSERT INTO outbox (topic, aggregate_id, payload)
       VALUES ($1, $2, jsonb_build_object('refund_id', $3::bigint))`,
      [REFUND_TOPIC, orderId, rows[0].id],
    );
    return rows[0];
  }

  async settleRefund(tx: Tx, orderId: string, amount: number, eventId: string, actor: string) {
    const { rows } = await tx.query<{ outcome: string }>(
      'SELECT settle_refund($1, $2, $3, NULL, $4) AS outcome',
      [orderId, amount, eventId, actor],
    );
    return rows[0].outcome;
  }

  async findItems(tx: Tx, orderId: string): Promise<{ sku: string; qty: number }[]> {
    const { rows } = await tx.query<{ sku: string; qty: number }>(
      'SELECT sku, qty FROM order_items WHERE order_id = $1 ORDER BY sku',
      [orderId],
    );
    return rows;
  }

  /** True when the order reached the queue, so it still holds its stock and voucher. */
  async wasQueued(tx: Tx, orderId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM order_events WHERE order_id = $1 AND to_status = 'IN_QUEUE' LIMIT 1`,
      [orderId],
    );
    return rowCount === 1;
  }

  async resolveDeadLetters(tx: Tx, orderId: string, resolvedBy: string): Promise<void> {
    await tx.query(
      `UPDATE dead_letters SET resolved_at = now(), resolved_by = $3
       WHERE aggregate_id = $1 AND topic = $2 AND resolved_at IS NULL`,
      [orderId, FULFILLMENT_TOPIC, resolvedBy],
    );
  }
}
