import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { assertTransition, DomainError, planRefund, REFUNDABLE_STATUSES, toSatang } from '@inblack/domain';
import { z } from 'zod';
import { AdminAuthRepository } from '../admin/admin-auth.repository.js';
import { adminActor, type Admin } from '../admin/admin-roles.js';
import { businessProblem, ProblemError, renderProblem } from '../common/problem.js';
import { parseWith } from '../common/validate.js';
import type { Tx } from '../db/db.service.js';
import { OutboxSignalService } from '../db/outbox-signal.service.js';
import { OrderOpsRepository } from '../orders/order-ops.repository.js';
import { OrdersRepository } from '../orders/orders.repository.js';
import { keyReused, orderNotFound, type StoredResponse } from '../orders/orders.service.js';

/** Refuses NUL, which Postgres text cannot store. */
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !value.includes('\0'), 'must not contain NUL');

const refundSchema = z.object({
  amount_satang: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  reason: reasonSchema.default('refund by admin'),
});
type RefundInput = z.output<typeof refundSchema>;

const retrySchema = z
  .object({ reason: reasonSchema.default('retry by admin') })
  .default({ reason: 'retry by admin' });

@Injectable()
export class RefundsService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly ops: OrderOpsRepository,
    private readonly audit: AdminAuthRepository,
    private readonly signal: OutboxSignalService,
  ) {}

  /**
   * The same single-transaction idempotency as POST /api/v1/orders, see ADR 0001. Only the row
   * is written here. The worker calls the provider with its refund_id, so a crash on either
   * side leaves a PENDING refund and a job that resumes it, never a refund we forgot about.
   */
  async refund(orderId: string, key: string, body: unknown, admin: Admin): Promise<StoredResponse> {
    const scope = `POST /api/v1/admin/orders/${orderId}/refund`;
    let input: RefundInput;
    try {
      input = parseWith(refundSchema, body);
    } catch (error) {
      // Stored requests were all valid, so an invalid body under a used key must differ.
      if (await this.orders.keyExists(scope, key)) throw keyReused();
      throw error;
    }
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

    const response = await this.orders.transaction(async (tx) => {
      await this.orders.deleteKeyIfExpired(tx, scope, key);
      if (!(await this.orders.acquireKey(tx, scope, key, requestHash))) {
        return this.replay(tx, scope, key, requestHash);
      }
      await this.orders.savepoint(tx);
      let result: StoredResponse;
      try {
        result = { status: 202, body: JSON.stringify(await this.create(tx, orderId, key, input, admin)) };
      } catch (error) {
        const problem = businessProblem(error);
        if (!problem) throw error;
        await this.orders.rollbackToSavepoint(tx);
        result = { status: problem.status, body: renderProblem(problem) };
      }
      await this.orders.storeResponse(tx, scope, key, result.status, result.body);
      return result;
    });
    if (response.status === 202) await this.signal.wake();
    return response;
  }

  private async replay(tx: Tx, scope: string, key: string, requestHash: string): Promise<StoredResponse> {
    const stored = await this.orders.readKey(tx, scope, key);
    if (!stored || stored.status_code === null || stored.response_body === null) {
      throw new ProblemError(503, 'IDEMPOTENCY_RETRY', 'please try again');
    }
    if (stored.request_hash !== requestHash) throw keyReused();
    return { status: stored.status_code, body: stored.response_body };
  }

  /**
   * The order row lock runs concurrent refunds one at a time, and orders_refund_within_paid
   * backs this check up in the database.
   */
  private async create(tx: Tx, orderId: string, key: string, input: RefundInput, admin: Admin) {
    const order = await this.ops.lockOrder(tx, orderId);
    if (!order) throw orderNotFound();
    if (!REFUNDABLE_STATUSES.includes(order.status)) {
      throw new ProblemError(409, 'ORDER_NOT_REFUNDABLE', `an order in ${order.status} cannot be refunded`);
    }
    const plan = planRefund({
      paidSatang: toSatang(order.paid_satang),
      alreadyRefundedSatang: toSatang(order.refunded_satang),
      amountSatang: input.amount_satang,
    });

    const actor = adminActor(admin);
    const refund = await this.ops.insertRefund(tx, order.id, input.amount_satang, key, actor, input.reason);
    await this.ops.note(tx, order.id, 'refund.requested', order.status, actor,
      `refund of ${input.amount_satang} satang: ${input.reason}`);
    await this.audit.insertAudit(tx, admin.id, 'order.refund', order.id, {
      refund_id: refund.refund_ref,
      amount_satang: input.amount_satang,
    });
    return {
      refund_id: refund.refund_ref,
      order_id: order.id,
      amount_satang: input.amount_satang,
      status: 'PENDING',
      remaining_satang: plan.remainingAfterSatang,
    };
  }

  /**
   * ADR 0004: FAILED -> NEEDS_REVIEW -> PAID -> IN_QUEUE, or from NEEDS_REVIEW. The worker asks
   * GET /topups before any POST, so this cannot top up again even if the earlier call landed.
   */
  async retryFulfillment(orderId: string, body: unknown, admin: Admin) {
    const { reason } = parseWith(retrySchema, body);
    const actor = adminActor(admin);

    await this.orders.transaction(async (tx) => {
      const order = await this.ops.lockOrder(tx, orderId);
      if (!order) throw orderNotFound();
      if (order.status !== 'FAILED' && order.status !== 'NEEDS_REVIEW') {
        throw new DomainError('INVALID_TRANSITION', `an order in ${order.status} cannot be retried`);
      }
      // Some of the money is already on its way back, so delivering would give the goods for free.
      if (toSatang(order.refunded_satang) > 0) {
        throw new ProblemError(409, 'REFUND_IN_PROGRESS', 'this order has a refund, so it cannot be retried');
      }
      if (toSatang(order.paid_satang) < toSatang(order.total_satang)) {
        throw new ProblemError(409, 'ORDER_NOT_RETRYABLE', 'this order was not paid in full');
      }
      // An order that never reached the queue may have given back its stock and voucher.
      if (!(await this.ops.wasQueued(tx, order.id))) {
        throw new ProblemError(409, 'ORDER_NOT_RETRYABLE', 'this order never reached fulfillment');
      }

      if (order.status === 'FAILED') {
        assertTransition('FAILED', 'NEEDS_REVIEW');
        await this.ops.transition(tx, order.id, 'FAILED', 'NEEDS_REVIEW', actor, reason);
      }
      assertTransition('NEEDS_REVIEW', 'PAID');
      assertTransition('PAID', 'IN_QUEUE');
      await this.ops.transition(tx, order.id, 'NEEDS_REVIEW', 'PAID', actor, reason);
      await this.ops.transition(tx, order.id, 'PAID', 'IN_QUEUE', actor, 'fulfillment queued again');
      await this.ops.resolveDeadLetters(tx, order.id, actor);
      if (!(await this.ops.enqueueFulfillment(tx, order.id))) {
        throw new ProblemError(409, 'FULFILLMENT_ALREADY_QUEUED', 'a job for this order is still open');
      }
      await this.audit.insertAudit(tx, admin.id, 'order.retry_fulfillment', order.id, { reason });
    });
    await this.signal.wake();
    return { order_id: orderId, status: 'IN_QUEUE' };
  }
}
