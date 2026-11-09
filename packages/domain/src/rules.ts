import { DomainError } from './errors.js';
import { assertSatang } from './money.js';
import type { OrderStatus } from './order-state.js';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeVoucherCode(code: string): string {
  return code.trim().toUpperCase();
}

// ---------- Game UID ----------

const GAME_UID_PATTERN = /^[A-Za-z0-9_-]{4,32}$/;

/** A format check only. Whether the player exists is the game's to say. */
export function isValidGameUid(gameUid: string): boolean {
  return GAME_UID_PATTERN.test(gameUid);
}

// ---------- Vouchers ----------

export interface VoucherState {
  active: boolean;
  maxUses: number | null;
  usedCount: number;
  maxUsesPerEmail: number | null;
}

/**
 * The pre-check that gives the customer a clear error. It does not stop races:
 * the conditional UPDATE and the unique index in the database do that.
 */
export function assertVoucherUsable(voucher: VoucherState, usesByThisEmail: number): void {
  if (!voucher.active) throw new DomainError('VOUCHER_INACTIVE', 'voucher is not active');
  if (voucher.maxUses !== null && voucher.usedCount >= voucher.maxUses) {
    throw new DomainError('VOUCHER_EXHAUSTED', 'voucher has no uses left');
  }
  if (voucher.maxUsesPerEmail !== null && usesByThisEmail >= voucher.maxUsesPerEmail) {
    throw new DomainError('PER_CUSTOMER_LIMIT', 'this email has already used the voucher');
  }
}

// ---------- Per-product limits ----------

export interface CartLine {
  sku: string;
  qty: number;
}

export interface ProductLimits {
  maxQtyPerOrder: number | null;
  maxQtyPerEmail: number | null;
}

/** Merges repeated SKUs, so splitting one item over two lines cannot dodge a limit. */
export function mergeCartLines(lines: readonly CartLine[]): CartLine[] {
  if (lines.length === 0) throw new DomainError('EMPTY_CART', 'an order needs at least one item');
  const merged = new Map<string, number>();
  for (const { sku, qty } of lines) {
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      throw new DomainError('INVALID_QUANTITY', 'quantity must be a positive integer');
    }
    merged.set(sku, (merged.get(sku) ?? 0) + qty);
  }
  return [...merged].map(([sku, qty]) => ({ sku, qty }));
}

export function assertPerOrderLimit(limits: ProductLimits, qty: number): void {
  if (limits.maxQtyPerOrder !== null && qty > limits.maxQtyPerOrder) {
    throw new DomainError('PER_ORDER_LIMIT', `at most ${limits.maxQtyPerOrder} per order`);
  }
}

/** Spec 4: orders that are expired, failed or refunded stop counting against the email. */
const STATUSES_NOT_COUNTED: readonly OrderStatus[] = [
  'EXPIRED',
  'FAILED',
  'PAYMENT_FAILED',
  'REFUNDED',
];

export function countsTowardEmailLimit(status: OrderStatus): boolean {
  return !STATUSES_NOT_COUNTED.includes(status);
}

export function assertPerEmailLimit(
  limits: ProductLimits,
  qtyAlreadyHeld: number,
  qtyRequested: number,
): void {
  if (limits.maxQtyPerEmail !== null && qtyAlreadyHeld + qtyRequested > limits.maxQtyPerEmail) {
    throw new DomainError('PER_CUSTOMER_LIMIT', `at most ${limits.maxQtyPerEmail} per email`);
  }
}

// ---------- Refunds ----------

/** Statuses where money may have been taken and no fulfilment is running. */
export const REFUNDABLE_STATUSES: readonly OrderStatus[] = [
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'NEEDS_REVIEW',
];

export interface RefundPlan {
  remainingAfterSatang: number;
  /** Only a refund that clears the remainder moves the order to REFUNDED. */
  isFullyRefunded: boolean;
}

export function planRefund(input: {
  paidSatang: number;
  alreadyRefundedSatang: number;
  amountSatang: number;
}): RefundPlan {
  const { paidSatang, alreadyRefundedSatang, amountSatang } = input;
  assertSatang(paidSatang, 'paid');
  assertSatang(alreadyRefundedSatang, 'refunded');
  assertSatang(amountSatang, 'refund');
  if (amountSatang === 0) throw new DomainError('INVALID_AMOUNT', 'refund must be above zero');
  const remainingAfter = BigInt(paidSatang) - BigInt(alreadyRefundedSatang) - BigInt(amountSatang);
  if (remainingAfter < 0n) {
    throw new DomainError('REFUND_EXCEEDS_PAID', 'refund is more than the remaining paid amount');
  }
  return { remainingAfterSatang: Number(remainingAfter), isFullyRefunded: remainingAfter === 0n };
}
