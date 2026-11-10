import { ORDER_STATUSES, type OrderStatus } from '@inblack/domain';

/** One row of admin_dashboard_stats() (migration 0012). pg returns bigint as a string. */
export interface StatsRow {
  orders_today: string;
  revenue_today_satang: string;
  orders_last_minute: string;
  orders_last_hour: string;
  queue_depth: string;
  dead_letters_open: string;
}

export interface AdminStats {
  orders_today: number;
  revenue_today_satang: number;
  orders_last_minute: number;
  orders_last_hour: number;
  by_status: Record<OrderStatus, number>;
  queue_depth: number;
  dead_letters_open: number;
  generated_at: string;
}

/** Exact integer or an error, never a rounded float. Revenue may be negative (refund-heavy day). */
export function toSafeInteger(value: string | number, field: string): number {
  const text = String(value);
  if (!/^-?[0-9]+$/.test(text)) throw new Error(`${field} is not an integer: ${text}`);
  const big = BigInt(text);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${field} does not fit a safe integer`);
  }
  return Number(big);
}

/** Every status appears, with 0 when no order has it, so the dashboard never sees a gap. */
export function renderStats(
  row: StatsRow,
  byStatus: { status: string; n: string | number }[],
  now: Date,
): AdminStats {
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
  for (const { status, n } of byStatus) {
    if ((ORDER_STATUSES as readonly string[]).includes(status)) {
      counts[status as OrderStatus] = toSafeInteger(n, `by_status.${status}`);
    }
  }
  return {
    orders_today: toSafeInteger(row.orders_today, 'orders_today'),
    revenue_today_satang: toSafeInteger(row.revenue_today_satang, 'revenue_today_satang'),
    orders_last_minute: toSafeInteger(row.orders_last_minute, 'orders_last_minute'),
    orders_last_hour: toSafeInteger(row.orders_last_hour, 'orders_last_hour'),
    by_status: counts,
    queue_depth: toSafeInteger(row.queue_depth, 'queue_depth'),
    dead_letters_open: toSafeInteger(row.dead_letters_open, 'dead_letters_open'),
    generated_at: now.toISOString(),
  };
}
