import { Injectable } from '@nestjs/common';
import {
  assertPerEmailLimit,
  assertPerOrderLimit,
  assertVoucherUsable,
  calculatePrice,
  countsTowardEmailLimit,
  generateOrderId,
  ORDER_STATUSES,
  toSatang,
  type DiscountRule,
  type PriceBreakdown,
} from '@inblack/domain';
import {
  businessProblem,
  ProblemError,
  renderProblem,
} from '../common/problem.js';
import type { Tx } from '../db/db.service.js';
import {
  hashRequest,
  parseOrderInput,
  type OrderInput,
  type TrackInput,
} from './order-input.js';
import { renderOrder } from './order-view.js';
import {
  OrdersRepository,
  type OrderItemRow,
  type OrderRow,
  type ProductRow,
  type VoucherRow,
} from './orders.repository.js';

const IDEMPOTENCY_SCOPE = 'POST /api/v1/orders';
const DEFAULT_ORDER_TTL_SECONDS = 900;
const ORDER_ID_ATTEMPTS = 5;
const COUNTED_STATUSES = ORDER_STATUSES.filter(countsTowardEmailLimit);

export function orderNotFound(): ProblemError {
  return new ProblemError(404, 'ORDER_NOT_FOUND', 'no order matches these details');
}

function keyReused(): ProblemError {
  return new ProblemError(
    422,
    'IDEMPOTENCY_KEY_REUSED',
    'this Idempotency-Key was already used with a different body',
  );
}

export interface StoredResponse {
  status: number;
  body: string;
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

function limitsOf(product: ProductRow) {
  return {
    maxQtyPerOrder: product.max_qty_per_order,
    maxQtyPerEmail: product.max_qty_per_email,
  };
}

@Injectable()
export class OrdersService {
  private readonly ttlSeconds = orderTtlSeconds();

  constructor(private readonly orders: OrdersRepository) {}

  /**
   * The key row, the reservations and the stored response commit together. A parallel
   * request with the same key blocks on the unique index until this transaction ends,
   * then reads the committed response. If this request crashes, everything rolls back
   * and the key is free again, so no key can stay stuck "in progress".
   */
  async create(key: string, body: unknown): Promise<StoredResponse> {
    let input: OrderInput;
    try {
      input = parseOrderInput(body);
    } catch (error) {
      // Stored requests were all valid, so an invalid body under a used key must differ.
      if (await this.orders.keyExists(IDEMPOTENCY_SCOPE, key)) throw keyReused();
      // Not stored, so the client can fix the body and retry with the same key.
      throw error;
    }
    const requestHash = hashRequest(input);

    return this.orders.transaction(async (tx) => {
      await this.orders.deleteKeyIfExpired(tx, IDEMPOTENCY_SCOPE, key);
      const acquired = await this.orders.acquireKey(tx, IDEMPOTENCY_SCOPE, key, requestHash);
      if (!acquired) return this.replay(tx, key, requestHash);

      await this.orders.savepoint(tx);
      let response: StoredResponse;
      try {
        const order = await this.reserve(tx, input);
        response = { status: 201, body: JSON.stringify(order) };
      } catch (error) {
        const problem = businessProblem(error);
        if (!problem) throw error;
        // Undo the reservations only. The key stays, so a retry gets this same answer.
        await this.orders.rollbackToSavepoint(tx);
        response = { status: problem.status, body: renderProblem(problem) };
      }
      await this.orders.storeResponse(tx, IDEMPOTENCY_SCOPE, key, response.status, response.body);
      return response;
    });
  }

  private async replay(tx: Tx, key: string, requestHash: string): Promise<StoredResponse> {
    const stored = await this.orders.readKey(tx, IDEMPOTENCY_SCOPE, key);
    // Only the expiry purge can remove the row between the INSERT and this read.
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
  private async reserve(tx: Tx, input: OrderInput) {
    const products = await this.loadProducts(tx, input);
    const productOf = (sku: string) => products.get(sku) as ProductRow;
    for (const line of input.lines) {
      assertPerOrderLimit(limitsOf(productOf(line.sku)), line.qty);
    }

    await this.orders.lockEmail(tx, input.email);

    const voucher = input.voucherCode
      ? await this.loadUsableVoucher(tx, input.voucherCode, input.email)
      : null;

    const price = calculatePrice({
      lines: input.lines.map((line) => ({
        unitPriceSatang: toSatang(productOf(line.sku).price_satang),
        qty: line.qty,
      })),
      discount: voucher ? discountRule(voucher) : null,
      paymentMethod: input.paymentMethod,
    });

    for (const line of input.lines) {
      const product = productOf(line.sku);
      if (product.max_qty_per_email !== null) {
        const held = await this.orders.sumHeldQty(tx, input.email, line.sku, COUNTED_STATUSES);
        assertPerEmailLimit(limitsOf(product), held, line.qty);
      }
      if (product.stock !== null && !(await this.orders.takeStock(tx, line.sku, line.qty))) {
        throw new ProblemError(409, 'OUT_OF_STOCK', `not enough stock for ${line.sku}`);
      }
    }
    if (voucher && !(await this.orders.takeVoucherUse(tx, voucher.code))) {
      throw new ProblemError(409, 'VOUCHER_EXHAUSTED', 'voucher has no uses left');
    }

    await this.orders.setAuditContext(tx, 'api:orders', 'order created');
    const order = await this.insertOrder(tx, input, price);
    const items: OrderItemRow[] = [];
    for (const line of input.lines) {
      items.push(await this.orders.insertItem(tx, order.id, productOf(line.sku), line.qty));
    }
    if (voucher) {
      await this.orders.insertRedemption(tx, voucher.code, order.id, input.email);
    }
    return renderOrder(order, items);
  }

  private async loadProducts(tx: Tx, input: OrderInput): Promise<Map<string, ProductRow>> {
    const rows = await this.orders.findActiveProducts(
      tx,
      input.lines.map((line) => line.sku),
    );
    const products = new Map(rows.map((row) => [row.sku, row]));
    const missing = input.lines.find((line) => !products.has(line.sku));
    if (missing) {
      throw new ProblemError(422, 'PRODUCT_NOT_FOUND', `no active product with sku ${missing.sku}`);
    }
    return products;
  }

  /** Has to run after lockEmail, because it reads how much this email has used. */
  private async loadUsableVoucher(tx: Tx, code: string, email: string): Promise<VoucherRow> {
    const voucher = await this.orders.findVoucher(tx, code);
    if (!voucher) throw new ProblemError(422, 'VOUCHER_NOT_FOUND', 'no voucher has this code');
    assertVoucherUsable(
      {
        active: voucher.active,
        maxUses: voucher.max_uses,
        usedCount: voucher.used_count,
        maxUsesPerEmail: voucher.max_uses_per_email,
      },
      await this.orders.countOpenRedemptions(tx, code, email),
    );
    return voucher;
  }

  private async insertOrder(tx: Tx, input: OrderInput, price: PriceBreakdown): Promise<OrderRow> {
    for (let attempt = 0; attempt < ORDER_ID_ATTEMPTS; attempt += 1) {
      const order = await this.orders.insertOrder(tx, {
        id: generateOrderId(),
        email: input.email,
        gameUid: input.gameUid,
        paymentMethod: input.paymentMethod,
        voucherCode: input.voucherCode,
        price,
        ttlSeconds: this.ttlSeconds,
      });
      if (order) return order;
    }
    throw new Error('could not find a free order id');
  }

  /** The same answer for an unknown id and a wrong email, so neither can be probed. */
  async track({ orderId, email }: TrackInput) {
    const order = await this.orders.findOrderByIdAndEmail(orderId, email);
    if (!order) throw orderNotFound();
    return renderOrder(order, await this.orders.findItems(order.id));
  }

  /** Callers must have checked ownership first. See OrderAccessGuard. */
  async getById(id: string) {
    const order = await this.orders.findOrderById(id);
    if (!order) throw orderNotFound();
    return renderOrder(order, await this.orders.findItems(order.id));
  }
}
