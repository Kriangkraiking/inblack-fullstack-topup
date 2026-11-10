import type { DiscountRule } from "@inblack/domain";

/**
 * Discount rules of the seeded codes (spec 4, db/seed/seed.sql), used only to
 * preview the price while the customer types. The API has no endpoint to look a
 * code up, and it recalculates and locks the real price when the order is made,
 * so a code that is not listed here is still sent and checked there.
 */
export const KNOWN_VOUCHERS: Readonly<Record<string, DiscountRule>> = {
  SAVE10: { type: "PERCENT", percentBps: 1000, capSatang: 5000, minSubtotalSatang: 20000 },
  FLAT20: { type: "FIXED", fixedSatang: 2000, minSubtotalSatang: 10000 },
};
