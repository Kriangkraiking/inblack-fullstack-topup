import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  assertTransition,
  canTransition,
  decideLatePayment,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  type OrderStatus,
} from './order-state.js';

// Written out independently of ORDER_TRANSITIONS, so a typo in the table fails here.
const SPEC_DIAGRAM: ReadonlyArray<[OrderStatus, OrderStatus]> = [
  ['PENDING_PAYMENT', 'PAID'],
  ['PAID', 'IN_QUEUE'],
  ['IN_QUEUE', 'IN_PROGRESS'],
  ['IN_PROGRESS', 'COMPLETED'],
  ['PENDING_PAYMENT', 'EXPIRED'],
  ['PENDING_PAYMENT', 'PAYMENT_FAILED'],
  ['IN_PROGRESS', 'FAILED'],
  ['FAILED', 'REFUNDED'],
  ['COMPLETED', 'REFUNDED'],
];
const ADR_0004: ReadonlyArray<[OrderStatus, OrderStatus]> = [
  ['EXPIRED', 'PAID'],
  ['EXPIRED', 'REFUNDED'],
  ['NEEDS_REVIEW', 'PAID'],
  ['NEEDS_REVIEW', 'COMPLETED'],
  ['NEEDS_REVIEW', 'REFUNDED'],
];
const INTO_REVIEW = ORDER_STATUSES.filter((s) => s !== 'NEEDS_REVIEW').map(
  (s): [OrderStatus, OrderStatus] => [s, 'NEEDS_REVIEW'],
);

const key = (from: OrderStatus, to: OrderStatus) => `${from}->${to}`;
const allowed = new Set([...SPEC_DIAGRAM, ...ADR_0004, ...INTO_REVIEW].map(([f, t]) => key(f, t)));

const everyPair = ORDER_STATUSES.flatMap((from) =>
  ORDER_STATUSES.map((to): [OrderStatus, OrderStatus] => [from, to]),
);
const valid = everyPair.filter(([f, t]) => allowed.has(key(f, t)));
const invalid = everyPair.filter(([f, t]) => !allowed.has(key(f, t)));

describe('transition table', () => {
  it('covers every status and all 100 ordered pairs', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
    expect(valid.length + invalid.length).toBe(100);
    expect(valid.length).toBe(23);
  });

  it.each(valid)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(invalid)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    let thrown: unknown;
    try {
      assertTransition(from, to);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe('INVALID_TRANSITION');
  });
});

describe('spec 6 ordering rules', () => {
  it('payment.failed after payment.succeeded cannot move the order backwards', () => {
    for (const from of ['PAID', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'] as const) {
      expect(canTransition(from, 'PAYMENT_FAILED')).toBe(false);
      expect(canTransition(from, 'PENDING_PAYMENT')).toBe(false);
    }
  });

  it('nothing returns to PENDING_PAYMENT', () => {
    for (const from of ORDER_STATUSES) expect(canTransition(from, 'PENDING_PAYMENT')).toBe(false);
  });
});

describe('decideLatePayment', () => {
  it('continues when everything could be re-acquired', () => {
    expect(decideLatePayment({ amountMatchesTotal: true, reacquired: true })).toBe('REINSTATE');
  });

  it('refunds when it could not', () => {
    expect(decideLatePayment({ amountMatchesTotal: true, reacquired: false })).toBe('REFUND');
  });

  it('sends a wrong amount to review whatever the stock says', () => {
    expect(decideLatePayment({ amountMatchesTotal: false, reacquired: true })).toBe('NEEDS_REVIEW');
    expect(decideLatePayment({ amountMatchesTotal: false, reacquired: false })).toBe('NEEDS_REVIEW');
  });
});
