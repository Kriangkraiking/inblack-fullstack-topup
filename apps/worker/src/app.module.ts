import { Module } from '@nestjs/common';
import { ExpiryService } from './expiry.service.js';
import { HeartbeatService } from './heartbeat.service.js';

@Module({
  providers: [HeartbeatService, ExpiryService],
})
export class AppModule {}
