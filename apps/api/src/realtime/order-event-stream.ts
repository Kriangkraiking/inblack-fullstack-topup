import { ProblemError } from '../common/problem.js';
import type { OrderEventSource, PublicOrderEvent } from './order-events.repository.js';

const BATCH = 200;
const EVENT_ID_PATTERN = /^\d{1,18}$/;

/** One SSE frame. order_events.id is the SSE id, so a reconnect says exactly where it stopped. */
export function formatEvent(event: PublicOrderEvent): string {
  return `id: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * The header wins: EventSource sends it by itself on a reconnect. The query parameter is for a
 * page that opens a new EventSource after a reload, which cannot set headers. Absent means 0.
 */
export function parseLastEventId(header: unknown, query: unknown): string {
  const value = typeof header === 'string' && header !== '' ? header : query;
  if (value === undefined || value === '') return '0';
  if (typeof value !== 'string' || !EVENT_ID_PATTERN.test(value)) {
    throw new ProblemError(422, 'INVALID_LAST_EVENT_ID', 'Last-Event-ID must be an event id from this stream');
  }
  return BigInt(value).toString();
}

/**
 * Sends every event after `lastId` exactly once, in id order. Any trigger (a Redis message, a
 * poll tick, Redis coming back) just calls drain(): it always re-reads Postgres from the last id
 * sent, so a lost or duplicated signal cannot lose or repeat an event. Calls never overlap; one
 * that arrives during a read makes the read run again.
 */
export class OrderEventStream {
  private draining = false;
  private again = false;
  private closed = false;

  constructor(
    private readonly source: OrderEventSource,
    private readonly orderId: string,
    private lastId: string,
    private readonly write: (frame: string) => void,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  get lastEventId(): string {
    return this.lastId;
  }

  close(): void {
    this.closed = true;
  }

  async drain(): Promise<void> {
    if (this.closed) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.again = false;
        for (;;) {
          const batch = await this.source.eventsAfter(this.orderId, this.lastId, BATCH);
          for (const event of batch) {
            if (this.closed) return;
            if (BigInt(event.event_id) <= BigInt(this.lastId)) continue;
            this.write(formatEvent(event));
            this.lastId = event.event_id;
          }
          if (batch.length < BATCH) break;
        }
      } while (this.again && !this.closed);
    } catch (error) {
      // The next trigger reads again from the same id, so nothing is lost.
      this.onError(error);
    } finally {
      this.draining = false;
    }
  }
}
