import { toSatang } from '@inblack/domain';
import type { OrderItemRow, OrderRow } from './orders.repository.js';

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
