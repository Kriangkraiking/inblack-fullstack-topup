import { Controller, Get, Injectable, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PROBLEM_CONTENT_TYPE, renderProblem } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import { OrderSignalService } from '../realtime/order-signal.service.js';
import { MetricsService } from './metrics.service.js';
import { evaluate } from './readiness.js';

/**
 * Pings Redis on the stream signal connection rather than a connection of its own: while Redis
 * is gone every reconnecting client costs DNS lookups, see OrderSignalService. Not connected
 * means not ready, without waiting.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly db: DbService,
    private readonly signals: OrderSignalService,
  ) {}

  check() {
    return evaluate({
      postgres: () => this.db.query('SELECT 1'),
      redis: () => this.signals.ping(),
    });
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
