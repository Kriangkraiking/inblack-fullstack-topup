import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { assertTransition } from '@inblack/domain';
import pg from 'pg';
import {
  deleteExpiredIdempotencyKeys,
  findItemsBySku,
  inTransaction,
  lockNextDueOrder,
  moveToExpired,
  releaseRedemptions,
  returnStock,
  returnVoucherUse,
} from './expiry.repository.js';

const DEFAULT_SWEEP_INTERVAL_MS = 5000;
const POOL_SIZE = 5;

/**
 * Expires one order in its own transaction, and returns false when nothing is due.
 *
 * Stock and voucher use go back only after the status change succeeded under the row
 * lock, so a second sweep finds a non-PENDING order and cannot return anything twice.
 * Lock order is order row, then products by SKU, then voucher, the same as order creation
 * for the rows they share. One order per transaction keeps that order true: a batch could
 * hold a voucher from its first order while waiting on a product for its second.
 */
export function expireOneOrder(client: pg.ClientBase): Promise<boolean> {
  return inTransaction(client, async () => {
    const orderId = await lockNextDueOrder(client);
    if (orderId === undefined) return false;

    assertTransition('PENDING_PAYMENT', 'EXPIRED');
    if (!(await moveToExpired(client, orderId))) return true;

    for (const item of await findItemsBySku(client, orderId)) {
      await returnStock(client, item.sku, item.qty);
    }
    for (const code of await releaseRedemptions(client, orderId)) {
      await returnVoucherUse(client, code);
    }
    return true;
  });
}

@Injectable()
export class ExpiryService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ExpiryService.name);
  private readonly pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: POOL_SIZE,
  });
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor() {
    // Without a listener, an idle connection dropped by Postgres would crash the process.
    this.pool.on('error', (error) => this.logger.error(error.message));
  }

  onApplicationBootstrap() {
    const interval = Number(
      process.env.EXPIRY_SWEEP_INTERVAL_MS ?? DEFAULT_SWEEP_INTERVAL_MS,
    );
    this.timer = setInterval(() => void this.sweep(), interval);
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.pool.end();
  }

  /** Never throws: a database outage just means the next tick tries again. */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let expired = 0;
    try {
      const client = await this.pool.connect();
      let failure: Error | undefined;
      try {
        while (await expireOneOrder(client)) expired += 1;
      } catch (error) {
        failure = error as Error;
        throw error;
      } finally {
        client.release(failure);
      }
      await deleteExpiredIdempotencyKeys(this.pool);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.sweeping = false;
    }
    if (expired > 0) this.logger.log(`Expired ${expired} order(s)`);
    return expired;
  }
}
