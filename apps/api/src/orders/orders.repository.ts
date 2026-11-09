import { Injectable } from '@nestjs/common';
import type { PriceBreakdown } from '@inblack/domain';
import { DbService, type Tx } from '../db/db.service.js';

/** All SQL for orders. Every value is a bound parameter, and no statement is built from strings. */

export interface OrderRow {
  id: string;
  email: string;
  game_uid: string;
  status: string;
  payment_method: string;
  voucher_code: string | null;
  subtotal_satang: string;
  discount_satang: string;
  net_satang: string;
  fee_satang: string;
  total_satang: string;
  vat_satang: string;
  paid_satang: string;
  refunded_satang: string;
  currency: string;
  expires_at: Date;
  created_at: Date;
}

export interface OrderItemRow {
  sku: string;
  name_snapshot: string;
  unit_price_satang: string;
  qty: number;
  line_total_satang: string;
}

export interface ProductRow {
  sku: string;
  name: string;
  price_satang: string;
  stock: number | null;
  max_qty_per_order: number | null;
  max_qty_per_email: number | null;
}

export interface VoucherRow {
  code: string;
  discount_type: 'PERCENT' | 'FIXED';
  percent_bps: number | null;
  fixed_satang: string | null;
  cap_satang: string | null;
  min_subtotal_satang: string;
  max_uses: number | null;
  used_count: number;
  max_uses_per_email: number | null;
  active: boolean;
}

export interface StoredKey {
  request_hash: string;
  status_code: number | null;
  response_body: string | null;
}

export interface NewOrder {
  id: string;
  email: string;
  gameUid: string;
  paymentMethod: string;
  voucherCode: string | null;
  price: PriceBreakdown;
  ttlSeconds: number;
}

/** Namespace of the per-email advisory lock. Late-payment re-reservation must use it too. */
const EMAIL_LOCK_NAMESPACE = 727002;

@Injectable()
export class OrdersRepository {
  constructor(private readonly db: DbService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async savepoint(tx: Tx): Promise<void> {
    await tx.query('SAVEPOINT reservation');
  }

  async rollbackToSavepoint(tx: Tx): Promise<void> {
    await tx.query('ROLLBACK TO SAVEPOINT reservation');
  }

  // ---------- Idempotency keys ----------

  async keyExists(scope: string, key: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'SELECT 1 FROM idempotency_keys WHERE scope = $1 AND key = $2 AND expires_at > now()',
      [scope, key],
    );
    return rowCount === 1;
  }

  async deleteKeyIfExpired(tx: Tx, scope: string, key: string): Promise<void> {
    await tx.query(
      'DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND expires_at <= now()',
      [scope, key],
    );
  }

  /** Blocks while another open transaction holds this key, then returns false if it committed. */
  async acquireKey(tx: Tx, scope: string, key: string, requestHash: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (scope, key) DO NOTHING`,
      [scope, key, requestHash],
    );
    return rowCount === 1;
  }

  async readKey(tx: Tx, scope: string, key: string): Promise<StoredKey | undefined> {
    const { rows } = await tx.query<StoredKey>(
      'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2',
      [scope, key],
    );
    return rows[0];
  }

  async storeResponse(tx: Tx, scope: string, key: string, status: number, body: string): Promise<void> {
    await tx.query(
      'UPDATE idempotency_keys SET status_code = $3, response_body = $4 WHERE scope = $1 AND key = $2',
      [scope, key, status, body],
    );
  }

  // ---------- Reservation ----------

  async findActiveProducts(tx: Tx, skus: string[]): Promise<ProductRow[]> {
    const { rows } = await tx.query<ProductRow>(
      `SELECT sku, name, price_satang, stock, max_qty_per_order, max_qty_per_email
       FROM products WHERE sku = ANY($1) AND active`,
      [skus],
    );
    return rows;
  }

  /** Everything that reads "how much has this email used" has to happen after this lock. */
  async lockEmail(tx: Tx, email: string): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
      EMAIL_LOCK_NAMESPACE,
      email,
    ]);
  }

  async findVoucher(tx: Tx, code: string): Promise<VoucherRow | undefined> {
    const { rows } = await tx.query<VoucherRow>(
      `SELECT code, discount_type, percent_bps, fixed_satang, cap_satang, min_subtotal_satang,
              max_uses, used_count, max_uses_per_email, active
       FROM vouchers WHERE code = $1`,
      [code],
    );
    return rows[0];
  }

  async countOpenRedemptions(tx: Tx, code: string, email: string): Promise<number> {
    const { rows } = await tx.query<{ uses: number }>(
      `SELECT count(*)::int AS uses FROM voucher_redemptions
       WHERE voucher_code = $1 AND email = $2 AND released_at IS NULL`,
      [code, email],
    );
    return rows[0].uses;
  }

  async sumHeldQty(tx: Tx, email: string, sku: string, statuses: readonly string[]): Promise<number> {
    const { rows } = await tx.query<{ qty: number }>(
      `SELECT coalesce(sum(i.qty), 0)::int AS qty
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.email = $1 AND i.sku = $2 AND o.status = ANY($3)`,
      [email, sku, statuses],
    );
    return rows[0].qty;
  }

  /** This single statement stops oversell: the row lock serialises the check and the write. */
  async takeStock(tx: Tx, sku: string, qty: number): Promise<boolean> {
    const { rowCount } = await tx.query(
      'UPDATE products SET stock = stock - $2, updated_at = now() WHERE sku = $1 AND stock >= $2',
      [sku, qty],
    );
    return rowCount === 1;
  }

  /** The same pattern as takeStock, for the voucher's total use limit. */
  async takeVoucherUse(tx: Tx, code: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE vouchers SET used_count = used_count + 1, updated_at = now()
       WHERE code = $1 AND active AND (max_uses IS NULL OR used_count < max_uses)`,
      [code],
    );
    return rowCount === 1;
  }

  /** The status trigger reads these for the order_events row. */
  async setAuditContext(tx: Tx, actor: string, reason: string): Promise<void> {
    await tx.query("SELECT set_config('app.actor', $1, true), set_config('app.reason', $2, true)", [
      actor,
      reason,
    ]);
  }

  /** Returns undefined if the id is already taken, so the caller can try another. */
  async insertOrder(tx: Tx, order: NewOrder): Promise<OrderRow | undefined> {
    const { price } = order;
    const { rows } = await tx.query<OrderRow>(
      `INSERT INTO orders (id, email, game_uid, payment_method, voucher_code,
         subtotal_satang, discount_satang, net_satang, fee_satang, total_satang, vat_satang,
         expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         now() + make_interval(secs => $12::double precision))
       ON CONFLICT (id) DO NOTHING
       RETURNING id, email, game_uid, status, payment_method, voucher_code,
         subtotal_satang, discount_satang, net_satang, fee_satang, total_satang, vat_satang,
         paid_satang, refunded_satang, currency, expires_at, created_at`,
      [
        order.id,
        order.email,
        order.gameUid,
        order.paymentMethod,
        order.voucherCode,
        price.subtotalSatang,
        price.discountSatang,
        price.netSatang,
        price.feeSatang,
        price.totalSatang,
        price.vatSatang,
        order.ttlSeconds,
      ],
    );
    return rows[0];
  }

  async insertItem(
    tx: Tx,
    orderId: string,
    product: ProductRow,
    qty: number,
  ): Promise<OrderItemRow> {
    const { rows } = await tx.query<OrderItemRow>(
      `INSERT INTO order_items (order_id, sku, name_snapshot, unit_price_satang, qty, line_total_satang)
       VALUES ($1, $2, $3, $4, $5, $4::bigint * $5::integer)
       RETURNING sku, name_snapshot, unit_price_satang, qty, line_total_satang`,
      [orderId, product.sku, product.name, product.price_satang, qty],
    );
    return rows[0];
  }

  async insertRedemption(tx: Tx, code: string, orderId: string, email: string): Promise<void> {
    await tx.query(
      'INSERT INTO voucher_redemptions (voucher_code, order_id, email) VALUES ($1, $2, $3)',
      [code, orderId, email],
    );
  }

  // ---------- Reads ----------

  async findOrderByIdAndEmail(id: string, email: string): Promise<OrderRow | undefined> {
    const { rows } = await this.db.query<OrderRow>(
      `SELECT id, email, game_uid, status, payment_method, voucher_code,
         subtotal_satang, discount_satang, net_satang, fee_satang, total_satang, vat_satang,
         paid_satang, refunded_satang, currency, expires_at, created_at
       FROM orders WHERE id = $1 AND email = $2`,
      [id, email],
    );
    return rows[0];
  }

  async findOrderById(id: string): Promise<OrderRow | undefined> {
    const { rows } = await this.db.query<OrderRow>(
      `SELECT id, email, game_uid, status, payment_method, voucher_code,
         subtotal_satang, discount_satang, net_satang, fee_satang, total_satang, vat_satang,
         paid_satang, refunded_satang, currency, expires_at, created_at
       FROM orders WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async findItems(orderId: string): Promise<OrderItemRow[]> {
    const { rows } = await this.db.query<OrderItemRow>(
      `SELECT sku, name_snapshot, unit_price_satang, qty, line_total_satang
       FROM order_items WHERE order_id = $1 ORDER BY sku`,
      [orderId],
    );
    return rows;
  }
}
