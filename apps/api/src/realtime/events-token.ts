import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Lets the browser that tracked an order open its event stream without putting the email in a
 * URL. v1.<expiry in unix seconds>.<HMAC-SHA256 of order id and expiry>, base64url. It proves
 * someone passed POST /orders/track for this order recently and carries nothing else.
 */

export const EVENTS_TOKEN_TTL_SECONDS = 3600;
const VERSION = 'v1';
const TOKEN_PATTERN = /^v1\.(\d{10})\.([A-Za-z0-9_-]{43})$/;

function mac(secret: string, orderId: string, expiresAt: number): Buffer {
  return createHmac('sha256', secret).update(`order-events:${VERSION}:${orderId}:${expiresAt}`).digest();
}

export function signEventsToken(
  secret: string,
  orderId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = EVENTS_TOKEN_TTL_SECONDS,
): { token: string; expiresAt: number } {
  const expiresAt = nowSeconds + ttlSeconds;
  return {
    token: `${VERSION}.${expiresAt}.${mac(secret, orderId, expiresAt).toString('base64url')}`,
    expiresAt,
  };
}

/** Returns the expiry when the token is genuine, unexpired and for this order; null otherwise. */
export function verifyEventsToken(
  secret: string,
  orderId: string,
  token: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): number | null {
  if (typeof token !== 'string') return null;
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const expiresAt = Number(match[1]);
  const given = Buffer.from(match[2], 'base64url');
  const expected = mac(secret, orderId, expiresAt);
  // The MAC is compared before the expiry so the time taken does not depend on which one failed.
  const genuine = given.length === expected.length && timingSafeEqual(given, expected);
  return genuine && expiresAt > nowSeconds ? expiresAt : null;
}

/** Read once at startup. Compose sets a test value; production must set its own. */
export function eventsTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.ORDER_EVENTS_TOKEN_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('ORDER_EVENTS_TOKEN_SECRET must be set to at least 16 characters');
  }
  return secret;
}
