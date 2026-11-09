import { Module } from '@nestjs/common';
import { ExpiryService } from './expiry.service.js';
import { HeartbeatService } from './heartbeat.service.js';
import { OrderEventRelayService } from './order-event-relay.service.js';
import { OutboxWorkerService } from './outbox-worker.service.js';

@Module({
  providers: [HeartbeatService, ExpiryService, OutboxWorkerService, OrderEventRelayService],
})
export class AppModule {}
