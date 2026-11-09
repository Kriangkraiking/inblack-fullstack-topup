import { createHash } from 'node:crypto';
import {
  DomainError,
  isValidGameUid,
  isValidOrderId,
  mergeCartLines,
  normalizeEmail,
  normalizeVoucherCode,
  PAYMENT_METHODS,
  type CartLine,
  type PaymentMethod,
} from '@inblack/domain';
import { z } from 'zod';
import { ProblemError } from '../common/problem.js';
import { parseWith } from '../common/validate.js';

const MAX_LINES = 20;
/** Keeps prices far from the integer limits. The spec sets no limit of its own. */
const MAX_QTY_PER_SKU = 1000;

// The patterns also keep out characters Postgres text cannot store, such as NUL.
const emailSchema = z
  .string()
  .transform(normalizeEmail)
  .pipe(z.email().max(254));

const orderSchema = z.object({
  email: emailSchema,
  game_uid: z.string().refine(isValidGameUid, 'must be 4 to 32 letters, digits, - or _'),
  payment_method: z.enum(PAYMENT_METHODS),
  voucher_code: z
    .string()
    .max(64)
    .transform(normalizeVoucherCode)
    .pipe(z.string().regex(/^[A-Z0-9_-]*$/))
    .nullish(),
  items: z
    .array(
      z.object({
        sku: z.string().regex(/^[A-Z0-9-]{1,64}$/),
        qty: z.number().int().min(1).max(MAX_QTY_PER_SKU),
      }),
    )
    .min(1)
    .max(MAX_LINES),
});

const trackSchema = z.object({
  order_id: z.string().refine(isValidOrderId, 'order id format or checksum is invalid'),
  email: emailSchema,
});

const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,255}$/);

export interface OrderInput {
  email: string;
  gameUid: string;
  paymentMethod: PaymentMethod;
  voucherCode: string | null;
  /** Merged by SKU and sorted, which is also the order stock rows get locked in. */
  lines: CartLine[];
}

export interface TrackInput {
  orderId: string;
  email: string;
}

function orderIssueCode(issue: z.core.$ZodIssue): string {
  if (issue.path[2] === 'qty') return 'INVALID_QUANTITY';
  if (issue.path.length === 1 && issue.path[0] === 'items' && issue.code === 'too_small') {
    return 'EMPTY_CART';
  }
  return 'VALIDATION_ERROR';
}

export function parseOrderInput(body: unknown): OrderInput {
  const input = parseWith(orderSchema, body, { codeFor: orderIssueCode });
  const lines = mergeCartLines(input.items);
  if (lines.some((line) => line.qty > MAX_QTY_PER_SKU)) {
    throw new DomainError('INVALID_QUANTITY', `at most ${MAX_QTY_PER_SKU} of one product per order`);
  }
  return {
    email: input.email,
    gameUid: input.game_uid,
    paymentMethod: input.payment_method,
    voucherCode: input.voucher_code || null,
    lines: lines.sort((a, b) => (a.sku < b.sku ? -1 : 1)),
  };
}

export function parseTrackInput(body: unknown): TrackInput {
  const input = parseWith(trackSchema, body, {
    codeFor: (issue) => (issue.path[0] === 'order_id' ? 'INVALID_ORDER_ID' : 'VALIDATION_ERROR'),
  });
  return { orderId: input.order_id, email: input.email };
}

export function parseIdempotencyKey(value: unknown): string {
  if (value === undefined || value === '') {
    throw new ProblemError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'the Idempotency-Key header is required');
  }
  return parseWith(idempotencyKeySchema, value, {
    status: 400,
    codeFor: () => 'IDEMPOTENCY_KEY_INVALID',
  });
}

/**
 * Hashes the validated input, not the raw body. Formatting, key order and unknown fields
 * then cannot make the same request look different, and the size of the input is bounded.
 */
export function hashRequest(input: OrderInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
