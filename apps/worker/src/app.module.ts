import { Module } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service.js';

@Module({
  providers: [HeartbeatService],
})
export class AppModule {}
