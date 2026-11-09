import { Controller, Get, Injectable, OnApplicationShutdown, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Redis } from 'ioredis';
import { PROBLEM_CONTENT_TYPE, renderProblem } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import { MetricsService } from './metrics.service.js';
import { CHECK_TIMEOUT_MS, evaluate } from './readiness.js';

/** Its own Redis connection. With the offline queue off, a ping during an outage fails at once. */
@Injectable()
export class ReadinessService implements OnApplicationShutdown {
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: CHECK_TIMEOUT_MS,
    retryStrategy: () => 1000,
  });

  constructor(private readonly db: DbService) {
    this.redis.on('error', () => undefined); // The answer of /readyz is the report.
    this.redis.connect().catch(() => undefined);
  }

  check() {
    return evaluate({
      postgres: () => this.db.query('SELECT 1'),
      redis: () => this.redis.ping(),
    });
  }

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

@Controller()
export class HealthController {
  constructor(
    private readonly readiness: ReadinessService,
    private readonly metrics: MetricsService,
  ) {}

  /** 503 when Postgres or Redis cannot answer within a second, so a balancer can skip us. */
  @Get('readyz')
  async ready(@Res() res: Response) {
    const result = await this.readiness.check();
    res.setHeader('Cache-Control', 'no-store');
    if (result.ready) {
      res.status(200).json({ status: 'ready', checks: result.checks });
      return;
    }
    const failed = Object.keys(result.checks).filter((name) => result.checks[name] !== 'ok');
    res
      .status(503)
      .type(PROBLEM_CONTENT_TYPE)
      .send(renderProblem({ status: 503, code: 'NOT_READY', detail: `unavailable: ${failed.join(', ')}` }));
  }

  /** Not reachable through the proxy, see infra/nginx/nginx.conf. */
  @Get('metrics')
  async scrape(@Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain; version=0.0.4; charset=utf-8').send(await this.metrics.render());
  }
}
