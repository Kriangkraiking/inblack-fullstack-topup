import { DomainError } from './errors.js';

/**
 * All arithmetic is on bigint, so division truncates and a fraction can never
 * exist. Amounts cross the package boundary as `number` holding a safe integer
 * because they end up in JSON.
 */

export function assertSatang(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError('INVALID_AMOUNT', `${label} must be a non-negative integer satang value`);
  }
}

export function fromBigInt(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError('INVALID_AMOUNT', `${label} is out of range`);
  }
  return Number(value);
}

/**
 * Converts a value read from Postgres to satang. `pg` returns bigint columns as
 * strings, and this rejects anything that is not a plain non-negative integer.
 */
export function toSatang(value: string | number | bigint): number {
  if (typeof value === 'number') {
    assertSatang(value, 'amount');
    return value;
  }
  if (typeof value === 'bigint') return fromBigInt(value, 'amount');
  if (!/^[0-9]+$/.test(value)) {
    throw new DomainError('INVALID_AMOUNT', 'amount must contain digits only');
  }
  return fromBigInt(BigInt(value), 'amount');
}

function assertDivisible(a: bigint, b: bigint): void {
  if (a < 0n || b <= 0n) throw new RangeError('expected a >= 0 and b > 0');
}

export function floorDiv(a: bigint, b: bigint): bigint {
  assertDivisible(a, b);
  return a / b;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  assertDivisible(a, b);
  return (a + b - 1n) / b;
}

/** Exactly .5 rounds up. */
export function roundHalfUpDiv(a: bigint, b: bigint): bigint {
  assertDivisible(a, b);
  return (2n * a + b) / (2n * b);
}
