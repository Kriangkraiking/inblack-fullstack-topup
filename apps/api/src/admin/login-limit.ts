import { createHash } from 'node:crypto';
import { ProblemError } from '../common/problem.js';

/**
 * Admin login: at most 5 attempts per email in a fixed 15 minute window, counted in Postgres
 * (admin_login_attempts) before the password is checked, so the limit holds with Redis down and
 * two replicas share it. Unknown emails count the same way, so a 429 does not reveal an admin.
 */
export const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
export const ADMIN_LOGIN_WINDOW_SECONDS = 15 * 60;

/** The table key. Normalised email in, so Foo@X and foo@x share one counter. */
export function loginEmailKey(normalizedEmail: string): string {
  return createHash('sha256').update(`admin-login\n${normalizedEmail}`).digest('hex');
}

/** The key for a username sign-in. Lower-cased, so Admin and admin share one counter. */
export function loginUsernameKey(username: string): string {
  return createHash('sha256').update(`admin-login\nusername:${username.toLowerCase()}`).digest('hex');
}

export interface LoginAttempt {
  /** Attempts in the current window, this one included. */
  attempts: number;
  retryAfterSeconds: number;
}

export type LoginDecision = { kind: 'check-password' } | { kind: 'locked'; retryAfterSeconds: number };

/** Pure, so the boundary has a unit test: the 5th attempt is still checked, the 6th is not. */
export function decideLoginAttempt(attempt: LoginAttempt): LoginDecision {
  if (attempt.attempts <= ADMIN_LOGIN_MAX_ATTEMPTS) return { kind: 'check-password' };
  return { kind: 'locked', retryAfterSeconds: Math.max(1, attempt.retryAfterSeconds) };
}

export function loginLocked(retryAfterSeconds: number): ProblemError {
  return new ProblemError(429, 'LOGIN_LOCKED', 'too many sign-in attempts for this account, try again later', {
    'Retry-After': String(retryAfterSeconds),
  });
}

export function invalidCredentials(): ProblemError {
  return new ProblemError(401, 'INVALID_CREDENTIALS', 'login or password is incorrect');
}
