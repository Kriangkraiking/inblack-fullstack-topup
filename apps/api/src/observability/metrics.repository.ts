import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

export interface BusinessCounts {
  ordersByStatus: { status: string; n: number }[];
  queueByTopic: { topic: string; n: number }[];
  fulfillmentRetries: number;
  outboxRetries: number;
  deadLettersOpen: number;
  deadLettersTotal: number;
}

/** Whole-system numbers from Postgres, the same on every replica. */
@Injectable()
export class MetricsRepository {
  constructor(private readonly db: DbService) {}

  async counts(): Promise<BusinessCounts> {
    const [orders, queue, totals] = await Promise.all([
      this.db.query<{ status: string; n: number }>(
        'SELECT status, count(*)::int AS n FROM orders GROUP BY status',
      ),
      this.db.query<{ topic: string; n: number }>(
        'SELECT topic, count(*)::int AS n FROM outbox WHERE processed_at IS NULL GROUP BY topic',
      ),
      this.db.query<{ fr: number; orr: number; dlo: number; dlt: number }>(
        `SELECT
           (SELECT count(*) FROM fulfillment_attempts WHERE attempt_no > 1)::int AS fr,
           (SELECT coalesce(sum(greatest(attempts - 1, 0)), 0) FROM outbox)::int AS orr,
           (SELECT count(*) FROM dead_letters WHERE resolved_at IS NULL)::int AS dlo,
           (SELECT count(*) FROM dead_letters)::int AS dlt`,
      ),
    ]);
    const t = totals.rows[0];
    return {
      ordersByStatus: orders.rows,
      queueByTopic: queue.rows,
      fulfillmentRetries: t.fr,
      outboxRetries: t.orr,
      deadLettersOpen: t.dlo,
      deadLettersTotal: t.dlt,
    };
  }
}
