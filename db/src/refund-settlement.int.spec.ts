import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real migrations against a throwaway Postgres and drives settle_refund and
 * release_order_holds the way the webhook and the worker do. Skipped unless
 * TEST_DATABASE_URL points at an empty database the test may own, for example:
 *   docker run -d --name pg-test -e POSTGRES_PASSWORD=test -p 5434:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:5434/postgres pnpm --filter @inblack/db test
 */
const url = process.env.TEST_DATABASE_URL;
const MIGRATIONS = new URL('../migrations/', import.meta.url);
const SEED = new URL('../seed/seed.sql', import.meta.url);

// Valid order ids: 13 digits, then those digits mod 997.
let serial = 1_000_000_000_000;
function nextOrderId(): string {
  serial += 1;
  return `ORD-${serial}-${String(serial % 997).padStart(3, '0')}`;
}

describe.skipIf(!url)('refund settlement and hold release (real Postgres)', () => {
  const client = new pg.Client({ connectionString: url });

  beforeAll(async () => {
    await client.connect();
    for (const file of (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort()) {
      await client.query(await readFile(new URL(file, MIGRATIONS), 'utf8'));
    }
    await client.query(await readFile(SEED, 'utf8'));
    // What the API sets in its transaction before it writes an order.
    await client.query(`SELECT set_config('app.actor', 'test', false), set_config('app.reason', 'test', false)`);
  });

  afterAll(async () => {
    await client.end();
  });

  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    (await client.query(sql, params)).rows[0] as T;

  /** One FLASH-SKIN-01 with SAVE10's use taken, the way order creation holds them. */
  async function heldOrder(): Promise<string> {
    const id = nextOrderId();
    await client.query(
      `INSERT INTO orders (id, email, game_uid, payment_method, voucher_code, subtotal_satang,
         discount_satang, net_satang, fee_satang, total_satang, vat_satang, expires_at)
       VALUES ($1, $2, 'player', 'PROMPTPAY', NULL, 9900, 0, 9900, 0, 9900, 648, now() + interval '15 minutes')`,
      [id, `${id.toLowerCase()}@test.local`],
    );
    await client.query(
      `INSERT INTO order_items (order_id, sku, name_snapshot, unit_price_satang, qty, line_total_satang)
       VALUES ($1, 'FLASH-SKIN-01', 'skin', 9900, 1, 9900)`,
      [id],
    );
    await client.query(`UPDATE products SET stock = stock - 1 WHERE sku = 'FLASH-SKIN-01'`);
    await client.query(
      `INSERT INTO voucher_redemptions (voucher_code, order_id, email) VALUES ('SAVE10', $1, $2)`,
      [id, `${id.toLowerCase()}@test.local`],
    );
    await client.query(`UPDATE vouchers SET used_count = used_count + 1 WHERE code = 'SAVE10'`);
    return id;
  }

  const flashStock = async () =>
    (await one<{ stock: number }>(`SELECT stock FROM products WHERE sku = 'FLASH-SKIN-01'`)).stock;
  const save10Used = async () =>
    (await one<{ used_count: number }>(`SELECT used_count FROM vouchers WHERE code = 'SAVE10'`)).used_count;

  const move = (id: string, from: string, to: string) =>
    client.query(`SELECT transition_order($1, $2, $3, 'test', 'test')`, [id, from, to]);
  const pay = (id: string, amount: number) =>
    client.query('UPDATE orders SET paid_satang = $2 WHERE id = $1', [id, amount]);
  const refundRow = async (id: string, amount: number, key: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO refunds (order_id, amount_satang, idempotency_key, actor, reason)
         VALUES ($1, $2, $3, 'test', 'test') RETURNING id`,
        [id, amount, key],
      )
    ).id;
  const settle = async (id: string, amount: number, eventId: string, preferred: string | null) =>
    (
      await one<{ outcome: string }>('SELECT settle_refund($1, $2, $3, $4, $5) AS outcome', [
        id, amount, eventId, preferred, 'test',
      ])
    ).outcome;

  it('a full refund of a never-queued order returns stock and voucher use once', async () => {
    const [stock, used] = [await flashStock(), await save10Used()];
    const id = await heldOrder();
    await move(id, 'PENDING_PAYMENT', 'NEEDS_REVIEW'); // amount mismatch
    await pay(id, 9800);
    const refund = await refundRow(id, 9800, 'k1');

    expect(await settle(id, 9800, 'evt_full', refund)).toBe('settled');

    expect((await one<{ status: string }>('SELECT status FROM orders WHERE id = $1', [id])).status).toBe('REFUNDED');
    expect(await flashStock()).toBe(stock);
    expect(await save10Used()).toBe(used);
    // Any later call is a no-op.
    await client.query('SELECT release_order_holds($1)', [id]);
    expect(await flashStock()).toBe(stock);
    expect(await save10Used()).toBe(used);
  });

  it('does not return stock again for an order that expired before it was refunded', async () => {
    const [stock, used] = [await flashStock(), await save10Used()];
    const id = await heldOrder();
    await move(id, 'PENDING_PAYMENT', 'EXPIRED');
    await client.query('SELECT release_order_holds($1)', [id]);
    expect(await flashStock()).toBe(stock);
    await pay(id, 9900); // late payment, refunded instead of reinstated
    const refund = await refundRow(id, 9900, 'k1');

    expect(await settle(id, 9900, 'evt_late', refund)).toBe('settled');

    expect(await flashStock()).toBe(stock);
    expect(await save10Used()).toBe(used);
  });

  it('returns holds again after a late payment took them back', async () => {
    const stock = await flashStock();
    const id = await heldOrder();
    await move(id, 'PENDING_PAYMENT', 'EXPIRED');
    await client.query('SELECT release_order_holds($1)', [id]);
    await client.query(`UPDATE products SET stock = stock - 1 WHERE sku = 'FLASH-SKIN-01'`);
    await client.query('SELECT mark_order_holds_taken($1)', [id]);
    expect(await flashStock()).toBe(stock - 1);

    await client.query('SELECT release_order_holds($1)', [id]);
    await client.query('SELECT release_order_holds($1)', [id]);

    expect(await flashStock()).toBe(stock);
  });

  // The audit case s3/same-amount-order: B was sent, its webhook settles A, then both jobs run.
  it('same-amount refunds end with one provider event per row whichever row a webhook hits', async () => {
    const id = await heldOrder();
    await move(id, 'PENDING_PAYMENT', 'NEEDS_REVIEW');
    await pay(id, 9900);
    const a = await refundRow(id, 4000, 'ka');
    const b = await refundRow(id, 4000, 'kb');

    expect(await settle(id, 4000, 'evt_b', null)).toBe('settled'); // webhook for B lands on A
    expect(await settle(id, 4000, 'evt_a', a)).toBe('settled'); // job A sends A: settles B
    expect(await settle(id, 4000, 'evt_b', b)).toBe('already_settled'); // job B gets B's event again

    const rows = (
      await client.query<{ id: string; status: string; provider_event_id: string }>(
        'SELECT id, status, provider_event_id FROM refunds WHERE order_id = $1 ORDER BY id',
        [id],
      )
    ).rows;
    expect(rows.map((row) => row.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(new Set(rows.map((row) => row.provider_event_id))).toEqual(new Set(['evt_a', 'evt_b']));
    expect(rows.map((row) => row.id)).toEqual([a, b]);
  });
});
