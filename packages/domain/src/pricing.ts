import { DomainError } from './errors.js';
import { assertSatang, ceilDiv, floorDiv, fromBigInt, roundHalfUpDiv } from './money.js';

export const PAYMENT_METHODS = ['PROMPTPAY', 'TRUEMONEY', 'CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface PriceLine {
  unitPriceSatang: number;
  qty: number;
}

/** Percent is in basis points (1000 = 10%), so no rate is ever fractional. */
export type DiscountRule =
  | {
      type: 'PERCENT';
      percentBps: number;
      capSatang: number | null;
      minSubtotalSatang: number;
    }
  | {
      type: 'FIXED';
      fixedSatang: number;
      minSubtotalSatang: number;
    };

export interface PriceBreakdown {
  subtotalSatang: number;
  discountSatang: number;
  netSatang: number;
  feeSatang: number;
  totalSatang: number;
  vatSatang: number;
}

export function calculateSubtotal(lines: readonly PriceLine[]): number {
  if (lines.length === 0) throw new DomainError('EMPTY_CART', 'an order needs at least one item');
  let subtotal = 0n;
  for (const line of lines) {
    assertSatang(line.unitPriceSatang, 'unit price');
    if (!Number.isSafeInteger(line.qty) || line.qty <= 0) {
      throw new DomainError('INVALID_QUANTITY', 'quantity must be a positive integer');
    }
    subtotal += BigInt(line.unitPriceSatang) * BigInt(line.qty);
  }
  return fromBigInt(subtotal, 'subtotal');
}

/** The minimum spend is checked against subtotal, per spec 5.2 step 2. */
export function calculateDiscount(subtotalSatang: number, rule: DiscountRule): number {
  assertSatang(subtotalSatang, 'subtotal');
  if (subtotalSatang < rule.minSubtotalSatang) {
    throw new DomainError('VOUCHER_MIN_SUBTOTAL', 'subtotal is below the voucher minimum');
  }
  const subtotal = BigInt(subtotalSatang);
  let discount: bigint;
  if (rule.type === 'PERCENT') {
    discount = floorDiv(subtotal * BigInt(rule.percentBps), 10000n);
    if (rule.capSatang !== null && discount > BigInt(rule.capSatang)) {
      discount = BigInt(rule.capSatang);
    }
  } else {
    discount = BigInt(rule.fixedSatang);
  }
  // A discount can never push net below zero.
  return fromBigInt(discount > subtotal ? subtotal : discount, 'discount');
}

export function calculateFee(netSatang: number, method: PaymentMethod): number {
  assertSatang(netSatang, 'net');
  const net = BigInt(netSatang);
  switch (method) {
    case 'PROMPTPAY':
      return 0;
    case 'TRUEMONEY':
      return fromBigInt(ceilDiv(net * 15n, 1000n), 'fee');
    case 'CARD':
      return fromBigInt(ceilDiv(net * 29n, 1000n) + 300n, 'fee');
  }
}

export function calculateVat(totalSatang: number): number {
  assertSatang(totalSatang, 'total');
  const total = BigInt(totalSatang);
  return fromBigInt(total - roundHalfUpDiv(total * 100n, 107n), 'vat');
}

export function calculatePrice(input: {
  lines: readonly PriceLine[];
  discount: DiscountRule | null;
  paymentMethod: PaymentMethod;
}): PriceBreakdown {
  const subtotalSatang = calculateSubtotal(input.lines);
  const discountSatang = input.discount ? calculateDiscount(subtotalSatang, input.discount) : 0;
  const netSatang = fromBigInt(BigInt(subtotalSatang) - BigInt(discountSatang), 'net');
  const feeSatang = calculateFee(netSatang, input.paymentMethod);
  const totalSatang = fromBigInt(BigInt(netSatang) + BigInt(feeSatang), 'total');
  const vatSatang = calculateVat(totalSatang);
  return { subtotalSatang, discountSatang, netSatang, feeSatang, totalSatang, vatSatang };
}
