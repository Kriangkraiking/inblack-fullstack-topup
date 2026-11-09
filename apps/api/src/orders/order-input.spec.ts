import { DomainError } from '@inblack/domain';
import { ProblemError } from '../common/problem.js';
import {
  canonicalJson,
  hashRequest,
  parseIdempotencyKey,
  parseOrderInput,
} from './order-input.js';

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

  it('treats a missing or blank voucher as none', () => {
    expect(parseOrderInput({ ...VALID, voucher_code: undefined }).voucherCode).toBeNull();
    expect(parseOrderInput({ ...VALID, voucher_code: '  ' }).voucherCode).toBeNull();
  });

  it.each([
    ['a non-object body', null, 'VALIDATION_ERROR'],
    ['an array body', [], 'VALIDATION_ERROR'],
    ['a bad email', { ...VALID, email: 'nope' }, 'VALIDATION_ERROR'],
    ['a bad game uid', { ...VALID, game_uid: 'a b' }, 'VALIDATION_ERROR'],
    ['an unknown method', { ...VALID, payment_method: 'CASH' }, 'VALIDATION_ERROR'],
    ['a number as voucher', { ...VALID, voucher_code: 10 }, 'VALIDATION_ERROR'],
    ['items that are not a list', { ...VALID, items: 'x' }, 'VALIDATION_ERROR'],
    ['an item without sku', { ...VALID, items: [{ qty: 1 }] }, 'VALIDATION_ERROR'],
    ['no items', { ...VALID, items: [] }, 'EMPTY_CART'],
    ['a zero qty', { ...VALID, items: [{ sku: 'A', qty: 0 }] }, 'INVALID_QUANTITY'],
    ['a fractional qty', { ...VALID, items: [{ sku: 'A', qty: 1.5 }] }, 'INVALID_QUANTITY'],
    ['a string qty', { ...VALID, items: [{ sku: 'A', qty: '1' }] }, 'INVALID_QUANTITY'],
    [
      'split lines over the cap',
      { ...VALID, items: [{ sku: 'A', qty: 600 }, { sku: 'A', qty: 600 }] },
      'INVALID_QUANTITY',
    ],
  ])('rejects %s', (_name, body, code) => {
    expect(codeOf(() => parseOrderInput(body))).toBe(code);
  });
});

describe('parseIdempotencyKey', () => {
  it('needs a non-empty header of a sane length', () => {
    expect(parseIdempotencyKey('abc')).toBe('abc');
    expect(codeOf(() => parseIdempotencyKey(undefined))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(codeOf(() => parseIdempotencyKey(''))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(codeOf(() => parseIdempotencyKey('x'.repeat(256)))).toBe('IDEMPOTENCY_KEY_INVALID');
  });
});

describe('hashRequest', () => {
  it('ignores key order at every level', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
  });

  it('tells different bodies apart', () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest({ a: [1, 2] })).not.toBe(hashRequest({ a: [2, 1] }));
    expect(hashRequest({ a: '1' })).not.toBe(hashRequest({ a: 1 }));
  });
});
