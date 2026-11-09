import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ProblemError } from '../common/problem.js';
import { parseWith } from '../common/validate.js';

const MAX_SKEW_SECONDS = 300;
const SIGNATURE_FORMAT = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

function invalidSignature(detail: string): ProblemError {
  return new ProblemError(401, 'INVALID_SIGNATURE', detail);
}

/**
 * Signs the bytes as they arrived, never the parsed JSON. The format is checked first, so both
 * sides of timingSafeEqual are always 32 bytes and it cannot throw on a hostile header.
 */
export function assertValidSignature(
  header: string | undefined,
  rawBody: Buffer,
  secret: string,
  nowSeconds: number,
): void {
  const match = SIGNATURE_FORMAT.exec(header ?? '');
  if (!match) throw invalidSignature('X-IBM-Signature is missing or malformed');

  const [, timestamp, signature] = match;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
    throw invalidSignature('signature does not match');
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) {
    throw invalidSignature('signature timestamp is too far from the current time');
  }
}

// The patterns also keep out characters Postgres text cannot store, such as NUL.
const providerId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

const eventSchema = z.object({
  event_id: providerId,
  type: z.enum(['payment.succeeded', 'payment.failed', 'payment.refunded']),
  order_id: providerId,
  amount_satang: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurred_at: z.iso.datetime({ offset: true }),
});

export type WebhookEvent = z.output<typeof eventSchema>;

export function parseWebhookEvent(body: unknown): WebhookEvent {
  return parseWith(eventSchema, body);
}
