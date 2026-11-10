import { createHash } from 'node:crypto';
import { ProblemError } from '../common/problem.js';

export interface RateRule {
  /** Part of the Redis key, so rules never share a counter. */
  name: string;
  limit: number;
  windowMs: number;
}

export interface WindowCount {
  count: number;
  ttlMs: number;
}

/** One counter per key and window. Redis in production, a Map in tests. */
export interface RateStore {
  hit(key: string, windowMs: number): Promise<WindowCount>;
}

/** Spec 8.4: 10 a minute per IP and 5 a minute per order id on POST /orders/track. */
export const TRACK_PER_IP: RateRule = { name: 'track-ip', limit: 10, windowMs: 60_000 };
export const TRACK_PER_ORDER: RateRule = { name: 'track-order', limit: 5, windowMs: 60_000 };
/** OTP sends cost an email each. Postgres also keeps a 30 s gap per email, see OTP_COOLDOWN. */
export const OTP_REQUEST_PER_IP: RateRule = { name: 'otp-req-ip', limit: 10, windowMs: 60_000 };
export const OTP_REQUEST_PER_EMAIL: RateRule = { name: 'otp-req-email', limit: 5, windowMs: 15 * 60_000 };
/** Guessing across many emails from one address. The per-email lock lives in Postgres. */
export const OTP_VERIFY_PER_IP: RateRule = { name: 'otp-verify-ip', limit: 60, windowMs: 60_000 };

/** Admin password guessing from one address. The per-email limit lives in Postgres (login-limit.ts). */
export const ADMIN_LOGIN_PER_IP: RateRule = { name: 'admin-login-ip', limit: 10, windowMs: 60_000 };

export function tooManyRequests(retryAfterSeconds: number): ProblemError {
  return new ProblemError(429, 'RATE_LIMITED', 'too many requests, try again later', {
    'Retry-After': String(retryAfterSeconds),
  });
}

/**
 * Fixed window counters. The subject is hashed so emails and IPs do not sit in Redis as text.
 * When the store fails the request is let through (fail open, ADR 0005): these limits slow
 * guessing down, and nothing that protects money or the OTP lock depends on them.
 */
export class RateLimiter {
  constructor(
    private readonly store: RateStore,
    private readonly onStoreError: (error: unknown) => void = () => undefined,
  ) {}

  async consume(rule: RateRule, subject: string): Promise<void> {
    const digest = createHash('sha256').update(subject).digest('hex').slice(0, 32);
    let result: WindowCount;
    try {
      result = await this.store.hit(`rl:${rule.name}:${digest}`, rule.windowMs);
    } catch (error) {
      this.onStoreError(error);
      return;
    }
    if (result.count > rule.limit) {
      throw tooManyRequests(Math.max(1, Math.ceil(result.ttlMs / 1000)));
    }
  }
}

/** For tests: the same fixed-window behaviour as the Redis script, on a clock you control. */
export class MemoryRateStore implements RateStore {
  private readonly windows = new Map<string, { count: number; endsAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, windowMs: number): Promise<WindowCount> {
    const at = this.now();
    let window = this.windows.get(key);
    if (!window || window.endsAt <= at) {
      window = { count: 0, endsAt: at + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return Promise.resolve({ count: window.count, ttlMs: window.endsAt - at });
  }
}
