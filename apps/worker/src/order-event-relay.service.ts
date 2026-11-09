import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import pg from 'pg';

const RECONNECT_MS = 1000;
const NOTIFY_PAYLOAD = /^(ORD-\d{13}-\d{3}):(\d+)$/;

/**
 * Forwards Postgres NOTIFY order_events (sent on commit by the trigger in
 * 0008_order_events_notify.sql) to Redis order:{id}, where every API instance with an open
 * stream of that order is subscribed. Losing a message here is safe: streams re-read Postgres
 * on their own every few seconds, and every second while Redis is down.
 */
@Injectable()
export class OrderEventRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OrderEventRelayService.name);
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    // Backs off to 5 s: with Redis's container gone, each try is a DNS lookup that can hold one
    // of libuv's 4 threads for 5 s, and the job pool's Postgres connects need those threads too.
    retryStrategy: (times: number) => Math.min(times * 1000, 5000),
  });
  private client?: pg.Client;
  private stopping = false;
  private lastWarning = 0;

  onApplicationBootstrap() {
    this.redis.on('error', (error: Error) => this.warn(`redis: ${error.message}`));
    this.redis.connect().catch(() => undefined);
    void this.listen();
  }

  private async listen(): Promise<void> {
    if (this.stopping) return;
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    this.client = client;
    let retried = false;
    const retry = () => {
      if (retried) return;
      retried = true;
      client.end().catch(() => undefined);
      if (!this.stopping) setTimeout(() => void this.listen(), RECONNECT_MS);
    };
    client.on('error', (error) => {
      this.warn(`postgres: ${error.message}`);
      retry();
    });
    client.on('end', retry);
    client.on('notification', (message) => this.forward(message.payload));
    try {
      await client.connect();
      await client.query('LISTEN order_events');
      this.logger.log('relaying order events from Postgres to Redis');
    } catch (error) {
      this.warn(`postgres: ${error instanceof Error ? error.message : String(error)}`);
      retry();
    }
  }

  private forward(payload: string | undefined): void {
    const match = NOTIFY_PAYLOAD.exec(payload ?? '');
    if (!match) return;
    this.redis.publish(`order:${match[1]}`, match[2]).catch((error: Error) => this.warn(`redis: ${error.message}`));
  }

  /** At most once a minute, because during an outage every attempt fails. */
  private warn(message: string): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(`order event relay degraded, API streams fall back to polling: ${message}`);
  }

  async onApplicationShutdown() {
    this.stopping = true;
    this.redis.disconnect();
    await this.client?.end().catch(() => undefined);
  }
}
