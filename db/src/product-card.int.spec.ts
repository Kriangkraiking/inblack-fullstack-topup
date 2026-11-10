import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 0013 against a real Postgres: product card fields. Skipped unless TEST_DATABASE_URL
 * is set. Own database on that server.
 */
const baseUrl = process.env.TEST_DATABASE_URL;
const DB_NAME = 'inblack_int_product_card';
const url = baseUrl && Object.assign(new URL(baseUrl), { pathname: `/${DB_NAME}` }).toString();
const MIGRATIONS = new URL('../migrations/', import.meta.url);
const SEED = new URL('../seed/seed.sql', import.meta.url);

describe.skipIf(!url)('product card fields (real Postgres)', () => {
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
  });

  afterAll(async () => {
    await client.end();
  });

  it('fills the 4 SKUs and leaves SKU, price, stock and limits exactly as spec 4 says', async () => {
    const { rows } = await client.query(
      `SELECT sku, price_satang::int AS price, stock, max_qty_per_order, max_qty_per_email, category,
              image_path, description IS NOT NULL AS has_description
       FROM products ORDER BY sku`,
    );
    expect(rows).toEqual([
      { sku: 'DIAMOND-1000', price: 34900, stock: null, max_qty_per_order: null, max_qty_per_email: null, category: 'currency', image_path: '/images/products/diamond-1000.png', has_description: true },
      { sku: 'DIAMOND-5000', price: 159000, stock: null, max_qty_per_order: null, max_qty_per_email: null, category: 'currency', image_path: '/images/products/diamond-5000.png', has_description: true },
      { sku: 'FLASH-SKIN-01', price: 9900, stock: 100, max_qty_per_order: null, max_qty_per_email: 2, category: 'skin', image_path: '/images/products/flash-skin-01.png', has_description: true },
      { sku: 'MONTHLY-PASS', price: 17900, stock: null, max_qty_per_order: 1, max_qty_per_email: null, category: 'pass', image_path: '/images/products/monthly-pass.png', has_description: true },
    ]);
  });

  it('re-running the seed keeps a changed description, and an outside image URL is refused', async () => {
    await client.query(`UPDATE products SET description = 'edited' WHERE sku = 'DIAMOND-1000'`);
    await client.query(await readFile(SEED, 'utf8'));
    const { rows } = await client.query(`SELECT description FROM products WHERE sku = 'DIAMOND-1000'`);
    expect(rows[0].description).toBe('edited');
    await expect(
      client.query(`UPDATE products SET image_path = 'https://evil.example/x.png' WHERE sku = 'DIAMOND-1000'`),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
