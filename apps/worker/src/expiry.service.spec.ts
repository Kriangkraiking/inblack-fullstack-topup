import type pg from 'pg';
import { expireOneOrder } from './expiry.service.js';

type Rows = Record<string, unknown>[];

/** Answers each statement by the first pattern it matches, and records what ran. */
function fakeClient(answers: [RegExp, Rows][]) {
  const statements: string[] = [];
  const client = {
    query: (sql: string) => {
      statements.push(sql);
      const answer = answers.find(([pattern]) => pattern.test(sql));
      return Promise.resolve({ rows: answer ? answer[1] : [] });
    },
  };
  const ran = (pattern: RegExp) => statements.filter((sql) => pattern.test(sql));
  return { client: client as unknown as pg.ClientBase, ran };
}

const RELEASES_HOLDS = /release_order_holds/;

describe('expireOneOrder', () => {
  it('reports nothing to do when no order is due', async () => {
    const { client, ran } = fakeClient([]);

    await expect(expireOneOrder(client)).resolves.toBe(false);
    expect(ran(/COMMIT/)).toHaveLength(1);
  });

  it('returns stock and the voucher use after moving the order', async () => {
    const { client, ran } = fakeClient([
      [/FOR UPDATE SKIP LOCKED/, [{ id: 'ORD-1' }]],
      [/transition_order/, [{ changed: true }]],
    ]);

    await expect(expireOneOrder(client)).resolves.toBe(true);
    expect(ran(RELEASES_HOLDS)).toHaveLength(1);
    expect(ran(/transition_order|release_order_holds/)[0]).toMatch(/transition_order/);
  });

  it('returns nothing when the order already moved', async () => {
    const { client, ran } = fakeClient([
      [/FOR UPDATE SKIP LOCKED/, [{ id: 'ORD-1' }]],
      [/transition_order/, [{ changed: false }]],
    ]);

    await expect(expireOneOrder(client)).resolves.toBe(true);
    expect(ran(RELEASES_HOLDS)).toHaveLength(0);
  });

  it('rolls back when a step fails', async () => {
    const statements: string[] = [];
    const client = {
      query: (sql: string) => {
        statements.push(sql);
        if (/FOR UPDATE SKIP LOCKED/.test(sql)) return Promise.reject(new Error('boom'));
        return Promise.resolve({ rows: [] });
      },
    } as unknown as pg.ClientBase;

    await expect(expireOneOrder(client)).rejects.toThrow('boom');
    expect(statements.at(-1)).toBe('ROLLBACK');
  });
});
