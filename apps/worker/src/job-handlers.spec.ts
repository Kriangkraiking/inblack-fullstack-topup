import type pg from 'pg';
import { backoffMs, loadOutboxConfig } from './outbox-config.js';
import { referenceFor, runFulfillment, type HandlerDeps } from './job-handlers.js';
import type { Job } from './outbox.repository.js';
import type { GameClient, PayClient, TopupLookup, TopupResult } from './provider-clients.js';

const ORDER_ID = 'ORD-2587965432159-229';
const REFERENCE = referenceFor(ORDER_ID, 'DIAMOND-1000');

function job(attempts = 1): Job {
  return {
    id: '1',
    topic: 'fulfillment.requested',
    aggregateId: ORDER_ID,
    payload: {},
    attempts,
    createdAt: new Date(0),
  };
}

/** A pool that answers by statement, so the handler's real repository calls all run. */
function fakePool(posts = 0, items = [{ sku: 'DIAMOND-1000', qty: 1 }]) {
  const statements: string[] = [];
  const query = (sql: string) => {
    statements.push(sql);
    if (sql.includes('FROM orders WHERE id')) {
      return Promise.resolve({
        rows: [{ id: ORDER_ID, status: 'IN_PROGRESS', game_uid: 'player', paid_satang: '100', refunded_satang: '0' }],
      });
    }
    if (sql.includes('FROM order_items')) return Promise.resolve({ rows: items });
    if (sql.includes('count(*)')) return Promise.resolve({ rows: [{ posts }] });
    if (sql.includes('INSERT INTO fulfillment_attempts')) return Promise.resolve({ rows: [{ id: '9' }] });
    if (sql.includes('INSERT INTO refunds')) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [], rowCount: 1 });
  };
  const pool = { query, connect: () => Promise.resolve({ query, release: () => undefined }) };
  return { pool: pool as unknown as pg.Pool, statements };
}

function setup(lookups: TopupLookup[], result: TopupResult, pool = fakePool()) {
  const getTopup = vi.fn<GameClient['getTopup']>(() =>
    Promise.resolve(lookups.shift() ?? { state: 'not_found' }),
  );
  const postTopup = vi.fn<GameClient['postTopup']>(() => Promise.resolve(result));
  const deps: HandlerDeps = {
    pool: pool.pool,
    game: { getTopup, postTopup },
    pay: {} as PayClient,
    config: loadOutboxConfig({}),
  };
  const ran = (pattern: RegExp) => pool.statements.some((sql) => pattern.test(sql));
  return { deps, getTopup, postTopup, ran };
}

const COMPLETED = /transition_order[\s\S]*/;

describe('runFulfillment', () => {
  it('does not POST when GET finds the top-up', async () => {
    const { deps, postTopup, ran } = setup([{ state: 'found', count: 1 }], { state: 'ok', httpStatus: 200 });

    await runFulfillment(deps, job());

    expect(postTopup).not.toHaveBeenCalled();
    expect(ran(COMPLETED)).toBe(true);
  });

  it.each(['GET TimeoutError', 'GET answered 500'])('does not POST when GET fails with %s', async (reason) => {
    const { deps, postTopup, ran } = setup([{ state: 'unknown', reason }], { state: 'ok', httpStatus: 200 });

    await runFulfillment(deps, job());

    expect(postTopup).not.toHaveBeenCalled();
    expect(ran(/UPDATE outbox\s+SET available_at/)).toBe(true);
  });

  it('checks first, records the attempt, then POSTs on a 404', async () => {
    const { deps, getTopup, postTopup, ran } = setup([{ state: 'not_found' }], { state: 'ok', httpStatus: 200 });

    await runFulfillment(deps, job());

    expect(getTopup).toHaveBeenCalledWith(REFERENCE);
    expect(postTopup).toHaveBeenCalledOnce();
    expect(postTopup.mock.calls[0][0].reference).toBe(REFERENCE);
    expect(ran(/INSERT INTO fulfillment_attempts/)).toBe(true);
    expect(ran(COMPLETED)).toBe(true);
  });

  it('waits at least the settle time after a timed out POST', async () => {
    const pool = fakePool();
    const { deps } = setup([{ state: 'not_found' }], { state: 'unknown', reason: 'POST TimeoutError' }, pool);
    const query = vi.spyOn(deps.pool, 'query');

    await runFulfillment(deps, job());

    const call = query.mock.calls.find(([sql]) => /SET available_at/.test(String(sql)));
    const params = call?.[1] as unknown as unknown[];
    expect(params[2]).toBeGreaterThanOrEqual(deps.config.settleMs);
  });

  it('never POSTs on the last claim, and 404 there means FAILED with a refund', async () => {
    const { deps, postTopup, ran } = setup([{ state: 'not_found' }], { state: 'ok', httpStatus: 200 });

    await runFulfillment(deps, job(deps.config.maxAttempts));

    expect(postTopup).not.toHaveBeenCalled();
    expect(ran(/INSERT INTO refunds/)).toBe(true);
    expect(ran(/INSERT INTO dead_letters/)).toBe(true);
  });

  it('sends the order to review when the last claim still cannot confirm', async () => {
    const { deps, postTopup, ran } = setup(
      [{ state: 'unknown', reason: 'GET TimeoutError' }],
      { state: 'ok', httpStatus: 200 },
    );

    await runFulfillment(deps, job(deps.config.maxAttempts));

    expect(postTopup).not.toHaveBeenCalled();
    expect(ran(/INSERT INTO refunds/)).toBe(false);
    expect(ran(/INSERT INTO dead_letters/)).toBe(true);
  });

  it('stops at the POST limit', async () => {
    const { deps, postTopup } = setup([{ state: 'not_found' }], { state: 'ok', httpStatus: 200 }, fakePool(3));

    await runFulfillment(deps, job(4));

    expect(postTopup).not.toHaveBeenCalled();
  });

  it('uses one reference per line and only POSTs the line that is missing', async () => {
    const pool = fakePool(0, [
      { sku: 'FLASH-SKIN-01', qty: 1 },
      { sku: 'MONTHLY-PASS', qty: 1 },
    ]);
    const { deps, postTopup } = setup(
      [{ state: 'found', count: 1 }, { state: 'not_found' }],
      { state: 'ok', httpStatus: 200 },
      pool,
    );

    await runFulfillment(deps, job());

    expect(postTopup).toHaveBeenCalledOnce();
    expect(postTopup.mock.calls[0][0].reference).toBe(referenceFor(ORDER_ID, 'MONTHLY-PASS'));
  });
});

describe('outbox config', () => {
  it('refuses a lease that a POST could outlive', () => {
    expect(() => loadOutboxConfig({ OUTBOX_LEASE_MS: '1000' })).toThrow(/OUTBOX_LEASE_MS/);
  });

  it('backoff grows, stays within the cap and always has a jitter range', () => {
    expect(backoffMs(1, 1000, 60_000, () => 0)).toBe(500);
    expect(backoffMs(1, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffMs(4, 1000, 60_000, () => 1)).toBe(8000);
    expect(backoffMs(30, 1000, 60_000, () => 1)).toBe(60_000);
  });
});
