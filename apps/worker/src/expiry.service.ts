import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { assertTransition } from '@inblack/domain';
import pg from 'pg';

const DEFAULT_SWEEP_INTERVAL_MS = 5000;
const POOL_SIZE = 5;

/**
 * Expires one order in its own transaction, and returns false when nothing is due.
 *
 * SKIP LOCKED lets several workers run side by side without waiting on each other.
 * Stock and voucher use go back only after the status change succeeded under the row
 * lock, so a second sweep finds a non-PENDING order and cannot return anything twice.
 * Lock order is order row, then products by SKU, then voucher, the same as order creation
 * for the rows they share. One order per transaction keeps that order true: a batch could
 * hold a voucher from its first order while waiting on a product for its second.
 */
export async function expireOneOrder(client: pg.ClientBase): Promise<boolean> {
  await client.query('BEGIN');
  try {
    const due = await client.query<{ id: string }>(
      `SELECT id FROM orders
       WHERE status = 'PENDING_PAYMENT' AND expires_at <= now()
       ORDER BY expires_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    const orderId = due.rows[0]?.id;
    if (orderId === undefined) {
      await client.query('COMMIT');
      return false;
    }

    assertTransition('PENDING_PAYMENT', 'EXPIRED');
    const moved = await client.query<{ changed: boolean }>(
      `SELECT transition_order($1, 'PENDING_PAYMENT', 'EXPIRED', 'system:expiry-worker',
                               'payment window elapsed') AS changed`,
      [orderId],
    );
    if (!moved.rows[0].changed) {
      await client.query('COMMIT');
      return true;
    }

    const items = await client.query<{ sku: string; qty: number }>(
      'SELECT sku, qty FROM order_items WHERE order_id = $1 ORDER BY sku',
      [orderId],
    );
    for (const item of items.rows) {
      // Unlimited products have NULL stock, and NULL + qty would stay NULL anyway.
      await client.query(
        `UPDATE products SET stock = stock + $2, updated_at = now()
         WHERE sku = $1 AND stock IS NOT NULL`,
        [item.sku, item.qty],
      );
    }

    const released = await client.query<{ voucher_code: string }>(
      `UPDATE voucher_redemptions SET released_at = now()
       WHERE order_id = $1 AND released_at IS NULL
       RETURNING voucher_code`,
      [orderId],
    );
    for (const { voucher_code: code } of released.rows) {
      await client.query(
        'UPDATE vouchers SET used_count = used_count - 1, updated_at = now() WHERE code = $1',
        [code],
      );
    }

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
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
      await this.pool.query(
        'DELETE FROM idempotency_keys WHERE expires_at <= now()',
      );
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.sweeping = false;
    }
    if (expired > 0) this.logger.log(`Expired ${expired} order(s)`);
    return expired;
  }
}
