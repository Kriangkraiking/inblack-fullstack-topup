import { createHash } from 'node:crypto';
import {
  DomainError,
  isValidGameUid,
  mergeCartLines,
  normalizeEmail,
  normalizeVoucherCode,
  PAYMENT_METHODS,
  type CartLine,
  type PaymentMethod,
} from '@inblack/domain';
import { ProblemError } from '../common/problem.js';

const MAX_LINES = 20;
/** Keeps prices far from the integer limits. The spec sets no limit of its own. */
const MAX_QTY_PER_SKU = 1000;
const MAX_KEY_LENGTH = 255;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

export interface OrderInput {
  email: string;
  gameUid: string;
  paymentMethod: PaymentMethod;
  voucherCode: string | null;
  /** Merged by SKU and sorted, which is also the order stock rows get locked in. */
  lines: CartLine[];
}

function invalid(detail: string): ProblemError {
  return new ProblemError(422, 'VALIDATION_ERROR', detail);
}

export function parseEmail(value: unknown): string {
  if (typeof value !== 'string') throw invalid('email must be a string');
  const email = normalizeEmail(value);
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw invalid('email is not a valid address');
  }
  return email;
}

function parseLines(value: unknown): CartLine[] {
  if (!Array.isArray(value)) throw invalid('items must be an array');
  if (value.length > MAX_LINES) throw invalid(`items can hold at most ${MAX_LINES} lines`);
  const lines = value.map((entry: unknown): CartLine => {
    const line = entry as { sku?: unknown; qty?: unknown } | null;
    if (typeof line?.sku !== 'string' || line.sku === '') {
      throw invalid('each item needs a sku');
    }
    return { sku: line.sku, qty: line.qty as number };
  });
  const merged = mergeCartLines(lines);
  if (merged.some((line) => line.qty > MAX_QTY_PER_SKU)) {
    throw new DomainError('INVALID_QUANTITY', `at most ${MAX_QTY_PER_SKU} of one product per order`);
  }
  return merged.sort((a, b) => (a.sku < b.sku ? -1 : 1));
}

export function parseOrderInput(body: unknown): OrderInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('the request body must be a JSON object');
  }
  const input = body as Record<string, unknown>;

  const gameUid = input.game_uid;
  if (typeof gameUid !== 'string' || !isValidGameUid(gameUid)) {
    throw invalid('game_uid must be 4 to 32 letters, digits, - or _');
  }
  const paymentMethod = input.payment_method;
  if (!PAYMENT_METHODS.includes(paymentMethod as PaymentMethod)) {
    throw invalid(`payment_method must be one of ${PAYMENT_METHODS.join(', ')}`);
  }
  const voucherCode = input.voucher_code ?? null;
  if (voucherCode !== null && typeof voucherCode !== 'string') {
    throw invalid('voucher_code must be a string');
  }

  return {
    email: parseEmail(input.email),
    gameUid,
    paymentMethod: paymentMethod as PaymentMethod,
    voucherCode: voucherCode ? normalizeVoucherCode(voucherCode) || null : null,
    lines: parseLines(input.items),
  };
}

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new ProblemError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'the Idempotency-Key header is required');
  }
  if (value.length > MAX_KEY_LENGTH) {
    throw new ProblemError(400, 'IDEMPOTENCY_KEY_INVALID', `Idempotency-Key can be at most ${MAX_KEY_LENGTH} characters`);
  }
  return value;
}

/** Object keys are sorted, so reordering or reformatting JSON is still the same request. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    const fields = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}
