import { Injectable } from '@nestjs/common';
import { toSatang } from '@inblack/domain';
import { DbService } from '../db/db.service.js';
import type {
  PendingRefund,
  SystemEvent,
  SystemOrder,
  SystemSnapshot,
} from './compare-settlement.js';

/** All SQL for reconciliation. Reads only. */
@Injectable()
export class ReconciliationRepository {
  constructor(private readonly db: DbService) {}

  /**
   * One statement, so both sides come from one snapshot. A refund can be settled from the answer
   * to POST /refunds before its webhook arrives, so settled refunds are read as well.
   */
  async loadSnapshot(): Promise<SystemSnapshot> {
    const { rows } = await this.db.query<{
      event_id: string;
      type: string;
      order_id: string;
      amount_satang: string;
      occurred_at: Date;
      outcome: string | null;
      settled_refund: boolean;
      order_exists: boolean;
      status: string | null;
      paid_satang: string | null;
    }>(
      `WITH events AS (
         SELECT e.event_id, e.type, e.order_id, e.amount_satang, e.occurred_at, e.outcome,
                EXISTS (SELECT 1 FROM refunds r WHERE r.provider_event_id = e.event_id) AS settled_refund
         FROM webhook_events e
         WHERE e.type IN ('payment.succeeded', 'payment.refunded')
         UNION ALL
         SELECT r.provider_event_id, 'payment.refunded', r.order_id, r.amount_satang,
                r.completed_at, NULL, true
         FROM refunds r
         WHERE r.provider_event_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM webhook_events e WHERE e.event_id = r.provider_event_id)
       )
       SELECT e.*, o.id IS NOT NULL AS order_exists, o.status, o.paid_satang
       FROM events e LEFT JOIN orders o ON o.id = e.order_id`,
    );

    const events: SystemEvent[] = [];
    const orders = new Map<string, SystemOrder>();
    for (const row of rows) {
      events.push({
        eventId: row.event_id,
        type: row.type,
        orderId: row.order_id,
        amountSatang: toSatang(row.amount_satang),
        occurredAt: row.occurred_at,
        outcome: row.outcome,
        settledRefund: row.settled_refund,
      });
      if (row.order_exists && row.status !== null && row.paid_satang !== null) {
        orders.set(row.order_id, {
          id: row.order_id,
          status: row.status,
          paidSatang: toSatang(row.paid_satang),
        });
      }
    }
    return { events, orders, pendingRefunds: await this.loadPendingRefunds() };
  }

  private async loadPendingRefunds(): Promise<PendingRefund[]> {
    const { rows } = await this.db.query<{
      refund_ref: string;
      order_id: string;
      amount_satang: string;
      created_at: Date;
      has_open_job: boolean;
    }>(
      `SELECT r.refund_ref, r.order_id, r.amount_satang, r.created_at,
              EXISTS (SELECT 1 FROM outbox j
                      WHERE j.topic = 'refund.requested' AND j.processed_at IS NULL
                        AND j.payload->>'refund_id' = r.id::text) AS has_open_job
       FROM refunds r WHERE r.status = 'PENDING' ORDER BY r.id`,
    );
    return rows.map((row) => ({
      refundRef: row.refund_ref,
      orderId: row.order_id,
      amountSatang: toSatang(row.amount_satang),
      createdAt: row.created_at,
      hasOpenJob: row.has_open_job,
    }));
  }
}
