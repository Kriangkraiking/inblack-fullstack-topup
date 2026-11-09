import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

export const OUTBOX_CHANNEL = 'inblack:outbox';

/**
 * Tells the worker there is a new job, so it does not wait for its next poll. Only a hint: the
 * job is already committed in Postgres, and with Redis down the worker finds it by polling. So
 * this never throws and never waits for a reconnect.
 */
@Injectable()
export class OutboxSignalService implements OnApplicationShutdown {
  private readonly logger = new Logger(OutboxSignalService.name);
  private readonly redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => 5000,
      })
    : undefined;
  private lastWarning = 0;

  constructor() {
    this.redis?.on('error', (error: Error) => this.warn(error.message));
    this.redis?.connect().catch((error: Error) => this.warn(error.message));
  }

  async wake(): Promise<void> {
    try {
      await this.redis?.publish(OUTBOX_CHANNEL, '1');
    } catch (error) {
      this.warn(error instanceof Error ? error.message : String(error));
    }
  }

  /** At most once a minute, because during an outage every connection attempt fails. */
  private warn(message: string): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(`outbox signal unavailable, the worker will poll: ${message}`);
  }

  onApplicationShutdown(): void {
    this.redis?.disconnect();
  }
}
