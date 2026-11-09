import { Module } from '@nestjs/common';
import { ExpiryService } from './expiry.service.js';
import { HeartbeatService } from './heartbeat.service.js';
import { OutboxWorkerService } from './outbox-worker.service.js';

@Module({
  providers: [HeartbeatService, ExpiryService, OutboxWorkerService],
})
export class AppModule {}
