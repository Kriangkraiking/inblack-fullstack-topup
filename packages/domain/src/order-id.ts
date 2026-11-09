import { DomainError } from './errors.js';

const ORDER_ID_PATTERN = /^ORD-([0-9]{13})-([0-9]{3})$/;
const DIGIT_COUNT = 13;

export type RandomBytes = (buffer: Uint8Array<ArrayBuffer>) => void;

/** Web Crypto is a CSPRNG in both Node 22 and browsers, and the web app imports this package too. */
const cryptoRandomBytes: RandomBytes = (buffer) => {
  globalThis.crypto.getRandomValues(buffer);
};

export function orderIdChecksum(digits: string): string {
  if (!/^[0-9]{13}$/.test(digits)) {
    throw new DomainError('INVALID_ORDER_ID', 'expected exactly 13 digits');
  }
  return String(BigInt(digits) % 997n).padStart(3, '0');
}

export function generateOrderId(randomBytes: RandomBytes = cryptoRandomBytes): string {
  let digits = '';
  const buffer = new Uint8Array(32);
  while (digits.length < DIGIT_COUNT) {
    randomBytes(buffer);
    for (const byte of buffer) {
      // Bytes from 250 up are dropped, otherwise low digits would be slightly more likely.
      if (byte < 250 && digits.length < DIGIT_COUNT) digits += String(byte % 10);
    }
  }
  return `ORD-${digits}-${orderIdChecksum(digits)}`;
}

export function isValidOrderId(orderId: string): boolean {
  const match = ORDER_ID_PATTERN.exec(orderId);
  return match !== null && orderIdChecksum(match[1]) === match[2];
}

export function assertValidOrderId(orderId: string): void {
  if (!isValidOrderId(orderId)) {
    throw new DomainError('INVALID_ORDER_ID', 'order id format or checksum is invalid');
  }
}
