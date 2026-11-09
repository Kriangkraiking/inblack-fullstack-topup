import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Format: scrypt$N$r$p$<salt base64>$<hash base64>, see docs/SEED_CREDENTIALS.md. */
const FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
/** Twice what the seeded cost needs, and a bound on what a bad stored hash can ask for. */
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, length: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, length, { N: n, r, p, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = FORMAT.exec(stored);
  if (!match) return false;
  const expected = Buffer.from(match[5], 'base64');
  if (expected.length === 0) return false;
  const actual = await derive(
    password,
    Buffer.from(match[4], 'base64'),
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    expected.length,
  );
  return timingSafeEqual(actual, expected);
}

/**
 * Compared against when the email is unknown, so a wrong email costs the same time as a wrong
 * password. The random secret means no password can ever match it.
 */
export const DUMMY_HASH = [
  'scrypt',
  N,
  R,
  P,
  randomBytes(16).toString('base64'),
  randomBytes(KEY_LENGTH).toString('base64'),
].join('$');
