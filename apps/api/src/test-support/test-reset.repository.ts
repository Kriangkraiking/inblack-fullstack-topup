import { Injectable } from '@nestjs/common';
import pg from 'pg';

/**
 * Opens its own short-lived owner connection, because inblack_app cannot truncate or get
 * past the append-only triggers. schema_migrations and order_status_transitions stay,
 * since seeding does not restore them. A new table with data has to be added to this list.
 */
@Injectable()
export class TestResetRepository {
  async wipeAndSeed(connectionString: string, seedSql: string): Promise<void> {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        `TRUNCATE products, vouchers, admin_users, orders, order_items, order_events, refunds,
           voucher_redemptions, idempotency_keys, webhook_events, fulfillment_attempts, outbox,
           dead_letters
         RESTART IDENTITY CASCADE`,
      );
      await client.query(seedSql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  }
}
