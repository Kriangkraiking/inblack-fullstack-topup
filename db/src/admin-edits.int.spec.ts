import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 0010 against a real Postgres: the admin login counter and the product edit grants.
 * Skipped unless TEST_DATABASE_URL is set, see refund-settlement.int.spec.ts. Uses a database of
 * its own on that server, so it does not depend on the order test files run in.
 */
const baseUrl = process.env.TEST_DATABASE_URL;
const DB_NAME = 'inblack_int_admin_edits';
const url = baseUrl && Object.assign(new URL(baseUrl), { pathname: `/${DB_NAME}` }).toString();
const MIGRATIONS = new URL('../migrations/', import.meta.url);
const SEED = new URL('../seed/seed.sql', import.meta.url);

let serial = 2_000_000_000_000;
function nextOrderId(): string {
  serial += 1;
  return `ORD-${serial}-${String(serial % 997).padStart(3, '0')}`;
}

const hash = (n: number) => n.toString(16).padStart(64, '0');

describe.skipIf(!url)('admin login attempts and product edits (real Postgres)', () => {
  const client = new pg.Client({ connectionString: url });

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
    await client.connect();
    for (const file of (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort()) {
      await client.query(await readFile(new URL(file, MIGRATIONS), 'utf8'));
    }
    await client.query(await readFile(SEED, 'utf8'));
    await client.query(`SELECT set_config('app.actor', 'test', false), set_config('app.reason', 'test', false)`);
  });

  afterAll(async () => {
    await client.end();
  });

  const attempt = async (c: pg.Client, key: string) =>
    (
      await c.query<{ attempts: number; retry_after_seconds: number }>(
        'SELECT attempts, retry_after_seconds FROM admin_login_attempt($1, 900)',
        [key],
      )
    ).rows[0];

  it('counts attempts per email in a 15 minute window and reports the seconds left', async () => {
    const key = hash(1);
    const seen = [];
    for (let i = 0; i < 6; i += 1) seen.push(await attempt(client, key));
    expect(seen.map((r) => r.attempts)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen[5].retry_after_seconds).toBeGreaterThan(890);
    expect(seen[5].retry_after_seconds).toBeLessThanOrEqual(900);
  });

  it('starts a new window once the old one is over', async () => {
    const key = hash(2);
    for (let i = 0; i < 6; i += 1) await attempt(client, key);
    await client.query(
      `UPDATE admin_login_attempts SET window_started_at = now() - interval '16 minutes' WHERE email_hash = $1`,
      [key],
    );
    expect((await attempt(client, key)).attempts).toBe(1);
  });

  it('20 attempts at once from separate connections lose no count (two replicas share it)', async () => {
    const key = hash(3);
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        return c;
      }),
    );
    try {
      const results = await Promise.all(clients.map((c) => attempt(c, key)));
      expect(results.map((r) => r.attempts).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('inblack_app may count attempts and edit name, price and stock, but not slug or limits', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE inblack_app');
      expect((await attempt(client, hash(4))).attempts).toBe(1);
      await client.query('DELETE FROM admin_login_attempts WHERE email_hash = $1', [hash(4)]);
      await client.query(
        `UPDATE products SET name = 'x', price_satang = 1, stock = stock, updated_at = now() WHERE sku = 'DIAMOND-1000'`,
      );
      await client.query('SAVEPOINT s');
      await expect(client.query(`UPDATE products SET slug = 'x' WHERE sku = 'DIAMOND-1000'`)).rejects.toThrow(
        /permission denied/,
      );
      await client.query('ROLLBACK TO SAVEPOINT s');
      await expect(
        client.query(`UPDATE products SET max_qty_per_email = 9 WHERE sku = 'FLASH-SKIN-01'`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('a price change after an order leaves the order, its items and its amounts as they were', async () => {
    const id = nextOrderId();
    const email = `${id.toLowerCase()}@test.local`;
    // DIAMOND-1000 x2, SAVE10, Card: the first priced example in spec 5.2.
    await client.query(
      `INSERT INTO orders (id, email, game_uid, payment_method, voucher_code, subtotal_satang,
         discount_satang, net_satang, fee_satang, total_satang, vat_satang, expires_at)
       VALUES ($1, $2, 'player', 'CARD', NULL, 69800, 5000, 64800, 2180, 66980, 4382, now() + interval '15 minutes')`,
      [id, email],
    );
    await client.query(
      `INSERT INTO order_items (order_id, sku, name_snapshot, unit_price_satang, qty, line_total_satang)
       VALUES ($1, 'DIAMOND-1000', '1,000 Diamonds', 34900, 2, 69800)`,
      [id],
    );
    const before = (await client.query(`SELECT price_satang, name FROM products WHERE sku = 'DIAMOND-1000'`)).rows[0] as {
      price_satang: string;
      name: string;
    };

    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE inblack_app');
    await client.query(
      `UPDATE products SET price_satang = 99900, name = '<img src=x onerror=alert(1)>' WHERE sku = 'DIAMOND-1000'`,
    );
    await client.query('COMMIT');

    try {
      const item = (await client.query(`SELECT name_snapshot, unit_price_satang, line_total_satang FROM order_items WHERE order_id = $1`, [id])).rows[0];
      const order = (await client.query(`SELECT subtotal_satang, total_satang, vat_satang FROM orders WHERE id = $1`, [id])).rows[0];
      expect(item).toEqual({ name_snapshot: '1,000 Diamonds', unit_price_satang: '34900', line_total_satang: '69800' });
      expect(order).toEqual({ subtotal_satang: '69800', total_satang: '66980', vat_satang: '4382' });
      // The webhook compares against orders.total_satang and refunds against paid_satang, so a
      // payment of the old total is still exact.
      await client.query('UPDATE orders SET paid_satang = total_satang WHERE id = $1', [id]);
      await client.query(`SELECT transition_order($1, 'PENDING_PAYMENT', 'PAID', 'test', 'test')`, [id]);
      const paid = (await client.query(`SELECT paid_satang FROM orders WHERE id = $1`, [id])).rows[0] as { paid_satang: string };
      expect(paid.paid_satang).toBe('66980');
      // order_items cannot be rewritten to the new price, even by the owner.
      await expect(client.query(`UPDATE order_items SET unit_price_satang = 99900 WHERE order_id = $1`, [id])).rejects.toThrow();
    } finally {
      await client.query(`UPDATE products SET price_satang = $1, name = $2 WHERE sku = 'DIAMOND-1000'`, [
        before.price_satang,
        before.name,
      ]);
    }
  });
});
