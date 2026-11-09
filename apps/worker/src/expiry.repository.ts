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

/** Stock and voucher use, returned once: the function keeps a guard row per order. */
export async function releaseHolds(client: pg.ClientBase, orderId: string): Promise<void> {
  await client.query('SELECT release_order_holds($1)', [orderId]);
}

export async function deleteExpiredIdempotencyKeys(
  pool: pg.Pool,
): Promise<void> {
  await pool.query('DELETE FROM idempotency_keys WHERE expires_at <= now()');
}
