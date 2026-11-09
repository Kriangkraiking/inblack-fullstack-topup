import { DomainError } from './errors.js';

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'IN_QUEUE',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'REFUNDED',
  'EXPIRED',
  'PAYMENT_FAILED',
  'NEEDS_REVIEW',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The transition table. db/migrations/0002_orders.sql holds the same pairs for
 * the database trigger, and db/src/transitions.spec.ts fails if they drift.
 *
 * Edges not drawn in spec 5.3 are explained in docs/adr/0004-late-payment-after-expiry.md:
 * EXPIRED -> PAID | REFUNDED, and NEEDS_REVIEW -> PAID | COMPLETED | REFUNDED.
 * Every other status can enter NEEDS_REVIEW, as the last line of the diagram requires.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING_PAYMENT: ['PAID', 'EXPIRED', 'PAYMENT_FAILED', 'NEEDS_REVIEW'],
  PAID: ['IN_QUEUE', 'NEEDS_REVIEW'],
  IN_QUEUE: ['IN_PROGRESS', 'NEEDS_REVIEW'],
  IN_PROGRESS: ['COMPLETED', 'FAILED', 'NEEDS_REVIEW'],
  COMPLETED: ['REFUNDED', 'NEEDS_REVIEW'],
  FAILED: ['REFUNDED', 'NEEDS_REVIEW'],
  REFUNDED: ['NEEDS_REVIEW'],
  EXPIRED: ['PAID', 'REFUNDED', 'NEEDS_REVIEW'],
  PAYMENT_FAILED: ['NEEDS_REVIEW'],
  NEEDS_REVIEW: ['PAID', 'COMPLETED', 'REFUNDED'],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError('INVALID_TRANSITION', `cannot go from ${from} to ${to}`);
  }
}

export type LatePaymentDecision = 'REINSTATE' | 'REFUND' | 'NEEDS_REVIEW';

/**
 * What to do with payment.succeeded on an EXPIRED order (spec 6). The caller
 * re-acquires stock, the per-email allowance and the voucher in one transaction
 * and passes whether all of them succeeded.
 */
export function decideLatePayment(input: {
  amountMatchesTotal: boolean;
  reacquired: boolean;
}): LatePaymentDecision {
  if (!input.amountMatchesTotal) return 'NEEDS_REVIEW';
  return input.reacquired ? 'REINSTATE' : 'REFUND';
}
