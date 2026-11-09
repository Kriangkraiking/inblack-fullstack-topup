import { Controller, Headers, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemError } from '../common/problem.js';
import { assertValidSignature, parseWebhookEvent } from './webhook-input.js';
import { WebhooksService } from './webhooks.service.js';

@Controller('api/v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('payment')
  @HttpCode(200)
  async payment(
    @Headers('x-ibm-signature') signature: string | undefined,
    @Req() request: RawBodyRequest<Request>,
  ) {
    // rawBody is only kept for a JSON body, and without the bytes nothing can be verified.
    if (!request.rawBody) {
      throw new ProblemError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send application/json');
    }
    const secret = process.env.PAYMENT_WEBHOOK_SECRET;
    if (!secret) throw new Error('PAYMENT_WEBHOOK_SECRET is required');

    assertValidSignature(signature, request.rawBody, secret, Math.floor(Date.now() / 1000));
    return this.webhooks.handle(parseWebhookEvent(request.body), request.rawBody.toString('utf8'));
  }
}
