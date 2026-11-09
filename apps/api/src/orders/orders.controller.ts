import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { PROBLEM_CONTENT_TYPE } from '../common/problem.js';
import { OrderAccessGuard } from './order-access.guard.js';
import { parseIdempotencyKey } from './order-input.js';
import { OrdersService } from './orders.service.js';

@Controller('api/v1/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // Sends the stored string as is. Going through Nest's serialiser could change the bytes.
  @Post()
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

  @Post('track')
  @HttpCode(200)
  track(@Body() body: unknown) {
    return this.orders.track(body);
  }

  @Get(':id')
  @UseGuards(OrderAccessGuard)
  get(@Param('id') id: string) {
    return this.orders.getById(id);
  }
}
