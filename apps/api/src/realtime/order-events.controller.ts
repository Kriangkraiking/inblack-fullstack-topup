import { Controller, Get, Headers, Logger, Param, Query, Res } from '@nestjs/common';
import { isValidOrderId } from '@inblack/domain';
import type { Response } from 'express';
import { orderNotFound } from '../orders/orders.service.js';
import { currentRequestId, runWithRequestId } from '../observability/request-context.js';
import { EventsTokenService } from './events-token.service.js';
import { OrderEventStream, parseLastEventId } from './order-event-stream.js';
import { OrderEventsRepository } from './order-events.repository.js';
import { OrderSignalService } from './order-signal.service.js';

export const TICK_MS = 1000;
/** With Redis up, a missed signal (relay restarting, say) is still picked up this often. */
export const SAFETY_POLL_MS = 5000;
export const HEARTBEAT_MS = 15_000;
const MAX_TIMER_MS = 2_147_483_647;

@Controller('api/v1/orders')
export class OrderEventsController {
  private readonly logger = new Logger(OrderEventsController.name);

  constructor(
    private readonly tokens: EventsTokenService,
    private readonly events: OrderEventsRepository,
    private readonly signals: OrderSignalService,
  ) {}

  /**
   * SSE. ?token= comes from POST /orders/track. A wrong, expired or foreign token, an id with a
   * bad checksum and an unknown order all get the same 404, so the stream cannot be used to probe.
   */
  @Get(':id/events')
  async stream(
    @Param('id') orderId: string,
    @Query('token') token: unknown,
    @Query('last_event_id') lastEventQuery: unknown,
    @Headers('last-event-id') lastEventHeader: unknown,
    @Res() res: Response,
  ) {
    if (!isValidOrderId(orderId)) throw orderNotFound();
    const expiresAt = this.tokens.verify(orderId, token);
    if (expiresAt === null) throw orderNotFound();
    const lastId = parseLastEventId(lastEventHeader, lastEventQuery);
    if (!(await this.events.orderExists(orderId))) throw orderNotFound();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx honours this per response, on top of proxy_buffering off for this location.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const requestId = currentRequestId() ?? 'sse';
    let closed = false;
    let lastError = 0;
    const write = (frame: string) => {
      if (!closed) res.write(frame);
    };
    const stream = new OrderEventStream(this.events, orderId, lastId, write, (error) => {
      if (Date.now() - lastError < 30_000) return;
      lastError = Date.now();
      runWithRequestId(requestId, () =>
        this.logger.warn(`event stream read failed, will retry: ${error instanceof Error ? error.message : String(error)}`),
      );
    });
    let lastRead = Date.now();
    const drain = () => {
      lastRead = Date.now();
      void stream.drain();
    };

    write('retry: 1000\n\n');
    // Subscribe before the first read: an event committed in between is then either in that
    // read or announced after it, and drain() reading from the last id sent removes the overlap.
    const unsubscribe = this.signals.subscribe(orderId, drain);
    drain();

    const tick = setInterval(() => {
      if (!this.signals.live || Date.now() - lastRead >= SAFETY_POLL_MS) drain();
    }, TICK_MS);
    const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
    const expiry = setTimeout(() => res.end(), Math.min((expiresAt - Date.now() / 1000) * 1000, MAX_TIMER_MS));

    const cleanup = () => {
      if (closed) return;
      closed = true;
      stream.close();
      clearInterval(tick);
      clearInterval(heartbeat);
      clearTimeout(expiry);
      unsubscribe();
    };
    // res, not req: on Node 22 a GET's request emits 'close' as soon as it has been read.
    res.on('close', cleanup);
  }
}
