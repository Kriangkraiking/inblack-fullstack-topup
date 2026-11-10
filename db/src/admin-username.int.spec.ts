import { scryptSync, timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 0011 against a real Postgres: admin usernames. Skipped unless TEST_DATABASE_URL is
 * set, see refund-settlement.int.spec.ts. Uses a database of its own on that server.
 */
const baseUrl = process.env.TEST_DATABASE_URL;
const DB_NAME = 'inblack_int_admin_username';
const url = baseUrl && Object.assign(new URL(baseUrl), { pathname: `/${DB_NAME}` }).toString();
const MIGRATIONS = new URL('../migrations/', import.meta.url);
const SEED = new URL('../seed/seed.sql', import.meta.url);

describe.skipIf(!url)('admin usernames (real Postgres)', () => {
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
    // The seed runs on every start: twice must leave the same rows.
    await client.query(await readFile(SEED, 'utf8'));
    await client.query(await readFile(SEED, 'utf8'));
  });

  afterAll(async () => {
    await client.end();
  });

  it('keeps the four role accounts and adds one superadmin with username Admin', async () => {
    const { rows } = await client.query<{ email: string; username: string | null; role: string }>(
      'SELECT email, username, role FROM admin_users ORDER BY email',
    );
    expect(rows).toEqual([
      { email: 'admin@inblackm.test', username: 'Admin', role: 'superadmin' },
      { email: 'finance@inblackm.test', username: null, role: 'finance' },
      { email: 'superadmin@inblackm.test', username: null, role: 'superadmin' },
      { email: 'support@inblackm.test', username: null, role: 'support' },
      { email: 'viewer@inblackm.test', username: null, role: 'viewer' },
    ]);
  });

  it('stores only an scrypt hash that verifies Admin3324', async () => {
    const { rows } = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM admin_users WHERE lower(username) = lower('ADMIN')`,
    );
    const [, n, r, p, salt, hash] = rows[0].password_hash.split('$');
    expect([n, r, p]).toEqual(['16384', '8', '1']);
    const derived = scryptSync('Admin3324', Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
    expect(timingSafeEqual(derived, Buffer.from(hash, 'base64'))).toBe(true);
    expect(rows[0].password_hash).not.toContain('Admin3324');
  });

  it('refuses a second username that differs only in case, and one with @', async () => {
    await expect(
      client.query(
        `INSERT INTO admin_users (email, username, password_hash, role)
         VALUES ('other@inblackm.test', 'aDMIN', 'scrypt$x', 'viewer')`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      client.query(
        `INSERT INTO admin_users (email, username, password_hash, role)
         VALUES ('other2@inblackm.test', 'a@b', 'scrypt$x', 'viewer')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
