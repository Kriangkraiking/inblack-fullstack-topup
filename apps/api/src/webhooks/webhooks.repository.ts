import { Injectable } from '@nestjs/common';
import type { Tx } from '../db/db.service.js';
import type { WebhookEvent } from './webhook-input.js';

/** All SQL for the webhook_events table. */
@Injectable()
export class WebhooksRepository {
  /**
   * The primary key is what makes a repeated event_id a no-op. A copy that arrives while the
   * first is still processing blocks here until that transaction ends: it then sees the
   * committed row, or it takes over if the first one rolled back.
   */
  async insertEvent(tx: Tx, event: WebhookEvent, rawBody: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO webhook_events (event_id, type, order_id, amount_satang, currency, occurred_at, raw_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.event_id,
        event.type,
        event.order_id,
        event.amount_satang,
        event.currency,
        event.occurred_at,
        rawBody,
      ],
    );
    return rowCount === 1;
  }

  async finishEvent(tx: Tx, eventId: string, outcome: string): Promise<void> {
    await tx.query(
      'UPDATE webhook_events SET processed_at = now(), outcome = $2 WHERE event_id = $1',
      [eventId, outcome],
    );
  }
}
