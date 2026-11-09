import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

const HEARTBEAT_INTERVAL_MS = 30_000;

// The worker has no jobs yet, so this timer is what keeps the process running.
@Injectable()
export class HeartbeatService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(HeartbeatService.name);
  private timer?: NodeJS.Timeout;

  onApplicationBootstrap() {
    this.logger.log('Worker started');
    this.timer = setInterval(
      () => this.logger.log('Worker alive'),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }
}
