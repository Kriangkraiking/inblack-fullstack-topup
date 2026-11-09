import { DomainError } from '@inblack/domain';
import { ProblemError } from '../common/problem.js';
import {
  hashRequest,
  parseIdempotencyKey,
  parseOrderInput,
  parseTrackInput,
} from './order-input.js';

const NUL = String.fromCharCode(0);

const VALID = {
  email: ' Buyer@Example.COM ',
  game_uid: 'player_01',
  payment_method: 'CARD',
  voucher_code: ' save10 ',
  items: [
    { sku: 'MONTHLY-PASS', qty: 1 },
    { sku: 'DIAMOND-1000', qty: 1 },
    { sku: 'DIAMOND-1000', qty: 1 },
  ],
};

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ProblemError || error instanceof DomainError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('parseOrderInput', () => {
  it('normalises the input, merges SKUs and sorts them for lock order', () => {
    expect(parseOrderInput(VALID)).toEqual({
      email: 'buyer@example.com',
      gameUid: 'player_01',
      paymentMethod: 'CARD',
      voucherCode: 'SAVE10',
      lines: [
        { sku: 'DIAMOND-1000', qty: 2 },
        { sku: 'MONTHLY-PASS', qty: 1 },
      ],
    });
  });

  it('treats a missing, null or blank voucher as none', () => {
    expect(parseOrderInput({ ...VALID, voucher_code: undefined }).voucherCode).toBeNull();
    expect(parseOrderInput({ ...VALID, voucher_code: null }).voucherCode).toBeNull();
    expect(parseOrderInput({ ...VALID, voucher_code: '  ' }).voucherCode).toBeNull();
  });

  it('ignores fields the schema does not name', () => {
    const input = parseOrderInput({ ...VALID, total_satang: 1, status: 'PAID' });
    expect(input).not.toHaveProperty('total_satang');
    expect(input).not.toHaveProperty('status');
  });

  it.each([
    ['no body', undefined, 'VALIDATION_ERROR'],
    ['a non-object body', null, 'VALIDATION_ERROR'],
    ['an array body', [], 'VALIDATION_ERROR'],
    ['a bad email', { ...VALID, email: 'nope' }, 'VALIDATION_ERROR'],
    ['a NUL in the email', { ...VALID, email: `a${NUL}@example.com` }, 'VALIDATION_ERROR'],
    ['a bad game uid', { ...VALID, game_uid: 'a b' }, 'VALIDATION_ERROR'],
    ['a NUL in the game uid', { ...VALID, game_uid: `abcd${NUL}` }, 'VALIDATION_ERROR'],
    ['an unknown method', { ...VALID, payment_method: 'CASH' }, 'VALIDATION_ERROR'],
    ['a number as voucher', { ...VALID, voucher_code: 10 }, 'VALIDATION_ERROR'],
    ['a NUL in the voucher', { ...VALID, voucher_code: `SAVE${NUL}` }, 'VALIDATION_ERROR'],
    ['items that are not a list', { ...VALID, items: 'x' }, 'VALIDATION_ERROR'],
    ['an item without sku', { ...VALID, items: [{ qty: 1 }] }, 'VALIDATION_ERROR'],
    ['a NUL in the sku', { ...VALID, items: [{ sku: `A${NUL}`, qty: 1 }] }, 'VALIDATION_ERROR'],
    ['too many lines', { ...VALID, items: Array(21).fill({ sku: 'A', qty: 1 }) }, 'VALIDATION_ERROR'],
    ['no items', { ...VALID, items: [] }, 'EMPTY_CART'],
    ['a zero qty', { ...VALID, items: [{ sku: 'A', qty: 0 }] }, 'INVALID_QUANTITY'],
    ['a fractional qty', { ...VALID, items: [{ sku: 'A', qty: 1.5 }] }, 'INVALID_QUANTITY'],
    ['a string qty', { ...VALID, items: [{ sku: 'A', qty: '1' }] }, 'INVALID_QUANTITY'],
    ['a huge qty', { ...VALID, items: [{ sku: 'A', qty: 1e308 }] }, 'INVALID_QUANTITY'],
    [
      'split lines over the cap',
      { ...VALID, items: [{ sku: 'A', qty: 600 }, { sku: 'A', qty: 600 }] },
      'INVALID_QUANTITY',
    ],
  ])('rejects %s', (_name, body, code) => {
    expect(codeOf(() => parseOrderInput(body))).toBe(code);
  });
});

describe('parseTrackInput', () => {
  const orderId = 'ORD-2587965432159-229';

  it('accepts a valid id and normalises the email', () => {
    expect(parseTrackInput({ order_id: orderId, email: 'A@Example.com' })).toEqual({
      orderId,
      email: 'a@example.com',
    });
  });

  it.each([
    ['no body', undefined, 'VALIDATION_ERROR'],
    ['a bad checksum', { order_id: 'ORD-2587965432159-458', email: 'a@b.co' }, 'INVALID_ORDER_ID'],
    ['a number as id', { order_id: 1, email: 'a@b.co' }, 'INVALID_ORDER_ID'],
    ['a bad email', { order_id: orderId, email: 'nope' }, 'VALIDATION_ERROR'],
    ['an object as email', { order_id: orderId, email: {} }, 'VALIDATION_ERROR'],
  ])('rejects %s', (_name, body, code) => {
    expect(codeOf(() => parseTrackInput(body))).toBe(code);
  });
});

describe('parseIdempotencyKey', () => {
  it('needs a non-empty printable header of a sane length', () => {
    expect(parseIdempotencyKey('abc')).toBe('abc');
    expect(codeOf(() => parseIdempotencyKey(undefined))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(codeOf(() => parseIdempotencyKey(''))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(codeOf(() => parseIdempotencyKey('x'.repeat(256)))).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(codeOf(() => parseIdempotencyKey('a b'))).toBe('IDEMPOTENCY_KEY_INVALID');
  });
});

describe('hashRequest', () => {
  it('sees through formatting, key order, email case and split lines', () => {
    const reordered = {
      items: [
        { qty: 2, sku: 'DIAMOND-1000' },
        { qty: 1, sku: 'MONTHLY-PASS' },
      ],
      voucher_code: 'SAVE10',
      payment_method: 'CARD',
      game_uid: 'player_01',
      email: 'buyer@example.com',
    };
    expect(hashRequest(parseOrderInput(reordered))).toBe(hashRequest(parseOrderInput(VALID)));
  });

  it('tells different requests apart', () => {
    const other = parseOrderInput({ ...VALID, game_uid: 'player_02' });
    expect(hashRequest(other)).not.toBe(hashRequest(parseOrderInput(VALID)));
  });
});
