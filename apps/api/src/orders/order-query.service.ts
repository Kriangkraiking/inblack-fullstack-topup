import { Injectable } from '@nestjs/common';
import { isValidOrderId, toSatang } from '@inblack/domain';
import type { Admin } from '../admin/admin-roles.js';
import { EventsTokenService } from '../realtime/events-token.service.js';
import { ProblemError } from '../common/problem.js';
import { maskPii, seesFullPii } from '../security/pii-mask.js';
import { pageOf } from './order-cursor.js';
import type { AdminListInput, MyListInput } from './order-query-input.js';
import { OrderQueryRepository, type EventRow, type OrderListRow } from './order-query.repository.js';
import { renderOrder } from './order-view.js';
import { OrdersRepository } from './orders.repository.js';
import { orderNotFound } from './orders.service.js';

/** Who is asking. Both can be set when one browser holds both cookies; admin wins. */
export interface Viewer {
  admin?: Admin;
  customerEmail?: string;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function renderListRow(row: OrderListRow) {
  return {
    order_id: row.id,
    status: row.status,
    email: row.email,
    game_uid: row.game_uid,
    payment_method: row.payment_method,
    total_satang: toSatang(row.total_satang),
    paid_satang: toSatang(row.paid_satang),
    refunded_satang: toSatang(row.refunded_satang),
    created_at: row.created_at.toISOString(),
  };
}

/** The customer's timeline: the same fields as the SSE stream, no actor and no reason. */
function publicEvent(row: EventRow) {
  return {
    event_id: row.id,
    event_type: row.event_type,
    from_status: row.from_status,
    status: row.to_status,
    occurred_at: row.created_at.toISOString(),
  };
}

/** Admins also see who did it and why. Actors are admin:<id>, never an email (adminActor). */
function adminEvent(row: EventRow) {
  return { ...publicEvent(row), actor: row.actor, reason: row.reason };
}

@Injectable()
export class OrderQueryService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly queries: OrderQueryRepository,
    private readonly eventsTokens: EventsTokenService,
  ) {}

  /**
   * GET /orders/{id}: the owner or an admin. Everyone else, signed in or not, gets the same 404
   * as an order that does not exist (spec 8.4), so the answer never confirms an order id.
   */
  async getForViewer(id: string, viewer: Viewer) {
    if (!isValidOrderId(id) || (!viewer.admin && !viewer.customerEmail)) throw orderNotFound();
    const order = await this.orders.findOrderById(id);
    if (!order) throw orderNotFound();
    if (!viewer.admin && order.email !== viewer.customerEmail) throw orderNotFound();

    const [items, events] = await Promise.all([
      this.orders.findItems(order.id),
      this.queries.findEvents(order.id),
    ]);
    const body = {
      ...renderOrder(order, items),
      timeline: events.map(viewer.admin ? adminEvent : publicEvent),
      // Opens GET /orders/{id}/events, the same as the token POST /orders/track returns.
      ...this.eventsTokens.issue(order.id),
    };
    return viewer.admin ? maskPii(body, viewer.admin.role) : body;
  }

  async listForCustomer(email: string, input: MyListInput) {
    const rows = await this.queries.listForEmail(email, input.statuses, input.cursor, input.limit + 1);
    const { items, nextCursor } = pageOf(rows, input.limit);
    const lines = items.length ? await this.queries.findItemsOf(items.map((row) => row.id)) : [];
    return {
      items: items.map((row) => ({
        ...renderListRow(row),
        items: lines
          .filter((line) => line.order_id === row.id)
          .map((line) => ({ sku: line.sku, name: line.name_snapshot, qty: line.qty })),
      })),
      next_cursor: nextCursor,
    };
  }

  async listForAdmin(admin: Admin, input: AdminListInput) {
    // A viewer sees emails masked, so finding orders by a full email would unmask who bought
    // what. They can still search by order id.
    if (input.filter.email !== null && !seesFullPii(admin.role)) {
      throw new ProblemError(403, 'EMAIL_SEARCH_FORBIDDEN', 'this role can search by order id only');
    }
    const rows = await this.queries.listForAdmin(input.filter, input.cursor, input.limit + 1);
    const { items, nextCursor } = pageOf(rows, input.limit);
    return {
      items: items.map((row) => maskPii(renderListRow(row), admin.role)),
      next_cursor: nextCursor,
    };
  }

  /** Spec 8.5: timeline, the webhooks for this order, every top-up attempt and the refunds. */
  async detailForAdmin(admin: Admin, id: string) {
    if (!isValidOrderId(id)) throw orderNotFound();
    const order = await this.orders.findOrderById(id);
    if (!order) throw orderNotFound();
    const [items, events, webhooks, attempts, refunds] = await Promise.all([
      this.orders.findItems(id),
      this.queries.findEvents(id),
      this.queries.findWebhooks(id),
      this.queries.findAttempts(id),
      this.queries.findRefunds(id),
    ]);
    const body = {
      ...renderOrder(order, items),
      timeline: events.map(adminEvent),
      webhooks: webhooks.map((row) => ({
        event_id: row.event_id,
        type: row.type,
        amount_satang: row.amount_satang === null ? null : toSatang(row.amount_satang),
        currency: row.currency,
        occurred_at: iso(row.occurred_at),
        received_at: row.received_at.toISOString(),
        processed_at: iso(row.processed_at),
        outcome: row.outcome,
      })),
      fulfillment_attempts: attempts.map((row) => ({
        id: row.id,
        reference: row.reference,
        attempt_no: row.attempt_no,
        status: row.status,
        http_status: row.http_status,
        error: row.error,
        started_at: row.started_at.toISOString(),
        finished_at: iso(row.finished_at),
      })),
      refunds: refunds.map((row) => ({
        id: row.id,
        amount_satang: toSatang(row.amount_satang),
        status: row.status,
        actor: row.actor,
        reason: row.reason,
        created_at: row.created_at.toISOString(),
        completed_at: iso(row.completed_at),
      })),
    };
    return maskPii(body, admin.role);
  }
}
