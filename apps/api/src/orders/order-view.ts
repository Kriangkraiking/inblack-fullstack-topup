import { toSatang } from '@inblack/domain';

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

export const ORDER_COLUMNS = `id, email, game_uid, status, payment_method, voucher_code,
  subtotal_satang, discount_satang, net_satang, fee_satang, total_satang, vat_satang,
  paid_satang, refunded_satang, currency, expires_at, created_at`;

export const ORDER_ITEM_COLUMNS = 'sku, name_snapshot, unit_price_satang, qty, line_total_satang';

/** The page of mock-pay the customer's browser opens to pay this order. */
export function buildPaymentUrl(orderId: string, totalSatang: number): string {
  const url = new URL('/checkout', process.env.MOCK_PAY_PUBLIC_URL ?? 'http://localhost:4010');
  const returnUrl = new URL('/track', process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000');
  returnUrl.searchParams.set('order_id', orderId);
  url.searchParams.set('order_id', orderId);
  url.searchParams.set('amount_satang', String(totalSatang));
  url.searchParams.set('return_url', returnUrl.toString());
  return url.toString();
}

export function renderOrder(order: OrderRow, items: readonly OrderItemRow[]) {
  const totalSatang = toSatang(order.total_satang);
  return {
    order_id: order.id,
    status: order.status,
    email: order.email,
    game_uid: order.game_uid,
    payment_method: order.payment_method,
    voucher_code: order.voucher_code,
    currency: order.currency,
    items: items.map((item) => ({
      sku: item.sku,
      name: item.name_snapshot,
      unit_price_satang: toSatang(item.unit_price_satang),
      qty: item.qty,
      line_total_satang: toSatang(item.line_total_satang),
    })),
    subtotal_satang: toSatang(order.subtotal_satang),
    discount_satang: toSatang(order.discount_satang),
    net_satang: toSatang(order.net_satang),
    fee_satang: toSatang(order.fee_satang),
    total_satang: totalSatang,
    vat_satang: toSatang(order.vat_satang),
    paid_satang: toSatang(order.paid_satang),
    refunded_satang: toSatang(order.refunded_satang),
    expires_at: order.expires_at.toISOString(),
    created_at: order.created_at.toISOString(),
    payment_url: buildPaymentUrl(order.id, totalSatang),
  };
}
