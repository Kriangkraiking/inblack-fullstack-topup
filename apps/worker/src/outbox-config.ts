function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

export interface OutboxConfig {
  pollMs: number;
  sweepMs: number;
  concurrency: number;
  leaseMs: number;
  postTimeoutMs: number;
  getTimeoutMs: number;
  settleMs: number;
  maxAttempts: number;
  maxPosts: number;
  backoffBaseMs: number;
  refundMaxAttempts: number;
  refundBackoffBaseMs: number;
  backoffCapMs: number;
}

/**
 * See ADR 0002 for how these numbers fit together.
 *
 * A job has at most 5 claims: GET and POST three times, then one last GET that decides. With the
 * defaults that takes about 3 x (8s POST + 5s settle + up to 4s backoff), plus 25s of lease after a
 * crash, so an order leaves IN_PROGRESS well inside the 2 minutes of spec section 7.
 */
export function loadOutboxConfig(env: NodeJS.ProcessEnv = process.env): OutboxConfig {
  const config: OutboxConfig = {
    pollMs: positiveInt(env, 'OUTBOX_POLL_MS', 1000),
    sweepMs: positiveInt(env, 'RECOVERY_SWEEP_MS', 30_000),
    concurrency: positiveInt(env, 'OUTBOX_CONCURRENCY', 20),
    leaseMs: positiveInt(env, 'OUTBOX_LEASE_MS', 25_000),
    postTimeoutMs: positiveInt(env, 'FULFILLMENT_POST_TIMEOUT_MS', 8000),
    getTimeoutMs: positiveInt(env, 'FULFILLMENT_GET_TIMEOUT_MS', 8000),
    settleMs: positiveInt(env, 'FULFILLMENT_SETTLE_MS', 5000),
    maxAttempts: positiveInt(env, 'FULFILLMENT_MAX_ATTEMPTS', 5),
    maxPosts: positiveInt(env, 'FULFILLMENT_MAX_POSTS', 3),
    backoffBaseMs: positiveInt(env, 'FULFILLMENT_BACKOFF_BASE_MS', 1000),
    refundMaxAttempts: positiveInt(env, 'REFUND_MAX_ATTEMPTS', 8),
    refundBackoffBaseMs: positiveInt(env, 'REFUND_BACKOFF_BASE_MS', 2000),
    backoffCapMs: positiveInt(env, 'OUTBOX_BACKOFF_CAP_MS', 60_000),
  };
  // Another worker may only take a job over once a POST sent under the old lease has timed out
  // and has had the settle time to land. Anything shorter could let it GET 404 and POST again.
  const needed = config.postTimeoutMs + config.settleMs + config.getTimeoutMs;
  if (config.leaseMs <= needed) {
    throw new Error(`OUTBOX_LEASE_MS must be more than ${needed} (POST + settle + GET)`);
  }
  if (config.maxAttempts <= config.maxPosts) {
    throw new Error('FULFILLMENT_MAX_ATTEMPTS must be more than FULFILLMENT_MAX_POSTS');
  }
  return config;
}

/** Exponential with jitter: half the delay is fixed and half is random, up to the cap. */
export function backoffMs(attempt: number, baseMs: number, capMs: number, random = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(attempt - 1, 0));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}
