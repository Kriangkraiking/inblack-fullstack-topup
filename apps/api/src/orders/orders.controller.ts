import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PROBLEM_CONTENT_TYPE } from '../common/problem.js';
import { SessionReader } from '../customer-auth/session-reader.service.js';
import { EventsTokenService } from '../realtime/events-token.service.js';
import { clientIp } from '../security/client-ip.js';
import { SkipCsrf } from '../security/csrf.guard.js';
import { TRACK_PER_IP, TRACK_PER_ORDER } from '../security/rate-limiter.js';
import { RateLimiterService } from '../security/rate-limiter.service.js';
import { parseIdempotencyKey, parseTrackInput } from './order-input.js';
import { OrderQueryService } from './order-query.service.js';
import { OrdersService } from './orders.service.js';

@Controller('api/v1/orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly eventsTokens: EventsTokenService,
    private readonly limiter: RateLimiterService,
    private readonly sessions: SessionReader,
    private readonly queries: OrderQueryService,
  ) {}

  // The service validates the body, because a bad body under a used key has its own answer.
  // Sends the stored string as is. Going through Nest's serialiser could change the bytes.
  @Post()
  @SkipCsrf()
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    const key = parseIdempotencyKey(idempotencyKey);
    const { status, body: stored } = await this.orders.create(key, body);
    response
      .status(status)
      .type(status < 400 ? 'application/json' : PROBLEM_CONTENT_TYPE)
      .send(stored);
  }

  /**
   * Spec 8.4: 10 a minute per IP, counted before anything else, and 5 a minute per order id.
   * An unknown order and a wrong email give the same 404 from the same single query.
   */
  @Post('track')
  @HttpCode(200)
  @SkipCsrf()
  async track(@Body() body: unknown, @Req() req: Request) {
    await this.limiter.consume(TRACK_PER_IP, clientIp(req));
    const input = parseTrackInput(body);
    await this.limiter.consume(TRACK_PER_ORDER, input.orderId);
    const order = await this.orders.track(input);
    // Opens GET /orders/{id}/events without the email, which must not go into a URL.
    return { ...order, ...this.eventsTokens.issue(order.order_id) };
  }

  /** The owner (customer session with the order's email) or any admin; everyone else 404. */
  @Get(':id')
  async get(@Param('id') id: string, @Headers('cookie') cookie: string | undefined) {
    return this.queries.getForViewer(id, await this.sessions.viewer(cookie));
  }
}
