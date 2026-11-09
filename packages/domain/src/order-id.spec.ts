import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  assertValidOrderId,
  generateOrderId,
  isValidOrderId,
  orderIdChecksum,
} from './order-id.js';

describe('checksum', () => {
  it('accepts the valid example from spec 5.1', () => {
    expect(isValidOrderId('ORD-2587965432159-229')).toBe(true);
  });

  it('rejects the invalid example from spec 5.1', () => {
    expect(isValidOrderId('ORD-2587965432159-458')).toBe(false);
    expect(() => assertValidOrderId('ORD-2587965432159-458')).toThrow(DomainError);
  });

  it('pads the checksum to 3 digits and keeps leading zeros in the number', () => {
    expect(orderIdChecksum('0000000000000')).toBe('000');
    expect(orderIdChecksum('0000000000005')).toBe('005');
    expect(orderIdChecksum('0000000000997')).toBe('000');
    expect(orderIdChecksum('0000000000996')).toBe('996');
    expect(isValidOrderId('ORD-0000000000005-005')).toBe(true);
  });

  it.each([
    '',
    'ORD-2587965432159',
    'ORD-258796543215-229',
    'ORD-25879654321590-229',
    'ORD-2587965432159-22',
    'ORD-2587965432159-2290',
    'ord-2587965432159-229',
    'ORD-258796543215a-229',
    ' ORD-2587965432159-229',
    'ORD-2587965432159-229\n',
  ])('rejects the malformed value %j', (value) => {
    expect(isValidOrderId(value)).toBe(false);
  });
});

describe('generation', () => {
  it('produces valid, distinct ids', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateOrderId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(isValidOrderId(id)).toBe(true);
  });

  it('uses the random source and skips biased bytes', () => {
    const id = generateOrderId((buffer) => {
      buffer.fill(255);
      buffer.set([250, 251, 3, 13, 23, 33, 43, 53, 63, 73, 83, 93, 103, 113, 123]);
    });
    expect(id).toBe(`ORD-3333333333333-${orderIdChecksum('3333333333333')}`);
  });

  it('keeps asking for bytes until it has 13 digits', () => {
    let calls = 0;
    const id = generateOrderId((buffer) => {
      calls += 1;
      buffer.fill(calls === 1 ? 255 : 7);
    });
    expect(calls).toBe(2);
    expect(isValidOrderId(id)).toBe(true);
  });
});
