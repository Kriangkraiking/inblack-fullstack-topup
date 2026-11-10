import type { OrderStatus, PaymentMethod } from "@inblack/domain";

export interface Product {
  sku: string;
  slug: string;
  name: string;
  price_satang: number;
  stock: number | null;
  max_qty_per_order: number | null;
  max_qty_per_email: number | null;
  /** Optional fields a newer API may add; the UI works without them. */
  category?: string | null;
  description?: string | null;
}

/** GET /admin/products (superadmin). */
export interface AdminProduct extends Product {
  active: boolean;
  updated_at: string;
}

export interface OrderItem {
  sku: string;
  name: string;
  unit_price_satang: number;
  qty: number;
  line_total_satang: number;
}

export interface Order {
  order_id: string;
  status: OrderStatus;
  email: string;
  game_uid: string;
  payment_method: PaymentMethod;
  voucher_code: string | null;
  currency: string;
  items: OrderItem[];
  subtotal_satang: number;
  discount_satang: number;
  net_satang: number;
  fee_satang: number;
  total_satang: number;
  vat_satang: number;
  paid_satang: number;
  refunded_satang: number;
  expires_at: string;
  created_at: string;
  payment_url: string;
}

export interface TimelineEvent {
  event_id: string;
  event_type: string;
  from_status: string | null;
  status: string;
  occurred_at: string;
  actor?: string;
  reason?: string;
}

export interface OrderWithToken extends Order {
  events_token: string;
  events_token_expires_at: string;
}

export interface OrderDetail extends OrderWithToken {
  timeline: TimelineEvent[];
}

export interface OrderSummary {
  order_id: string;
  status: OrderStatus;
  email: string;
  game_uid: string;
  payment_method: PaymentMethod;
  total_satang: number;
  paid_satang: number;
  refunded_satang: number;
  created_at: string;
  items?: { sku: string; name: string; qty: number }[];
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export type AdminRole = "viewer" | "support" | "finance" | "superadmin";

export interface AdminIdentity {
  email: string;
  role: AdminRole;
  /** Newer API: admins may sign in with a username. */
  username?: string | null;
}

/** GET /admin/stats. Money in satang. */
export interface AdminStats {
  orders_today: number;
  revenue_today_satang: number;
  orders_last_minute: number;
  orders_last_hour: number;
  by_status: Record<string, number>;
  queue_depth: number;
  dead_letters_open: number;
  generated_at: string;
}

export interface AdminOrderDetail extends Order {
  timeline: (TimelineEvent & { actor: string; reason: string })[];
  webhooks: {
    event_id: string;
    type: string;
    amount_satang: number | null;
    currency: string | null;
    occurred_at: string | null;
    received_at: string;
    processed_at: string | null;
    outcome: string | null;
  }[];
  fulfillment_attempts: {
    id: string;
    reference: string;
    attempt_no: number;
    status: string;
    http_status: number | null;
    error: string | null;
    started_at: string;
    finished_at: string | null;
  }[];
  refunds: {
    id: string;
    amount_satang: number;
    status: string;
    actor: string;
    reason: string;
    created_at: string;
    completed_at: string | null;
  }[];
}
