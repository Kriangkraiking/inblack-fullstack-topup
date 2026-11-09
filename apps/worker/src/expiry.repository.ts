import type pg from 'pg';

/** All SQL for expiry. Every value is a bound parameter. */

export async function inTransaction<T>(
  client: pg.ClientBase,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** SKIP LOCKED lets several workers run side by side without waiting on each other. */
export async function lockNextDueOrder(
  client: pg.ClientBase,
): Promise<string | undefined> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM orders
     WHERE status = 'PENDING_PAYMENT' AND expires_at <= now()
     ORDER BY expires_at
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
  );
  return rows[0]?.id;
}

export async function moveToExpired(
  client: pg.ClientBase,
  orderId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ changed: boolean }>(
    `SELECT transition_order($1, 'PENDING_PAYMENT', 'EXPIRED', 'system:expiry-worker',
                             'payment window elapsed') AS changed`,
    [orderId],
  );
  return rows[0].changed;
}

export async function findItemsBySku(
  client: pg.ClientBase,
  orderId: string,
): Promise<{ sku: string; qty: number }[]> {
  const { rows } = await client.query<{ sku: string; qty: number }>(
    'SELECT sku, qty FROM order_items WHERE order_id = $1 ORDER BY sku',
    [orderId],
  );
  return rows;
}

/** Unlimited products have NULL stock and are left alone. */
export async function returnStock(
  client: pg.ClientBase,
  sku: string,
  qty: number,
): Promise<void> {
  await client.query(
    `UPDATE products SET stock = stock + $2, updated_at = now()
     WHERE sku = $1 AND stock IS NOT NULL`,
    [sku, qty],
  );
}

/** Returns the voucher codes that were still held, so each one is given back once. */
export async function releaseRedemptions(
  client: pg.ClientBase,
  orderId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ voucher_code: string }>(
    `UPDATE voucher_redemptions SET released_at = now()
     WHERE order_id = $1 AND released_at IS NULL
     RETURNING voucher_code`,
    [orderId],
  );
  return rows.map((row) => row.voucher_code);
}

export async function returnVoucherUse(
  client: pg.ClientBase,
  code: string,
): Promise<void> {
  await client.query(
    'UPDATE vouchers SET used_count = used_count - 1, updated_at = now() WHERE code = $1',
    [code],
  );
}

export async function deleteExpiredIdempotencyKeys(
  pool: pg.Pool,
): Promise<void> {
  await pool.query('DELETE FROM idempotency_keys WHERE expires_at <= now()');
}
