import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { RateLimiter, type RateStore, type WindowCount } from './rate-limiter.js';

/**
 * INCR and the expiry in one script, so a crash between them cannot leave a key that never
 * expires. The PTTL check repairs a key that somehow lost its expiry.
 */
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`;

class RedisRateStore implements RateStore {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, windowMs: number): Promise<WindowCount> {
    const [count, ttlMs] = (await this.redis.eval(HIT_SCRIPT, 1, key, windowMs)) as [number, number];
    return { count, ttlMs };
  }
}

/**
 * Shared by both replicas through Redis. Fails fast while Redis is away: no offline queue, no
 * retries per command and a short command timeout, then the limiter lets the request through.
 * Reconnects back off to 5 s, for the DNS reason in AI_LOG P2.
 */
@Injectable()
export class RateLimiterService extends RateLimiter implements OnApplicationShutdown {
  private static readonly logger = new Logger('RateLimiterService');
  private static lastWarning = 0;
  private readonly redis: Redis;

  constructor() {
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: 300,
      retryStrategy: () => 5000,
    });
    super(new RedisRateStore(redis), (error) => RateLimiterService.warn(error));
    this.redis = redis;
    this.redis.on('error', (error: Error) => RateLimiterService.warn(error));
    this.redis.connect().catch((error: unknown) => RateLimiterService.warn(error));
  }

  /** At most once a minute, because during an outage every request fails the same way. */
  private static warn(error: unknown): void {
    if (Date.now() - RateLimiterService.lastWarning < 60_000) return;
    RateLimiterService.lastWarning = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    RateLimiterService.logger.warn(`rate limit store unavailable, letting requests through: ${message}`);
  }

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}
