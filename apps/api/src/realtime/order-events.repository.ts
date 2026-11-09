import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

/** What a customer may see of one order_events row: no actor, reason, email or game UID. */
export interface PublicOrderEvent {
  event_id: string;
  status: string;
  from_status: string | null;
  event_type: string;
  occurred_at: string;
}

export interface OrderEventSource {
  /** Events with id greater than `afterId`, oldest first. */
  eventsAfter(orderId: string, afterId: string, limit: number): Promise<PublicOrderEvent[]>;
}

@Injectable()
export class OrderEventsRepository implements OrderEventSource {
  constructor(private readonly db: DbService) {}

  async orderExists(orderId: string): Promise<boolean> {
    const { rowCount } = await this.db.query('SELECT 1 FROM orders WHERE id = $1', [orderId]);
    return rowCount === 1;
  }

  /**
   * Ids of one order commit in id order (each insert holds the order row's lock, see
   * 0002_orders.sql), so reading "id > last" again later cannot skip an event.
   */
  async eventsAfter(orderId: string, afterId: string, limit: number): Promise<PublicOrderEvent[]> {
    const { rows } = await this.db.query<{
      id: string;
      to_status: string;
      from_status: string | null;
      event_type: string;
      created_at: Date;
    }>(
      // ORDER BY the bigint column, not the text alias: as text, '10' sorts before '9'.
      `SELECT e.id::text AS id, e.to_status, e.from_status, e.event_type, e.created_at
       FROM order_events e
       WHERE e.order_id = $1 AND e.id > $2::bigint
       ORDER BY e.id
       LIMIT $3`,
      [orderId, afterId, limit],
    );
    return rows.map((row) => ({
      event_id: row.id,
      status: row.to_status,
      from_status: row.from_status,
      event_type: row.event_type,
      occurred_at: row.created_at.toISOString(),
    }));
  }
}
