import { Injectable } from '@nestjs/common';
import {
  assertPerEmailLimit,
  assertPerOrderLimit,
  assertVoucherUsable,
  calculatePrice,
  countsTowardEmailLimit,
  generateOrderId,
  isValidOrderId,
  ORDER_STATUSES,
  toSatang,
  type DiscountRule,
} from '@inblack/domain';
import type pg from 'pg';
import {
  businessProblem,
  ProblemError,
  renderProblem,
} from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import {
  hashRequest,
  parseEmail,
  parseOrderInput,
  type OrderInput,
} from './order-input.js';
import {
  ORDER_COLUMNS,
  ORDER_ITEM_COLUMNS,
  renderOrder,
  type OrderItemRow,
  type OrderRow,
} from './order-view.js';

const IDEMPOTENCY_SCOPE = 'POST /api/v1/orders';
const DEFAULT_ORDER_TTL_SECONDS = 900;
/** Namespace of the per-email advisory lock. Late-payment re-reservation must use it too. */
const EMAIL_LOCK_NAMESPACE = 727002;
const ORDER_ID_ATTEMPTS = 5;
const COUNTED_STATUSES = ORDER_STATUSES.filter(countsTowardEmailLimit);

const ORDER_NOT_FOUND_DETAIL = 'no order matches these details';

export function orderNotFound(): ProblemError {
  return new ProblemError(404, 'ORDER_NOT_FOUND', ORDER_NOT_FOUND_DETAIL);
}

export interface StoredResponse {
  status: number;
  body: string;
}

interface ProductRow {
  sku: string;
  name: string;
  price_satang: string;
  stock: number | null;
  max_qty_per_order: number | null;
  max_qty_per_email: number | null;
}

interface VoucherRow {
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

function orderTtlSeconds(): number {
  const ttl = Number(process.env.ORDER_TTL_SECONDS ?? DEFAULT_ORDER_TTL_SECONDS);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error('ORDER_TTL_SECONDS must be a positive integer');
  }
  return ttl;
}

function discountRule(voucher: VoucherRow): DiscountRule {
  const minSubtotalSatang = toSatang(voucher.min_subtotal_satang);
  if (voucher.discount_type === 'PERCENT') {
    return {
      type: 'PERCENT',
      percentBps: voucher.percent_bps ?? 0,
      capSatang: voucher.cap_satang === null ? null : toSatang(voucher.cap_satang),
      minSubtotalSatang,
    };
  }
  return { type: 'FIXED', fixedSatang: toSatang(voucher.fixed_satang ?? '0'), minSubtotalSatang };
}

@Injectable()
export class OrdersService {
  private readonly ttlSeconds = orderTtlSeconds();

  constructor(private readonly db: DbService) {}

  /**
   * The key row, the reservations and the stored response commit together. A parallel
   * request with the same key blocks on the unique index until this transaction ends,
   * then reads the committed response. If this request crashes, everything rolls back
   * and the key is free again, so no key can stay stuck "in progress".
   */
  async create(key: string, body: unknown): Promise<StoredResponse> {
    const requestHash = hashRequest(body);
    let input: OrderInput;
    try {
      input = parseOrderInput(body);
    } catch (error) {
      // Not stored, so the client can fix the body and retry with the same key.
      await this.assertKeyNotReused(key, requestHash);
      throw error;
    }

    return this.db.transaction(async (client) => {
      await client.query(
        'DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND expires_at <= now()',
        [IDEMPOTENCY_SCOPE, key],
      );
      const acquired = await client.query(
        `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3)
         ON CONFLICT (scope, key) DO NOTHING`,
        [IDEMPOTENCY_SCOPE, key, requestHash],
      );
      if (acquired.rowCount === 0) return this.replay(client, key, requestHash);

      await client.query('SAVEPOINT reservation');
      let response: StoredResponse;
      try {
        const order = await this.reserve(client, input);
        response = { status: 201, body: JSON.stringify(order) };
      } catch (error) {
        const problem = businessProblem(error);
        if (!problem) throw error;
        // Undo the reservations only. The key stays, so a retry gets this same answer.
        await client.query('ROLLBACK TO SAVEPOINT reservation');
        response = { status: problem.status, body: renderProblem(problem) };
      }
      await client.query(
        'UPDATE idempotency_keys SET status_code = $3, response_body = $4 WHERE scope = $1 AND key = $2',
        [IDEMPOTENCY_SCOPE, key, response.status, response.body],
      );
      return response;
    });
  }

  private async assertKeyNotReused(key: string, requestHash: string): Promise<void> {
    const { rows } = await this.db.query<{ request_hash: string }>(
      'SELECT request_hash FROM idempotency_keys WHERE scope = $1 AND key = $2 AND expires_at > now()',
      [IDEMPOTENCY_SCOPE, key],
    );
    if (rows.length > 0 && rows[0].request_hash !== requestHash) throw keyReused();
  }

  private async replay(
    client: pg.PoolClient,
    key: string,
    requestHash: string,
  ): Promise<StoredResponse> {
    const { rows } = await client.query<{
      request_hash: string;
      status_code: number | null;
      response_body: string | null;
    }>(
      'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2',
      [IDEMPOTENCY_SCOPE, key],
    );
    // Only the expiry purge can remove the row between the INSERT and this SELECT.
    const stored = rows[0];
    if (!stored || stored.status_code === null || stored.response_body === null) {
      throw new ProblemError(503, 'IDEMPOTENCY_RETRY', 'please try again');
    }
    if (stored.request_hash !== requestHash) throw keyReused();
    return { status: stored.status_code, body: stored.response_body };
  }

  /**
   * Lock order, which every writer of these rows must follow to stay free of deadlocks:
   * idempotency key, then email advisory lock, then products by SKU, then voucher.
   */
  private async reserve(client: pg.PoolClient, input: OrderInput) {
    const products = await loadProducts(client, input);
    for (const line of input.lines) {
      const product = products.get(line.sku) as ProductRow;
      assertPerOrderLimit(
        { maxQtyPerOrder: product.max_qty_per_order, maxQtyPerEmail: product.max_qty_per_email },
        line.qty,
      );
    }

    // Everything that reads "how much has this email used" has to happen after this lock.
    await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
      EMAIL_LOCK_NAMESPACE,
      input.email,
    ]);

    const voucher = input.voucherCode
      ? await loadUsableVoucher(client, input.voucherCode, input.email)
      : null;

    const price = calculatePrice({
      lines: input.lines.map((line) => ({
        unitPriceSatang: toSatang((products.get(line.sku) as ProductRow).price_satang),
        qty: line.qty,
      })),
      discount: voucher ? discountRule(voucher) : null,
      paymentMethod: input.paymentMethod,
    });

    for (const line of input.lines) {
      const product = products.get(line.sku) as ProductRow;
      await assertEmailAllowance(client, input.email, product, line.qty);
      if (product.stock !== null) await takeStock(client, line.sku, line.qty);
    }
    if (voucher) await takeVoucherUse(client, voucher.code);

    await client.query(
      "SELECT set_config('app.actor', 'api:orders', true), set_config('app.reason', 'order created', true)",
    );
    const order = await insertOrder(client, input, price, this.ttlSeconds);

    const items: OrderItemRow[] = [];
    for (const line of input.lines) {
      const product = products.get(line.sku) as ProductRow;
      const inserted = await client.query<OrderItemRow>(
        `INSERT INTO order_items (order_id, sku, name_snapshot, unit_price_satang, qty, line_total_satang)
         VALUES ($1, $2, $3, $4, $5, $4::bigint * $5::integer)
         RETURNING ${ORDER_ITEM_COLUMNS}`,
        [order.id, line.sku, product.name, product.price_satang, line.qty],
      );
      items.push(inserted.rows[0]);
    }

    if (voucher) {
      await client.query(
        'INSERT INTO voucher_redemptions (voucher_code, order_id, email) VALUES ($1, $2, $3)',
        [voucher.code, order.id, input.email],
      );
    }
    return renderOrder(order, items);
  }

  /** The same answer for an unknown id and a wrong email, so neither can be probed. */
  async track(body: unknown) {
    const input = (body ?? {}) as { order_id?: unknown; email?: unknown };
    if (typeof input.order_id !== 'string' || !isValidOrderId(input.order_id)) {
      throw new ProblemError(422, 'INVALID_ORDER_ID', 'order id format or checksum is invalid');
    }
    const order = await this.loadOrder(
      'id = $1 AND email = $2',
      [input.order_id, parseEmail(input.email)],
    );
    if (!order) throw orderNotFound();
    return order;
  }

  /** Callers must have checked ownership first. See OrderAccessGuard. */
  async getById(id: string) {
    const order = await this.loadOrder('id = $1', [id]);
    if (!order) throw orderNotFound();
    return order;
  }

  private async loadOrder(where: string, params: unknown[]) {
    const { rows } = await this.db.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE ${where}`,
      params,
    );
    if (rows.length === 0) return null;
    const items = await this.db.query<OrderItemRow>(
      `SELECT ${ORDER_ITEM_COLUMNS} FROM order_items WHERE order_id = $1 ORDER BY sku`,
      [rows[0].id],
    );
    return renderOrder(rows[0], items.rows);
  }
}

function keyReused(): ProblemError {
  return new ProblemError(
    422,
    'IDEMPOTENCY_KEY_REUSED',
    'this Idempotency-Key was already used with a different body',
  );
}

async function loadProducts(
  client: pg.PoolClient,
  input: OrderInput,
): Promise<Map<string, ProductRow>> {
  const { rows } = await client.query<ProductRow>(
    `SELECT sku, name, price_satang, stock, max_qty_per_order, max_qty_per_email
     FROM products WHERE sku = ANY($1) AND active`,
    [input.lines.map((line) => line.sku)],
  );
  const products = new Map(rows.map((row) => [row.sku, row]));
  const missing = input.lines.find((line) => !products.has(line.sku));
  if (missing) {
    throw new ProblemError(422, 'PRODUCT_NOT_FOUND', `no active product with sku ${missing.sku}`);
  }
  return products;
}

async function loadUsableVoucher(
  client: pg.PoolClient,
  code: string,
  email: string,
): Promise<VoucherRow> {
  const { rows } = await client.query<VoucherRow>(
    `SELECT code, discount_type, percent_bps, fixed_satang, cap_satang, min_subtotal_satang,
            max_uses, used_count, max_uses_per_email, active
     FROM vouchers WHERE code = $1`,
    [code],
  );
  const voucher = rows[0];
  if (!voucher) throw new ProblemError(422, 'VOUCHER_NOT_FOUND', 'no voucher has this code');
  const uses = await client.query<{ uses: number }>(
    `SELECT count(*)::int AS uses FROM voucher_redemptions
     WHERE voucher_code = $1 AND email = $2 AND released_at IS NULL`,
    [code, email],
  );
  assertVoucherUsable(
    {
      active: voucher.active,
      maxUses: voucher.max_uses,
      usedCount: voucher.used_count,
      maxUsesPerEmail: voucher.max_uses_per_email,
    },
    uses.rows[0].uses,
  );
  return voucher;
}

async function assertEmailAllowance(
  client: pg.PoolClient,
  email: string,
  product: ProductRow,
  qty: number,
): Promise<void> {
  if (product.max_qty_per_email === null) return;
  const held = await client.query<{ qty: number }>(
    `SELECT coalesce(sum(i.qty), 0)::int AS qty
     FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE o.email = $1 AND i.sku = $2 AND o.status = ANY($3)`,
    [email, product.sku, COUNTED_STATUSES],
  );
  assertPerEmailLimit(
    { maxQtyPerOrder: product.max_qty_per_order, maxQtyPerEmail: product.max_qty_per_email },
    held.rows[0].qty,
    qty,
  );
}

/** This single statement is what stops oversell: the row lock serialises the check and the write. */
async function takeStock(client: pg.PoolClient, sku: string, qty: number): Promise<void> {
  const { rowCount } = await client.query(
    'UPDATE products SET stock = stock - $2, updated_at = now() WHERE sku = $1 AND stock >= $2',
    [sku, qty],
  );
  if (rowCount === 0) throw new ProblemError(409, 'OUT_OF_STOCK', `not enough stock for ${sku}`);
}

/** The same pattern as takeStock, for the voucher's total use limit. */
async function takeVoucherUse(client: pg.PoolClient, code: string): Promise<void> {
  const { rowCount } = await client.query(
    `UPDATE vouchers SET used_count = used_count + 1, updated_at = now()
     WHERE code = $1 AND active AND (max_uses IS NULL OR used_count < max_uses)`,
    [code],
  );
  if (rowCount === 0) throw new ProblemError(409, 'VOUCHER_EXHAUSTED', 'voucher has no uses left');
}

async function insertOrder(
  client: pg.PoolClient,
  input: OrderInput,
  price: ReturnType<typeof calculatePrice>,
  ttlSeconds: number,
): Promise<OrderRow> {
  for (let attempt = 0; attempt < ORDER_ID_ATTEMPTS; attempt += 1) {
    const { rows } = await client.query<OrderRow>(
      `INSERT INTO orders (id, email, game_uid, payment_method, voucher_code,
         subtotal_satang, discount_satang, net_satang, fee_satang, total_satang, vat_satang,
         expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         now() + make_interval(secs => $12::double precision))
       ON CONFLICT (id) DO NOTHING
       RETURNING ${ORDER_COLUMNS}`,
      [
        generateOrderId(),
        input.email,
        input.gameUid,
        input.paymentMethod,
        input.voucherCode,
        price.subtotalSatang,
        price.discountSatang,
        price.netSatang,
        price.feeSatang,
        price.totalSatang,
        price.vatSatang,
        ttlSeconds,
      ],
    );
    if (rows.length > 0) return rows[0];
  }
  throw new Error('could not find a free order id');
}
