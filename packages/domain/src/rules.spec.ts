import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { canTransition, ORDER_STATUSES } from './order-state.js';
import {
  assertPerEmailLimit,
  assertPerOrderLimit,
  assertVoucherUsable,
  countsTowardEmailLimit,
  mergeCartLines,
  normalizeEmail,
  normalizeVoucherCode,
  planRefund,
  REFUNDABLE_STATUSES,
} from './rules.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
};

const SAVE10 = { active: true, maxUses: 10, usedCount: 0, maxUsesPerEmail: 1 };
const FLAT20 = { active: true, maxUses: null, usedCount: 999999, maxUsesPerEmail: null };
const MONTHLY = { maxQtyPerOrder: 1, maxQtyPerEmail: null };
const FLASH = { maxQtyPerOrder: null, maxQtyPerEmail: 2 };
const UNLIMITED = { maxQtyPerOrder: null, maxQtyPerEmail: null };

describe('normalization', () => {
  it('makes email and code comparisons case-insensitive', () => {
    expect(normalizeEmail('  A.B@Example.COM ')).toBe('a.b@example.com');
    expect(normalizeVoucherCode(' save10 ')).toBe('SAVE10');
  });
});

describe('voucher usability', () => {
  it('accepts up to the 10th use and rejects the 11th', () => {
    expect(codeOf(() => assertVoucherUsable({ ...SAVE10, usedCount: 9 }, 0))).toBeUndefined();
    expect(codeOf(() => assertVoucherUsable({ ...SAVE10, usedCount: 10 }, 0))).toBe(
      'VOUCHER_EXHAUSTED',
    );
  });

  it('rejects a second use by the same email', () => {
    expect(codeOf(() => assertVoucherUsable(SAVE10, 1))).toBe('PER_CUSTOMER_LIMIT');
  });

  it('lets FLAT20 be used without any limit', () => {
    expect(codeOf(() => assertVoucherUsable(FLAT20, 500))).toBeUndefined();
  });

  it('rejects an inactive voucher', () => {
    expect(codeOf(() => assertVoucherUsable({ ...FLAT20, active: false }, 0))).toBe(
      'VOUCHER_INACTIVE',
    );
  });
});

describe('product limits', () => {
  it('merges repeated SKUs, so MONTHLY-PASS cannot be split across lines', () => {
    const merged = mergeCartLines([
      { sku: 'MONTHLY-PASS', qty: 1 },
      { sku: 'FLASH-SKIN-01', qty: 1 },
      { sku: 'MONTHLY-PASS', qty: 1 },
    ]);
    expect(merged).toEqual([
      { sku: 'MONTHLY-PASS', qty: 2 },
      { sku: 'FLASH-SKIN-01', qty: 1 },
    ]);
    expect(codeOf(() => assertPerOrderLimit(MONTHLY, merged[0].qty))).toBe('PER_ORDER_LIMIT');
  });

  it('rejects bad cart input', () => {
    expect(codeOf(() => mergeCartLines([]))).toBe('EMPTY_CART');
    for (const qty of [0, -1, 1.5]) {
      expect(codeOf(() => mergeCartLines([{ sku: 'X', qty }]))).toBe('INVALID_QUANTITY');
    }
  });

  it('allows MONTHLY-PASS x1 and unlimited products at any quantity', () => {
    expect(codeOf(() => assertPerOrderLimit(MONTHLY, 1))).toBeUndefined();
    expect(codeOf(() => assertPerOrderLimit(UNLIMITED, 1000))).toBeUndefined();
  });

  it('allows FLASH-SKIN-01 up to 2 per email across orders', () => {
    expect(codeOf(() => assertPerEmailLimit(FLASH, 0, 2))).toBeUndefined();
    expect(codeOf(() => assertPerEmailLimit(FLASH, 1, 1))).toBeUndefined();
    expect(codeOf(() => assertPerEmailLimit(FLASH, 0, 3))).toBe('PER_CUSTOMER_LIMIT');
    expect(codeOf(() => assertPerEmailLimit(FLASH, 2, 1))).toBe('PER_CUSTOMER_LIMIT');
    expect(codeOf(() => assertPerEmailLimit(UNLIMITED, 99, 99))).toBeUndefined();
  });

  it('stops counting expired, failed and refunded orders, and counts the rest', () => {
    const notCounted = ORDER_STATUSES.filter((s) => !countsTowardEmailLimit(s)).sort();
    expect(notCounted).toEqual(['EXPIRED', 'FAILED', 'PAYMENT_FAILED', 'REFUNDED']);
    expect(countsTowardEmailLimit('NEEDS_REVIEW')).toBe(true);
    expect(countsTowardEmailLimit('PENDING_PAYMENT')).toBe(true);
  });
});

describe('refund planning', () => {
  it('a partial refund does not finish the order', () => {
    expect(planRefund({ paidSatang: 66980, alreadyRefundedSatang: 0, amountSatang: 1 })).toEqual({
      remainingAfterSatang: 66979,
      isFullyRefunded: false,
    });
  });

  it('the refund clearing the remainder does', () => {
    expect(
      planRefund({ paidSatang: 66980, alreadyRefundedSatang: 60000, amountSatang: 6980 }),
    ).toEqual({ remainingAfterSatang: 0, isFullyRefunded: true });
  });

  it('rejects going over by one satang, and a zero or fractional amount', () => {
    expect(
      codeOf(() =>
        planRefund({ paidSatang: 66980, alreadyRefundedSatang: 60000, amountSatang: 6981 }),
      ),
    ).toBe('REFUND_EXCEEDS_PAID');
    expect(
      codeOf(() => planRefund({ paidSatang: 100, alreadyRefundedSatang: 0, amountSatang: 0 })),
    ).toBe('INVALID_AMOUNT');
    expect(
      codeOf(() => planRefund({ paidSatang: 100, alreadyRefundedSatang: 0, amountSatang: 0.5 })),
    ).toBe('INVALID_AMOUNT');
  });

  it('every refundable status has a path to REFUNDED', () => {
    for (const status of REFUNDABLE_STATUSES) expect(canTransition(status, 'REFUNDED')).toBe(true);
  });
});
