import { Injectable } from '@nestjs/common';
import {
  assertPerEmailLimit,
  assertTransition,
  assertVoucherUsable,
  canTransition,
  countsTowardEmailLimit,
  decideLatePayment,
  DomainError,
  ORDER_STATUSES,
  toSatang,
  type OrderStatus,
} from '@inblack/domain';
import type { Tx } from '../db/db.service.js';
import { OutboxSignalService } from '../db/outbox-signal.service.js';
import { OrderOpsRepository, type LockedOrder } from '../orders/order-ops.repository.js';
import { OrdersRepository } from '../orders/orders.repository.js';
import type { WebhookEvent } from './webhook-input.js';
import { WebhooksRepository } from './webhooks.repository.js';

const ACTOR = 'system:payment-webhook';
const COUNTED_STATUSES = ORDER_STATUSES.filter(countsTowardEmailLimit);

/** Paid and past the point where another success could change anything. */
const ALREADY_PAID: readonly OrderStatus[] = [
  'PAID',
  'IN_QUEUE',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'REFUNDED',
];

@Injectable()
export class WebhooksService {
  constructor(
    private readonly repository: WebhooksRepository,
    private readonly ops: OrderOpsRepository,
    private readonly orders: OrdersRepository,
    private readonly signal: OutboxSignalService,
  ) {}

  /**
   * The event row, the status change, the order_events rows and the outbox job commit together,
   * and the 200 goes out only after that. A crash before the commit leaves no trace, so the
   * provider's retry processes the event as if for the first time.
   */
  async handle(event: WebhookEvent, rawBody: string) {
    const outcome = await this.orders.transaction(async (tx) => {
      if (!(await this.repository.insertEvent(tx, event, rawBody))) return 'duplicate';
      const result = await this.process(tx, event);
      await this.repository.finishEvent(tx, event.event_id, result);
      return result;
    });
    if (outcome !== 'duplicate') await this.signal.wake();
    return { received: true, outcome };
  }

  private process(tx: Tx, event: WebhookEvent): Promise<string> {
    if (event.type === 'payment.succeeded') return this.onSucceeded(tx, event);
    if (event.type === 'payment.failed') return this.onFailed(tx, event);
    return this.onRefunded(tx, event);
  }

  private async onSucceeded(tx: Tx, event: WebhookEvent): Promise<string> {
    // ADR 0001: the email lock comes before the order row, and a late payment needs both.
    const email = await this.ops.findEmail(tx, event.order_id);
    if (email === undefined) return 'unknown_order';
    await this.orders.lockEmail(tx, email);
    const order = (await this.ops.lockOrder(tx, event.order_id)) as LockedOrder;

    // An EXPIRED order with money on it already has its late payment being refunded.
    const lateRefundRunning = order.status === 'EXPIRED' && toSatang(order.paid_satang) > 0;
    if (ALREADY_PAID.includes(order.status) || lateRefundRunning) {
      // A second payment under a new event_id. Reconciliation reports it, a person decides.
      await this.ops.note(tx, order.id, 'payment.duplicate', order.status, ACTOR,
        `another payment.succeeded of ${event.amount_satang} satang, status unchanged`);
      return 'duplicate_payment';
    }
    if (order.status === 'NEEDS_REVIEW') {
      await this.ops.note(tx, order.id, 'payment.received', order.status, ACTOR,
        `payment.succeeded of ${event.amount_satang} satang while in review`);
      if (toSatang(order.paid_satang) === 0) await this.ops.setPaid(tx, order.id, event.amount_satang);
      return 'recorded_in_review';
    }

    await this.ops.setPaid(tx, order.id, event.amount_satang);
    const amountMatches =
      event.currency === 'THB' && event.amount_satang === toSatang(order.total_satang);

    if (order.status === 'PAYMENT_FAILED') {
      // ADR 0004: money arrived on an order the customer was told had failed.
      await this.toReview(tx, order, 'payment.succeeded after payment.failed');
      return 'succeeded_after_failed';
    }
    if (!amountMatches) {
      await this.toReview(tx, order,
        `paid ${event.amount_satang} ${event.currency}, expected ${order.total_satang} THB`);
      return 'amount_mismatch';
    }
    if (order.status === 'EXPIRED') return this.onLatePayment(tx, order, event.amount_satang);

    await this.toQueue(tx, order.id, 'PENDING_PAYMENT', 'payment received');
    return 'paid';
  }

  /** ADR 0004. Stock and voucher are re-acquired in the lock order of ADR 0001. */
  private async onLatePayment(tx: Tx, order: LockedOrder, amount: number): Promise<string> {
    await this.orders.savepoint(tx);
    const reacquired = await this.reacquire(tx, order);
    const decision = decideLatePayment({ amountMatchesTotal: true, reacquired });

    if (decision === 'REINSTATE') {
      await this.toQueue(tx, order.id, 'EXPIRED', 'late payment, stock and voucher re-acquired');
      return 'late_paid';
    }
    await this.orders.rollbackToSavepoint(tx);
    await this.ops.note(tx, order.id, 'payment.late_refund', order.status, ACTOR,
      'late payment, could not re-acquire stock, per-email allowance or voucher: refunding');
    await this.ops.insertRefund(tx, order.id, amount, 'auto:late-payment', ACTOR,
      'late payment could not be fulfilled');
    return 'late_refund';
  }

  private async reacquire(tx: Tx, order: LockedOrder): Promise<boolean> {
    const items = await this.ops.findItems(tx, order.id);
    const products = new Map(
      (await this.orders.findActiveProducts(tx, items.map((item) => item.sku))).map((row) => [
        row.sku,
        row,
      ]),
    );
    try {
      for (const item of items) {
        const product = products.get(item.sku);
        if (!product) return false;
        if (product.max_qty_per_email !== null) {
          const held = await this.orders.sumHeldQty(tx, order.email, item.sku, COUNTED_STATUSES);
          assertPerEmailLimit(
            {
              maxQtyPerOrder: product.max_qty_per_order,
              maxQtyPerEmail: product.max_qty_per_email,
            },
            held,
            item.qty,
          );
        }
        if (product.stock !== null && !(await this.orders.takeStock(tx, item.sku, item.qty))) {
          return false;
        }
      }
      if (order.voucher_code !== null) {
        const voucher = await this.orders.findVoucher(tx, order.voucher_code);
        if (!voucher) return false;
        assertVoucherUsable(
          {
            active: voucher.active,
            maxUses: voucher.max_uses,
            usedCount: voucher.used_count,
            maxUsesPerEmail: voucher.max_uses_per_email,
          },
          await this.orders.countOpenRedemptions(tx, voucher.code, order.email),
        );
        if (!(await this.orders.takeVoucherUse(tx, voucher.code))) return false;
        await this.orders.insertRedemption(tx, voucher.code, order.id, order.email);
      }
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
    return true;
  }

  private async onFailed(tx: Tx, event: WebhookEvent): Promise<string> {
    const order = await this.ops.lockOrder(tx, event.order_id);
    if (!order) return 'unknown_order';
    if (order.status !== 'PENDING_PAYMENT') {
      // Covers payment.failed arriving after payment.succeeded: the status must not go back.
      await this.ops.note(tx, order.id, 'payment.failed_ignored', order.status, ACTOR,
        'payment.failed arrived out of order, status unchanged');
      return 'failed_ignored';
    }
    assertTransition('PENDING_PAYMENT', 'PAYMENT_FAILED');
    await this.ops.transition(tx, order.id, 'PENDING_PAYMENT', 'PAYMENT_FAILED', ACTOR,
      'provider reported payment.failed');
    await this.ops.releaseHolds(tx, order.id);
    return 'payment_failed';
  }

  private async onRefunded(tx: Tx, event: WebhookEvent): Promise<string> {
    const outcome = await this.ops.settleRefund(tx, event.order_id, event.amount_satang,
      event.event_id, ACTOR);
    if (outcome !== 'unmatched') return outcome;

    // Money went back that we have no record of asking for.
    const order = (await this.ops.lockOrder(tx, event.order_id)) as LockedOrder;
    const reason = `payment.refunded of ${event.amount_satang} satang matches no pending refund`;
    if (canTransition(order.status, 'NEEDS_REVIEW')) await this.toReview(tx, order, reason);
    else await this.ops.note(tx, order.id, 'refund.unmatched', order.status, ACTOR, reason);
    return 'refund_unmatched';
  }

  private async toReview(tx: Tx, order: LockedOrder, reason: string): Promise<void> {
    assertTransition(order.status, 'NEEDS_REVIEW');
    await this.ops.transition(tx, order.id, order.status, 'NEEDS_REVIEW', ACTOR, reason);
  }

  /** PAID and IN_QUEUE together with the job, so a crash cannot leave a paid order unqueued. */
  private async toQueue(tx: Tx, orderId: string, from: OrderStatus, reason: string): Promise<void> {
    assertTransition(from, 'PAID');
    assertTransition('PAID', 'IN_QUEUE');
    await this.ops.transition(tx, orderId, from, 'PAID', ACTOR, reason);
    await this.ops.transition(tx, orderId, 'PAID', 'IN_QUEUE', ACTOR, 'fulfillment queued');
    await this.ops.enqueueFulfillment(tx, orderId);
  }
}
