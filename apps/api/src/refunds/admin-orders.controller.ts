import { Body, Controller, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import { isValidOrderId } from '@inblack/domain';
import type { Response } from 'express';
import { CurrentAdmin, RequireRole, type Admin } from '../admin/admin-roles.js';
import { PROBLEM_CONTENT_TYPE } from '../common/problem.js';
import { parseIdempotencyKey } from '../orders/order-input.js';
import { orderNotFound } from '../orders/orders.service.js';
import { RefundsService } from './refunds.service.js';

@Controller('api/v1/admin/orders')
export class AdminOrdersController {
  constructor(private readonly refunds: RefundsService) {}

  // Sends the stored string as is, so a replay matches the first answer byte for byte.
  @Post(':id/refund')
  @RequireRole('finance')
  async refund(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @CurrentAdmin() admin: Admin,
    @Res() response: Response,
  ) {
    if (!isValidOrderId(id)) throw orderNotFound();
    const key = parseIdempotencyKey(idempotencyKey);
    const { status, body: stored } = await this.refunds.refund(id, key, body, admin);
    response
      .status(status)
      .type(status < 400 ? 'application/json' : PROBLEM_CONTENT_TYPE)
      .send(stored);
  }

  @Post(':id/retry-fulfillment')
  @HttpCode(202)
  @RequireRole('support')
  retry(@Param('id') id: string, @Body() body: unknown, @CurrentAdmin() admin: Admin) {
    if (!isValidOrderId(id)) throw orderNotFound();
    return this.refunds.retryFulfillment(id, body, admin);
  }
}
