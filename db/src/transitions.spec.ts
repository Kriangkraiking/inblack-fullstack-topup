import { readFile } from 'node:fs/promises';
import { ORDER_STATUSES, ORDER_TRANSITIONS } from '@inblack/domain';
import { expect, it } from 'vitest';

it('the database transition table matches the domain table', async () => {
  const sql = await readFile(new URL('../migrations/0002_orders.sql', import.meta.url), 'utf8');
  const block = /-- transitions:begin([\s\S]*?)-- transitions:end/.exec(sql)?.[1] ?? '';
  const inDatabase = [...block.matchAll(/\('([A-Z_]+)', '([A-Z_]+)'\)/g)]
    .map((match) => `${match[1]}->${match[2]}`)
    .sort();
  const inDomain = ORDER_STATUSES.flatMap((from) =>
    ORDER_TRANSITIONS[from].map((to) => `${from}->${to}`),
  ).sort();

  expect(inDatabase.length).toBeGreaterThan(0);
  expect(inDatabase).toEqual(inDomain);
});
