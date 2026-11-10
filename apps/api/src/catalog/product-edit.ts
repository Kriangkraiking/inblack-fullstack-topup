import { z } from 'zod';
import { ProblemError } from '../common/problem.js';

/**
 * superadmin edits to a product (spec 3). Pure: the schema and the stock rule, so both have unit
 * tests without a database. Prices already sold stay in order_items, which nobody may update.
 */

/** 1,000,000 baht. qty (at most a few hundred) times this stays far inside a safe integer. */
export const MAX_PRICE_SATANG = 100_000_000;
export const MAX_STOCK = 1_000_000;

export const skuSchema = z.string().regex(/^[A-Z0-9-]{1,64}$/);

// Control characters would break the e-mail receipt and log lines; anything printable is kept
// as typed, including markup, because every page renders the name as text (spec 8.4).
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !/\p{Cc}/u.test(value), 'must not contain control characters');

const stockSchema = z.number().int().min(0).max(MAX_STOCK).nullable();

export const productPatchSchema = z
  .strictObject({
    name: nameSchema.optional(),
    // A JSON number only: "100" or 1.5 is refused, never rounded.
    price_satang: z.number().int().min(1).max(MAX_PRICE_SATANG).optional(),
    stock: stockSchema.optional(),
    /** The stock the admin saw. Required with stock, so a sale in between is not overwritten. */
    expected_stock: stockSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.price_satang !== undefined || v.stock !== undefined, {
    message: 'send at least one of name, price_satang, stock',
  })
  .refine((v) => v.stock === undefined || v.expected_stock !== undefined, {
    message: 'expected_stock is required when stock is sent',
    path: ['expected_stock'],
  });

export type ProductPatch = z.output<typeof productPatchSchema>;

/**
 * Decides a stock change against the row read under FOR UPDATE.
 *
 * - expected_stock must equal the current stock, otherwise an order taken since the admin looked
 *   would be silently undone or doubled (409 STOCK_CHANGED, reload and try again).
 * - Switching between limited and unlimited is refused. release_order_holds gives stock back
 *   only to limited products, so orders taken while unlimited would add stock that was never
 *   taken after a switch to limited. Not needed for this release (see ADR 0001).
 *
 * Returns the stock to write, or undefined when stock is not part of the patch.
 */
export function decideStock(
  current: number | null,
  patch: Pick<ProductPatch, 'stock' | 'expected_stock'>,
): number | null | undefined {
  if (patch.stock === undefined) return undefined;
  if (patch.expected_stock !== current) {
    throw new ProblemError(409, 'STOCK_CHANGED', 'stock changed since it was read, reload and try again');
  }
  if ((current === null) !== (patch.stock === null)) {
    throw new ProblemError(
      409,
      'STOCK_MODE_LOCKED',
      'a product cannot switch between limited and unlimited stock',
    );
  }
  return patch.stock;
}
