import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Spec 8.4: 6 digits, valid 5 minutes, 5 wrong codes lock the email for 15 minutes. */
export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_MAX_FAILURES = 5;
export const OTP_LOCK_SECONDS = 15 * 60;
/** A new code for the same email at most this often, kept in Postgres so it holds without Redis. */
export const OTP_COOLDOWN_SECONDS = 30;

/** From the CSPRNG. randomInt is uniform, so no digit is more likely than another. */
export function generateOtpCode(random: (max: number) => number = (max) => randomInt(max)): string {
  return String(random(1_000_000)).padStart(6, '0');
}

export const OTP_CODE_PATTERN = /^[0-9]{6}$/;

export function otpSecret(raw = process.env.OTP_HASH_SECRET): string {
  if (!raw || raw.length < 16) throw new Error('OTP_HASH_SECRET must be at least 16 characters');
  return raw;
}

/**
 * Only this goes into Postgres. A plain SHA-256 of a 6-digit code can be reversed by trying all
 * million codes, a keyed HMAC cannot without the key. The email is part of the input, so one
 * hash is useless for any other address.
 */
export function hashOtp(secret: string, email: string, code: string): string {
  return createHmac('sha256', secret).update(`${email}\n${code}`).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** What Postgres holds for one email, read under FOR UPDATE. */
export interface OtpState {
  codeHash: string | null;
  expired: boolean;
  consumed: boolean;
  failedAttempts: number;
  /** Seconds left on the lock, or null when not locked. */
  lockedForSeconds: number | null;
}

export type VerifyDecision =
  | { kind: 'no-code' }
  | { kind: 'locked'; retryAfterSeconds: number }
  | { kind: 'stale' }
  | { kind: 'wrong'; failedAttempts: number }
  | { kind: 'lock'; retryAfterSeconds: number }
  | { kind: 'accept' };

/**
 * Pure, so every branch has a unit test. The right code after it was used or expired is refused
 * without counting a failure: only someone who had the code can send it, so it is no guess, and
 * a double-clicked or raced submit must not lock out the person who just signed in. Every other
 * miss counts, including a wrong code while the stored one is used or expired.
 */
export function decideVerify(state: OtpState | undefined, submittedHash: string): VerifyDecision {
  if (!state) return { kind: 'no-code' };
  if (state.lockedForSeconds !== null && state.lockedForSeconds > 0) {
    return { kind: 'locked', retryAfterSeconds: state.lockedForSeconds };
  }
  if (state.codeHash !== null && sameHash(state.codeHash, submittedHash)) {
    return state.expired || state.consumed ? { kind: 'stale' } : { kind: 'accept' };
  }
  const failedAttempts = state.failedAttempts + 1;
  if (failedAttempts >= OTP_MAX_FAILURES) return { kind: 'lock', retryAfterSeconds: OTP_LOCK_SECONDS };
  return { kind: 'wrong', failedAttempts };
}
