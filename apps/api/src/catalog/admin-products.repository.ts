import { Injectable } from '@nestjs/common';
import { DbService, type Tx } from '../db/db.service.js';

export interface AdminProductRow {
  sku: string;
  slug: string;
  name: string;
  price_satang: string;
  stock: number | null;
  max_qty_per_order: number | null;
  max_qty_per_email: number | null;
  active: boolean;
  updated_at: Date;
}

const COLUMNS = `sku, slug, name, price_satang, stock, max_qty_per_order, max_qty_per_email, active, updated_at`;

/** All SQL for the superadmin product screen. */
@Injectable()
export class AdminProductsRepository {
  constructor(private readonly db: DbService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async list(): Promise<AdminProductRow[]> {
    const { rows } = await this.db.query<AdminProductRow>(`SELECT ${COLUMNS} FROM products ORDER BY sku`);
    return rows;
  }

  /**
   * The product row lock, step 4 of the lock order in ADR 0001. This path takes no other lock
   * before it, and order creation, expiry and webhooks wait on the same row, so the stock read
   * here cannot change before the update below commits.
   */
  async lock(tx: Tx, sku: string): Promise<AdminProductRow | undefined> {
    const { rows } = await tx.query<AdminProductRow>(
      `SELECT ${COLUMNS} FROM products WHERE sku = $1 FOR UPDATE`,
      [sku],
    );
    return rows[0];
  }

  /**
   * Writes only what the patch names. The stock write is conditional on the value read under
   * the lock, so even a caller that skipped lock() could not overwrite a sale it did not see.
   * Returns undefined when that condition failed.
   */
  async update(
    tx: Tx,
    sku: string,
    change: { name?: string; priceSatang?: number; stock?: number | null },
    stockRead: number | null,
  ): Promise<AdminProductRow | undefined> {
    const { rows } = await tx.query<AdminProductRow>(
      `UPDATE products SET
         name = COALESCE($2, name),
         price_satang = COALESCE($3::bigint, price_satang),
         stock = CASE WHEN $4::boolean THEN $5::integer ELSE stock END,
         updated_at = now()
       WHERE sku = $1 AND stock IS NOT DISTINCT FROM $6::integer
       RETURNING ${COLUMNS}`,
      [
        sku,
        change.name ?? null,
        change.priceSatang ?? null,
        change.stock !== undefined,
        change.stock ?? null,
        stockRead,
      ],
    );
    return rows[0];
  }
}
