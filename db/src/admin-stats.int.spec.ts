import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 0012 against a real Postgres: admin_dashboard_stats(), the SQL behind
 * GET /api/v1/admin/stats. Skipped unless TEST_DATABASE_URL is set. Own database on that server.
 */
const baseUrl = process.env.TEST_DATABASE_URL;
const DB_NAME = 'inblack_int_admin_stats';
const url = baseUrl && Object.assign(new URL(baseUrl), { pathname: `/${DB_NAME}` }).toString();
const MIGRATIONS = new URL('../migrations/', import.meta.url);
const SEED = new URL('../seed/seed.sql', import.meta.url);

let serial = 3_000_000_000_000;
function nextOrderId(): string {
  serial += 1;
  return `ORD-${serial}-${String(serial % 997).padStart(3, '0')}`;
}

interface Stats {
  orders_today: string;
  revenue_today_satang: string;
  orders_last_minute: string;
  orders_last_hour: string;
  queue_depth: string;
  dead_letters_open: string;
}

describe.skipIf(!url)('admin dashboard stats (real Postgres)', () => {
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

  async function order(createdAt?: string): Promise<string> {
    const id = nextOrderId();
    await client.query(
      `INSERT INTO orders (id, email, game_uid, payment_method, voucher_code, subtotal_satang,
         discount_satang, net_satang, fee_satang, total_satang, vat_satang, expires_at, created_at)
       VALUES ($1, $2, 'player', 'PROMPTPAY', NULL, 9900, 0, 9900, 0, 9900, 648,
               coalesce($3::timestamptz, now()) + interval '15 minutes', coalesce($3::timestamptz, now()))`,
      [id, `${id.toLowerCase()}@test.local`, createdAt ?? null],
    );
    return id;
  }

  const move = (id: string, from: string, to: string) =>
    client.query(`SELECT transition_order($1, $2, $3, 'test', 'test')`, [id, from, to]);
  const stats = async (at: string | null = null) =>
    (await client.query<Stats>('SELECT * FROM admin_dashboard_stats(coalesce($1::timestamptz, now()))', [at]))
      .rows[0];

  it('uses Asia/Bangkok days: 00:30 Bangkok counts, 23:30 the evening before does not', async () => {
    await order('2026-01-01T16:30:00Z'); // 23:30 on 1 Jan in Bangkok
    await order('2026-01-01T17:30:00Z'); // 00:30 on 2 Jan in Bangkok
    const s = await stats('2026-01-01T18:00:00Z');
    expect(s.orders_today).toBe('1');
    expect(s.orders_last_hour).toBe('1');
    expect(s.orders_last_minute).toBe('0');
  });

  it('counts recent orders and revenue = paid today minus refunds settled today, in integer satang', async () => {
    const paid = await order();
    await client.query('UPDATE orders SET paid_satang = 9900 WHERE id = $1', [paid]);
    await move(paid, 'PENDING_PAYMENT', 'PAID');
    await order(); // still pending: no revenue
    await order(new Date(Date.now() - 30 * 60_000).toISOString()); // in the last hour only

    // A mismatched payment of 9800, refunded in full and settled today.
    const refunded = await order();
    await move(refunded, 'PENDING_PAYMENT', 'NEEDS_REVIEW');
    await client.query('UPDATE orders SET paid_satang = 9800 WHERE id = $1', [refunded]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO refunds (order_id, amount_satang, idempotency_key, actor, reason)
       VALUES ($1, 9800, 'k1', 'test', 'test') RETURNING id`,
      [refunded],
    );
    await client.query('SELECT settle_refund($1, 9800, $2, $3, $4)', [refunded, 'evt_1', rows[0].id, 'test']);

    const s = await stats();
    expect(s.orders_last_minute).toBe('3');
    expect(s.orders_last_hour).toBe('4');
    expect(Number(s.orders_today)).toBeGreaterThanOrEqual(3);
    expect(s.revenue_today_satang).toBe(String(9900 - 9800));

    // Seen from two days later, none of it is "today" or recent.
    const later = await stats(new Date(Date.now() + 2 * 86_400_000).toISOString());
    expect(later).toMatchObject({ orders_today: '0', revenue_today_satang: '0', orders_last_hour: '0' });
  });

  it('queue depth and open dead letters match the tables', async () => {
    await client.query(`INSERT INTO dead_letters (topic, aggregate_id) VALUES ('t', 'a'), ('t', 'b')`);
    await client.query(`UPDATE dead_letters SET resolved_at = now(), resolved_by = 'test' WHERE aggregate_id = 'b'`);
    const expected = (
      await client.query<{ q: string; d: string }>(
        `SELECT (SELECT count(*) FROM outbox WHERE processed_at IS NULL) AS q,
                (SELECT count(*) FROM dead_letters WHERE resolved_at IS NULL) AS d`,
      )
    ).rows[0];
    const s = await stats();
    expect(s.queue_depth).toBe(expected.q);
    expect(s.dead_letters_open).toBe('1');
  });
});
