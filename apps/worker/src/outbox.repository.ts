import pg from 'pg';

/**
 * All SQL for outbox jobs. Every value is a bound parameter.
 *
 * Fencing: attempts goes up by one on every claim, so (id, attempts) identifies one claim. A
 * worker that stalled past its lease finds its claim is gone, and whatever it tries rolls back.
 */

export const FULFILLMENT_TOPIC = 'fulfillment.requested';
export const REFUND_TOPIC = 'refund.requested';
const ACTOR = 'system:fulfillment-worker';

export interface Job {
  id: string;
  topic: string;
  aggregateId: string;
  payload: { refund_id?: number | string };
  attempts: number;
  createdAt: Date;
}

export interface OrderToFulfill {
  id: string;
  status: string;
  game_uid: string;
  paid_satang: string;
  refunded_satang: string;
  items: { sku: string; qty: number }[];
}

export interface RefundToSend {
  id: string;
  refund_ref: string;
  order_id: string;
  amount_satang: string;
  status: string;
  /** What the order was paid, sent along so the provider can refund a payment it never saw. */
  paid_satang: string;
  /** The webhook event that recorded that payment, if one did. */
  payment_event_id: string | null;
}

export class FencedError extends Error {
  constructor() {
    super('this claim is no longer valid');
    this.name = 'FencedError';
  }
}

export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      broken = rollbackError as Error;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

/**
 * Takes the next due job and leases it. A worker that dies leaves available_at in the future, so
 * the job comes back on its own when the lease ends, with no extra step. Jobs already started
 * go first: their orders are IN_PROGRESS and on the clock of spec section 7.
 */
export function claimNextJob(pool: pg.Pool, leaseMs: number): Promise<Job | undefined> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      id: string;
      topic: string;
      aggregate_id: string;
      payload: Job['payload'];
      attempts: number;
      created_at: Date;
    }>(
      `SELECT id, topic, aggregate_id, payload, attempts, created_at
       FROM outbox
       WHERE processed_at IS NULL AND available_at <= now()
       ORDER BY (attempts > 0) DESC, available_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    const row = rows[0];
    if (!row) return undefined;
    await client.query(
      `UPDATE outbox SET attempts = attempts + 1,
         available_at = now() + make_interval(secs => $2::double precision / 1000)
       WHERE id = $1`,
      [row.id, leaseMs],
    );
    const job: Job = {
      id: row.id,
      topic: row.topic,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      attempts: row.attempts + 1,
      createdAt: row.created_at,
    };
    if (job.topic === FULFILLMENT_TOPIC) await startFulfillment(client, job.aggregateId);
    return job;
  });
}

/**
 * The lease guarantees whoever held the last POST is past its timeout and settle time, so an
 * attempt still marked IN_FLIGHT has an unknown result. GET decides what really happened.
 */
async function startFulfillment(client: pg.ClientBase, orderId: string): Promise<void> {
  await client.query(`SELECT transition_order($1, 'IN_QUEUE', 'IN_PROGRESS', $2, 'fulfillment started')`, [
    orderId,
    ACTOR,
  ]);
  await client.query(
    `UPDATE fulfillment_attempts SET status = 'UNKNOWN', error = 'no result recorded', finished_at = now()
     WHERE order_id = $1 AND status = 'IN_FLIGHT'`,
    [orderId],
  );
}

export async function loadOrder(pool: pg.Pool, orderId: string): Promise<OrderToFulfill | undefined> {
  const { rows } = await pool.query<Omit<OrderToFulfill, 'items'>>(
    'SELECT id, status, game_uid, paid_satang, refunded_satang FROM orders WHERE id = $1',
    [orderId],
  );
  if (!rows[0]) return undefined;
  const items = await pool.query<{ sku: string; qty: number }>(
    'SELECT sku, qty FROM order_items WHERE order_id = $1 ORDER BY sku',
    [orderId],
  );
  return { ...rows[0], items: items.rows };
}

export async function countPosts(pool: pg.Pool, job: Job, reference: string): Promise<number> {
  const { rows } = await pool.query<{ posts: number }>(
    `SELECT count(*)::int AS posts FROM fulfillment_attempts
     WHERE order_id = $1 AND reference = $2 AND started_at >= $3`,
    [job.aggregateId, reference, job.createdAt],
  );
  return rows[0].posts;
}

/**
 * Recorded and committed before the POST leaves, along with a fresh lease. Returns the attempt
 * id, or undefined if this claim was lost or a call is already in flight for this order.
 */
export async function beginAttempt(
  pool: pg.Pool,
  job: Job,
  reference: string,
  leaseMs: number,
): Promise<string | undefined> {
  try {
    return await withTransaction(pool, async (client) => {
      await holdClaim(client, job);
      await client.query(
        `UPDATE outbox SET available_at = now() + make_interval(secs => $2::double precision / 1000)
         WHERE id = $1`,
        [job.id, leaseMs],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO fulfillment_attempts (order_id, reference, attempt_no)
         SELECT $1, $2, coalesce(max(attempt_no), 0) + 1 FROM fulfillment_attempts WHERE order_id = $1
         RETURNING id`,
        [job.aggregateId, reference],
      );
      return rows[0].id;
    });
  } catch (error) {
    if (error instanceof FencedError || (error as { code?: string }).code === '23505') return undefined;
    throw error;
  }
}

export async function finishAttempt(
  pool: pg.Pool,
  attemptId: string,
  status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN',
  httpStatus: number | null,
  error: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE fulfillment_attempts SET status = $2, http_status = $3, error = $4, finished_at = now()
     WHERE id = $1 AND status = 'IN_FLIGHT'`,
    [attemptId, status, httpStatus, error],
  );
}

/** GET said it was delivered, so the newest attempt with an open result was the one that landed. */
export async function markDelivered(pool: pg.Pool, orderId: string, reference: string): Promise<void> {
  await pool.query(
    `UPDATE fulfillment_attempts SET status = 'SUCCEEDED', finished_at = now()
     WHERE id = (
       SELECT id FROM fulfillment_attempts
       WHERE order_id = $1 AND reference = $2 AND status IN ('IN_FLIGHT', 'UNKNOWN')
       ORDER BY id DESC LIMIT 1
     ) AND NOT EXISTS (
       SELECT 1 FROM fulfillment_attempts
       WHERE order_id = $1 AND reference = $2 AND status = 'SUCCEEDED'
     )`,
    [orderId, reference],
  );
}

/** Locks the job row first, which is the outbox-then-order lock order used by every step here. */
async function holdClaim(client: pg.ClientBase, job: Job): Promise<void> {
  const { rowCount } = await client.query(
    'SELECT 1 FROM outbox WHERE id = $1 AND attempts = $2 AND processed_at IS NULL FOR UPDATE',
    [job.id, job.attempts],
  );
  if (rowCount !== 1) throw new FencedError();
}

async function closeJob(client: pg.ClientBase, job: Job, lastError: string | null): Promise<void> {
  await holdClaim(client, job);
  await client.query('UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = $1', [
    job.id,
    lastError,
  ]);
}

async function deadLetter(client: pg.ClientBase, job: Job, reason: string): Promise<void> {
  await client.query(
    `INSERT INTO dead_letters (outbox_id, topic, aggregate_id, payload, attempts, last_error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [job.id, job.topic, job.aggregateId, JSON.stringify(job.payload), job.attempts, reason],
  );
}

async function transition(
  client: pg.ClientBase,
  orderId: string,
  from: string,
  to: string,
  reason: string,
): Promise<void> {
  await client.query('SELECT transition_order($1, $2, $3, $4, $5)', [orderId, from, to, ACTOR, reason]);
}

export async function reschedule(pool: pg.Pool, job: Job, delayMs: number, reason: string): Promise<void> {
  await pool.query(
    `UPDATE outbox
     SET available_at = now() + make_interval(secs => $3::double precision / 1000), last_error = $4
     WHERE id = $1 AND attempts = $2 AND processed_at IS NULL`,
    [job.id, job.attempts, delayMs, reason],
  );
}

/** Nothing left to do for this job, for example the order moved on while it waited. */
export function closeOnly(pool: pg.Pool, job: Job, reason: string | null): Promise<void> {
  return withTransaction(pool, (client) => closeJob(client, job, reason));
}

export function completeFulfillment(pool: pg.Pool, job: Job): Promise<void> {
  return withTransaction(pool, async (client) => {
    await closeJob(client, job, null);
    await transition(client, job.aggregateId, 'IN_PROGRESS', 'COMPLETED', 'top-up confirmed');
  });
}

export function sendFulfillmentToReview(pool: pg.Pool, job: Job, reason: string): Promise<void> {
  return withTransaction(pool, async (client) => {
    await closeJob(client, job, reason);
    await deadLetter(client, job, reason);
    await transition(client, job.aggregateId, 'IN_PROGRESS', 'NEEDS_REVIEW', reason);
  });
}

/** FAILED, the dead letter and the refund commit together, so the money cannot be forgotten. */
export function failFulfillment(pool: pg.Pool, job: Job, reason: string): Promise<void> {
  return withTransaction(pool, async (client) => {
    await closeJob(client, job, reason);
    await deadLetter(client, job, reason);
    await transition(client, job.aggregateId, 'IN_PROGRESS', 'FAILED', reason);
    const { rows } = await client.query<{ id: string; order_id: string }>(
      `INSERT INTO refunds (order_id, amount_satang, idempotency_key, actor, reason)
       SELECT id, paid_satang - refunded_satang, $2, $3, 'fulfillment failed, refunding automatically'
       FROM orders WHERE id = $1 AND paid_satang > refunded_satang
       RETURNING id, order_id`,
      [job.aggregateId, `auto:fulfillment-failed:${job.id}`, ACTOR],
    );
    if (rows[0]) await enqueueRefund(client, rows[0].order_id, rows[0].id);
  });
}

async function enqueueRefund(client: pg.ClientBase, orderId: string, refundId: string): Promise<void> {
  await client.query(
    `INSERT INTO outbox (topic, aggregate_id, payload)
     VALUES ($1, $2, jsonb_build_object('refund_id', $3::bigint))`,
    [REFUND_TOPIC, orderId, refundId],
  );
}

export async function loadRefund(pool: pg.Pool, refundId: string): Promise<RefundToSend | undefined> {
  const { rows } = await pool.query<RefundToSend>(
    `SELECT r.id, r.refund_ref, r.order_id, r.amount_satang, r.status, o.paid_satang,
            (SELECT e.event_id FROM webhook_events e
             WHERE e.order_id = r.order_id AND e.type = 'payment.succeeded'
               AND e.amount_satang = o.paid_satang
               AND e.outcome IS DISTINCT FROM 'duplicate_payment'
               AND e.outcome IS DISTINCT FROM 'unknown_order'
             ORDER BY e.received_at, e.event_id LIMIT 1) AS payment_event_id
     FROM refunds r JOIN orders o ON o.id = r.order_id
     WHERE r.id = $1`,
    [refundId],
  );
  return rows[0];
}

export function settleRefund(pool: pg.Pool, job: Job, refund: RefundToSend, eventId: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    await closeJob(client, job, null);
    const { rows } = await client.query<{ outcome: string }>(
      'SELECT settle_refund($1, $2, $3, $4, $5) AS outcome',
      [refund.order_id, refund.amount_satang, eventId, refund.id, 'system:refund-worker'],
    );
    return rows[0].outcome;
  });
}

async function moveToReview(client: pg.ClientBase, orderId: string, reason: string): Promise<void> {
  const { rows } = await client.query<{ status: string }>(
    'SELECT status FROM orders WHERE id = $1 FOR UPDATE',
    [orderId],
  );
  // Any status can enter NEEDS_REVIEW except NEEDS_REVIEW itself.
  if (rows[0] && rows[0].status !== 'NEEDS_REVIEW') {
    await transition(client, orderId, rows[0].status, 'NEEDS_REVIEW', reason);
  }
}

/** The provider refused, so no money moved and the amount can be refunded again. */
export function rejectRefund(pool: pg.Pool, job: Job, refund: RefundToSend, reason: string): Promise<void> {
  return withTransaction(pool, async (client) => {
    await closeJob(client, job, reason);
    await deadLetter(client, job, reason);
    await moveToReview(client, refund.order_id, reason);
    await client.query(`UPDATE refunds SET status = 'FAILED' WHERE id = $1 AND status = 'PENDING'`, [
      refund.id,
    ]);
  });
}

/**
 * Out of retries with no answer. The refund stays PENDING: the provider may have done it, so its
 * amount must stay out of what can be refunded, and a late webhook can still settle it.
 */
export function giveUpOnRefund(pool: pg.Pool, job: Job, refund: RefundToSend, reason: string): Promise<void> {
  return withTransaction(pool, async (client) => {
    await closeJob(client, job, reason);
    await deadLetter(client, job, reason);
    await moveToReview(client, refund.order_id, reason);
  });
}

/**
 * Should find nothing, because a status and its job always commit together. It is here so that
 * no bug or manual edit can leave a paid order waiting for a job that does not exist. A job that
 * was dead-lettered closes with a status change, so it is not picked up again.
 */
export async function requeueOrphans(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO outbox (topic, aggregate_id)
     SELECT $1, o.id FROM orders o
     WHERE o.status IN ('IN_QUEUE', 'IN_PROGRESS')
       AND NOT EXISTS (
         SELECT 1 FROM outbox j
         WHERE j.aggregate_id = o.id AND j.topic = $1 AND j.processed_at IS NULL
       )
     ON CONFLICT (aggregate_id)
       WHERE topic = 'fulfillment.requested' AND processed_at IS NULL
     DO NOTHING`,
    [FULFILLMENT_TOPIC],
  );
  return rowCount ?? 0;
}
