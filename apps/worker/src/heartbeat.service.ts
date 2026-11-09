import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

const HEARTBEAT_INTERVAL_MS = 30_000;

// The compose healthcheck reads this file's mtime, so keep the two in sync.
export const HEARTBEAT_FILE = join(tmpdir(), 'worker-heartbeat');

// The worker has no jobs yet, so this timer is what keeps the process running.
@Injectable()
export class HeartbeatService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(HeartbeatService.name);
  private timer?: NodeJS.Timeout;

  onApplicationBootstrap() {
    this.logger.log('Worker started');
    this.touch();
    this.timer = setInterval(() => {
      this.logger.log('Worker alive');
      this.touch();
    }, HEARTBEAT_INTERVAL_MS);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  private touch() {
    writeFileSync(HEARTBEAT_FILE, new Date().toISOString());
  }
}
