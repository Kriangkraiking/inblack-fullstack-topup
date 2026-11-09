import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { ceilDiv, floorDiv, roundHalfUpDiv, toSatang } from './money.js';
import {
  calculateDiscount,
  calculateFee,
  calculatePrice,
  calculateVat,
  type DiscountRule,
} from './pricing.js';

// Same values as db/seed/seed.sql and spec section 4.
const SAVE10: DiscountRule = {
  type: 'PERCENT',
  percentBps: 1000,
  capSatang: 5000,
  minSubtotalSatang: 20000,
};
const FLAT20: DiscountRule = { type: 'FIXED', fixedSatang: 2000, minSubtotalSatang: 10000 };

const DIAMOND_1000 = 34900;
const DIAMOND_5000 = 159000;
const MONTHLY_PASS = 17900;
const FLASH_SKIN = 9900;

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
};

describe('spec 5.2 worked examples', () => {
  it('DIAMOND-1000 x2, SAVE10, Card: 69800 5000 64800 2180 66980 4382', () => {
    expect(
      calculatePrice({
        lines: [{ unitPriceSatang: DIAMOND_1000, qty: 2 }],
        discount: SAVE10,
        paymentMethod: 'CARD',
      }),
    ).toEqual({
      subtotalSatang: 69800,
      discountSatang: 5000,
      netSatang: 64800,
      feeSatang: 2180,
      totalSatang: 66980,
      vatSatang: 4382,
    });
  });

  it('MONTHLY-PASS x1 + FLASH-SKIN-01 x1, FLAT20, TrueMoney: 27800 2000 25800 387 26187 1713', () => {
    expect(
      calculatePrice({
        lines: [
          { unitPriceSatang: MONTHLY_PASS, qty: 1 },
          { unitPriceSatang: FLASH_SKIN, qty: 1 },
        ],
        discount: FLAT20,
        paymentMethod: 'TRUEMONEY',
      }),
    ).toEqual({
      subtotalSatang: 27800,
      discountSatang: 2000,
      netSatang: 25800,
      feeSatang: 387,
      totalSatang: 26187,
      vatSatang: 1713,
    });
  });

  it('DIAMOND-5000 x1, SAVE10, PromptPay: 159000 5000 154000 0 154000 10075', () => {
    expect(
      calculatePrice({
        lines: [{ unitPriceSatang: DIAMOND_5000, qty: 1 }],
        discount: SAVE10,
        paymentMethod: 'PROMPTPAY',
      }),
    ).toEqual({
      subtotalSatang: 159000,
      discountSatang: 5000,
      netSatang: 154000,
      feeSatang: 0,
      totalSatang: 154000,
      vatSatang: 10075,
    });
  });
});

describe('integer division helpers', () => {
  it('floors', () => {
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(6n, 2n)).toBe(3n);
  });

  it('ceils, and leaves an exact division alone', () => {
    expect(ceilDiv(7n, 2n)).toBe(4n);
    expect(ceilDiv(6n, 2n)).toBe(3n);
    expect(ceilDiv(0n, 2n)).toBe(0n);
  });

  it('rounds half up on exactly .5', () => {
    expect(roundHalfUpDiv(5n, 2n)).toBe(3n);
    expect(roundHalfUpDiv(7n, 2n)).toBe(4n);
    expect(roundHalfUpDiv(49n, 10n)).toBe(5n);
    expect(roundHalfUpDiv(44n, 10n)).toBe(4n);
    expect(roundHalfUpDiv(0n, 10n)).toBe(0n);
  });

  it('rejects a negative dividend or a non-positive divisor', () => {
    expect(() => ceilDiv(-1n, 2n)).toThrow(RangeError);
    expect(() => floorDiv(1n, 0n)).toThrow(RangeError);
  });
});

describe('discount', () => {
  it('rejects a subtotal one satang below the minimum and accepts it at the minimum', () => {
    expect(errorCode(() => calculateDiscount(19999, SAVE10))).toBe('VOUCHER_MIN_SUBTOTAL');
    expect(calculateDiscount(20000, SAVE10)).toBe(2000);
    expect(errorCode(() => calculateDiscount(9999, FLAT20))).toBe('VOUCHER_MIN_SUBTOTAL');
    expect(calculateDiscount(10000, FLAT20)).toBe(2000);
  });

  it('rounds the percentage down', () => {
    expect(calculateDiscount(20009, SAVE10)).toBe(2000);
  });

  it('applies the cap from 50000 subtotal upward', () => {
    expect(calculateDiscount(49999, SAVE10)).toBe(4999);
    expect(calculateDiscount(50000, SAVE10)).toBe(5000);
    expect(calculateDiscount(50010, SAVE10)).toBe(5000);
  });

  it('never exceeds the subtotal', () => {
    const big: DiscountRule = { type: 'FIXED', fixedSatang: 5000, minSubtotalSatang: 0 };
    expect(calculateDiscount(3000, big)).toBe(3000);
  });

  it('takes no discount without a voucher', () => {
    const price = calculatePrice({
      lines: [{ unitPriceSatang: FLASH_SKIN, qty: 1 }],
      discount: null,
      paymentMethod: 'PROMPTPAY',
    });
    expect(price.discountSatang).toBe(0);
    expect(price.netSatang).toBe(9900);
  });
});

describe('fee', () => {
  it('rounds up, and adds nothing when the rate divides exactly', () => {
    expect(calculateFee(1000, 'TRUEMONEY')).toBe(15);
    expect(calculateFee(1001, 'TRUEMONEY')).toBe(16);
    expect(calculateFee(1000, 'CARD')).toBe(329);
    expect(calculateFee(1001, 'CARD')).toBe(330);
  });

  it('is charged on net, not subtotal', () => {
    const price = calculatePrice({
      lines: [{ unitPriceSatang: 100000, qty: 1 }],
      discount: SAVE10,
      paymentMethod: 'TRUEMONEY',
    });
    expect(price.netSatang).toBe(95000);
    expect(price.feeSatang).toBe(1425);
  });

  it('handles a zero net', () => {
    expect(calculateFee(0, 'PROMPTPAY')).toBe(0);
    expect(calculateFee(0, 'TRUEMONEY')).toBe(0);
    expect(calculateFee(0, 'CARD')).toBe(300);
  });
});

describe('vat', () => {
  it('rounds the ex-VAT amount to the nearest satang', () => {
    expect(calculateVat(0)).toBe(0);
    expect(calculateVat(1)).toBe(0); // 0.93 -> 1
    expect(calculateVat(53)).toBe(3); // 49.53 -> 50
    expect(calculateVat(54)).toBe(4); // 50.47 -> 50
    expect(calculateVat(107)).toBe(7); // exactly 100
    expect(calculateVat(10700)).toBe(700);
  });

  it('goes the right way at the totals closest to .5 from each side', () => {
    expect(calculateVat(23)).toBe(2); // 21.495 -> 21
    expect(calculateVat(130)).toBe(9); // 121.495 -> 121
    expect(calculateVat(84)).toBe(5); // 78.504 -> 79
  });

  it('can never land on exactly .5: 200 x total is even and an odd multiple of 107 is odd', () => {
    for (let total = 0n; total < 2140n; total += 1n) {
      expect((total * 200n) % 214n).not.toBe(107n);
    }
  });

  it('stays within half a satang of 7/107 of the total', () => {
    for (const total of [1, 99, 100, 1001, 26187, 66980, 154000, 99999999]) {
      const vat = BigInt(calculateVat(total));
      expect(vat * 214n <= BigInt(total) * 14n + 107n).toBe(true);
    }
  });
});

describe('invalid input and large values', () => {
  it('rejects bad quantities and an empty cart', () => {
    for (const qty of [0, -1, 1.5, Number.NaN]) {
      expect(
        errorCode(() =>
          calculatePrice({
            lines: [{ unitPriceSatang: 100, qty }],
            discount: null,
            paymentMethod: 'PROMPTPAY',
          }),
        ),
      ).toBe('INVALID_QUANTITY');
    }
    expect(
      errorCode(() => calculatePrice({ lines: [], discount: null, paymentMethod: 'PROMPTPAY' })),
    ).toBe('EMPTY_CART');
  });

  it('rejects a fractional or negative price', () => {
    for (const unitPriceSatang of [0.5, -1]) {
      expect(
        errorCode(() =>
          calculatePrice({
            lines: [{ unitPriceSatang, qty: 1 }],
            discount: null,
            paymentMethod: 'PROMPTPAY',
          }),
        ),
      ).toBe('INVALID_AMOUNT');
    }
  });

  it('stays exact on a large quantity', () => {
    const price = calculatePrice({
      lines: [{ unitPriceSatang: DIAMOND_5000, qty: 1_000_000 }],
      discount: SAVE10,
      paymentMethod: 'CARD',
    });
    expect(price.subtotalSatang).toBe(159_000_000_000);
    expect(price.netSatang).toBe(158_999_995_000);
    // 158999995000 x 29 / 1000 = 4610999855 exactly, plus 300.
    expect(price.feeSatang).toBe(4_610_999_855 + 300);
  });

  it('rejects a total above the safe integer range instead of losing precision', () => {
    expect(
      errorCode(() =>
        calculatePrice({
          lines: [{ unitPriceSatang: Number.MAX_SAFE_INTEGER, qty: 2 }],
          discount: null,
          paymentMethod: 'PROMPTPAY',
        }),
      ),
    ).toBe('INVALID_AMOUNT');
  });
});

describe('toSatang', () => {
  it('accepts the string form pg returns for bigint', () => {
    expect(toSatang('66980')).toBe(66980);
    expect(toSatang(66980n)).toBe(66980);
    expect(toSatang(66980)).toBe(66980);
  });

  it('rejects anything that is not a non-negative integer', () => {
    for (const bad of ['12.5', '-1', '1e3', '', 1.5, -1, '9007199254740992']) {
      expect(errorCode(() => toSatang(bad))).toBe('INVALID_AMOUNT');
    }
  });
});
