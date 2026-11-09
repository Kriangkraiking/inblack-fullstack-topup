import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

export const orderChannel = (orderId: string) => `order:${orderId}`;
const CHANNEL_PREFIX = 'order:';

type Listener = () => void;

/**
 * One Redis subscriber per API instance, subscribed to order:{id} only while a stream of that
 * order is open here. A message only says "look again": streams read the events from Postgres.
 * Messages sent while Redis was away are lost, so every stream re-reads when it comes back, and
 * streams poll Postgres every second while `live` is false.
 */
@Injectable()
export class OrderSignalService implements OnApplicationShutdown {
  private readonly logger = new Logger(OrderSignalService.name);
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    lazyConnect: true,
    retryStrategy: () => 1000,
    maxRetriesPerRequest: null,
  });
  private lastWarning = 0;

  constructor() {
    this.redis.on('error', (error: Error) => this.warn(error.message));
    this.redis.on('message', (channel: string) => {
      if (channel.startsWith(CHANNEL_PREFIX)) this.notify(channel.slice(CHANNEL_PREFIX.length));
    });
    // autoResubscribe restores the channels; what was published meanwhile has to be re-read.
    this.redis.on('ready', () => {
      for (const orderId of this.listeners.keys()) this.notify(orderId);
    });
    this.redis.connect().catch((error: Error) => this.warn(error.message));
  }

  get live(): boolean {
    return this.redis.status === 'ready';
  }

  /** Returns the function that removes the listener, and the channel with the last one. */
  subscribe(orderId: string, listener: Listener): () => void {
    let set = this.listeners.get(orderId);
    if (!set) {
      set = new Set();
      this.listeners.set(orderId, set);
      this.redis.subscribe(orderChannel(orderId)).catch((error: Error) => this.warn(error.message));
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(orderId);
      if (!current?.delete(listener) || current.size > 0) return;
      this.listeners.delete(orderId);
      this.redis.unsubscribe(orderChannel(orderId)).catch((error: Error) => this.warn(error.message));
    };
  }

  /** For tests and /metrics: how many orders this instance is subscribed to. */
  get subscribedOrders(): number {
    return this.listeners.size;
  }

  private notify(orderId: string): void {
    for (const listener of this.listeners.get(orderId) ?? []) listener();
  }

  private warn(message: string): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(`order signals unavailable, streams poll Postgres every second: ${message}`);
  }

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}
