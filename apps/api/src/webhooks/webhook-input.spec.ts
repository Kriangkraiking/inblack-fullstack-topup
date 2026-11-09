import { createHmac } from 'node:crypto';
import { assertValidSignature, parseWebhookEvent } from './webhook-input.js';

const SECRET = 'whsec_test';
const NOW = 1_800_000_000;
const BODY = Buffer.from('{ "a": 1,   "b": 2 }');

function sign(timestamp: number, body: Buffer = BODY, secret = SECRET) {
  const hmac = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

const code = { code: 'INVALID_SIGNATURE', status: 401 };

describe('assertValidSignature', () => {
  it('accepts the exact bytes that were signed', () => {
    expect(() => assertValidSignature(sign(NOW), BODY, SECRET, NOW)).not.toThrow();
  });

  it('accepts a timestamp exactly 300 seconds away', () => {
    expect(() => assertValidSignature(sign(NOW - 300), BODY, SECRET, NOW)).not.toThrow();
    expect(() => assertValidSignature(sign(NOW + 300), BODY, SECRET, NOW)).not.toThrow();
  });

  it.each([NOW - 301, NOW + 301])('rejects a timestamp more than 300 seconds away: %d', (t) => {
    expect(() => assertValidSignature(sign(t), BODY, SECRET, NOW)).toThrow(
      expect.objectContaining(code) as Error,
    );
  });

  it('rejects a body changed by one byte', () => {
    const changed = Buffer.from(BODY);
    changed[0] = changed[0] ^ 1;
    expect(() => assertValidSignature(sign(NOW), changed, SECRET, NOW)).toThrow(
      expect.objectContaining(code) as Error,
    );
  });

  it('rejects another secret', () => {
    expect(() => assertValidSignature(sign(NOW, BODY, 'other'), BODY, SECRET, NOW)).toThrow(
      expect.objectContaining(code) as Error,
    );
  });

  it.each([undefined, '', 't=1', 'v1=aa', 't=abc,v1=00', `t=${NOW},v1=zz`, `t=${NOW},v1=abcd`])(
    'rejects the malformed header %s without crashing',
    (header) => {
      expect(() => assertValidSignature(header, BODY, SECRET, NOW)).toThrow(
        expect.objectContaining(code) as Error,
      );
    },
  );
});

describe('parseWebhookEvent', () => {
  const valid = {
    event_id: 'evt_1',
    type: 'payment.succeeded',
    order_id: 'ORD-2587965432159-229',
    amount_satang: 66980,
    currency: 'THB',
    occurred_at: '2026-11-06T10:15:00Z',
  };

  it('accepts the shape from spec section 6', () => {
    expect(parseWebhookEvent(valid).amount_satang).toBe(66980);
  });

  it.each([
    ['a fractional amount', { amount_satang: 1.5 }],
    ['a string amount', { amount_satang: '100' }],
    ['a negative amount', { amount_satang: -1 }],
    ['an unknown type', { type: 'payment.other' }],
    ['a NUL in event_id', { event_id: 'a\u0000b' }],
    ['a bad date', { occurred_at: 'yesterday' }],
  ])('rejects %s with 422', (_, change) => {
    expect(() => parseWebhookEvent({ ...valid, ...change })).toThrow(
      expect.objectContaining({ status: 422 }) as Error,
    );
  });
});
