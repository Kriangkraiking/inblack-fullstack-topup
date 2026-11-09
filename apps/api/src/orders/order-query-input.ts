import { isValidOrderId, normalizeEmail, ORDER_STATUSES, type OrderStatus } from '@inblack/domain';
import { z } from 'zod';
import { ProblemError } from '../common/problem.js';
import { parseWith } from '../common/validate.js';
import { decodeCursor, type OrderCursor } from './order-cursor.js';
import type { AdminOrderFilter } from './order-query.repository.js';

/** My Orders tabs (spec 9.2). An order the system still works on is current. */
export const CURRENT_STATUSES: readonly OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAID',
  'IN_QUEUE',
  'IN_PROGRESS',
  'NEEDS_REVIEW',
];
export const PAST_STATUSES: readonly OrderStatus[] = ORDER_STATUSES.filter(
  (status) => !CURRENT_STATUSES.includes(status),
);

const limitSchema = z.coerce.number().int().min(1).max(100).default(20);
const cursorSchema = z.string().max(128).optional();
const isoSchema = z.iso.datetime({ offset: true }).optional();
const statusListSchema = z
  .string()
  .max(200)
  .transform((value) => value.split(',').map((status) => status.trim()))
  .pipe(z.array(z.enum(ORDER_STATUSES)).min(1).max(ORDER_STATUSES.length))
  .optional();

const adminListSchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
  status: statusListSchema,
  from: isoSchema,
  to: isoSchema,
  q: z.string().trim().min(1).max(254).optional(),
});

const myListSchema = z.object({
  tab: z.enum(['current', 'past']).default('current'),
  limit: limitSchema,
  cursor: cursorSchema,
});

export interface AdminListInput {
  filter: AdminOrderFilter;
  cursor: OrderCursor | null;
  limit: number;
}

export interface MyListInput {
  statuses: readonly OrderStatus[];
  cursor: OrderCursor | null;
  limit: number;
}

const emailSchema = z.email().max(254);

/** q is an exact order id or an exact email: both have an index, a substring search does not. */
function parseSearch(q: string | undefined): Pick<AdminOrderFilter, 'orderId' | 'email'> {
  if (q === undefined) return { orderId: null, email: null };
  const upper = q.toUpperCase();
  if (upper.startsWith('ORD-')) {
    if (!isValidOrderId(upper)) throw new ProblemError(422, 'INVALID_ORDER_ID', 'q: order id format or checksum is invalid');
    return { orderId: upper, email: null };
  }
  const email = normalizeEmail(q);
  if (!emailSchema.safeParse(email).success) {
    throw new ProblemError(422, 'VALIDATION_ERROR', 'q: give a full order id or a full email');
  }
  return { orderId: null, email };
}

export function parseAdminListQuery(query: unknown): AdminListInput {
  const input = parseWith(adminListSchema, query);
  const from = input.from ? new Date(input.from) : null;
  const to = input.to ? new Date(input.to) : null;
  if (from && to && from >= to) throw new ProblemError(422, 'VALIDATION_ERROR', 'from must be before to');
  return {
    filter: { statuses: input.status ?? null, from, to, ...parseSearch(input.q) },
    cursor: input.cursor ? decodeCursor(input.cursor) : null,
    limit: input.limit,
  };
}

export function parseMyListQuery(query: unknown): MyListInput {
  const input = parseWith(myListSchema, query);
  return {
    statuses: input.tab === 'current' ? CURRENT_STATUSES : PAST_STATUSES,
    cursor: input.cursor ? decodeCursor(input.cursor) : null,
    limit: input.limit,
  };
}
