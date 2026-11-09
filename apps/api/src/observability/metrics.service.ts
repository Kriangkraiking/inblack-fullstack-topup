import { Injectable, Logger } from '@nestjs/common';
import { ORDER_STATUSES } from '@inblack/domain';
import { renderGauge } from './metrics.js';
import { MetricsRepository, type BusinessCounts } from './metrics.repository.js';
import { httpRequestDuration } from './request-observer.middleware.js';

const CACHE_MS = 5000;
const KNOWN_TOPICS = ['fulfillment.requested', 'refund.requested'];

/** The known topics are always present, at 0 when empty, so an alert never sees a gap. */
function queueSamples(rows: { topic: string; n: number }[]) {
  const by = new Map(KNOWN_TOPICS.map((topic) => [topic, 0]));
  for (const row of rows) by.set(row.topic, row.n);
  return [...by].map(([topic, value]) => ({ labels: { topic }, value }));
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private cached?: { at: number; counts: BusinessCounts };

  constructor(private readonly repo: MetricsRepository) {}

  /** Reads Postgres at most every 5 seconds, so a scrape storm cannot load the database. */
  private async counts(): Promise<BusinessCounts | undefined> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.counts;
    try {
      const counts = await this.repo.counts();
      this.cached = { at: Date.now(), counts };
      return counts;
    } catch (error) {
      this.logger.warn(`metrics could not read Postgres: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async render(): Promise<string> {
    const counts = await this.counts();
    const parts = [httpRequestDuration.render()];
    parts.push(renderGauge('inblack_metrics_db_up', '1 when the business gauges below could be read from Postgres', [{ value: counts ? 1 : 0 }]));
    if (counts) {
      const byStatus = new Map(counts.ordersByStatus.map((r) => [r.status, r.n]));
      parts.push(
        renderGauge('inblack_orders', 'Orders by status (whole system, from Postgres)', ORDER_STATUSES.map((status) => ({ labels: { status }, value: byStatus.get(status) ?? 0 }))),
        renderGauge('inblack_queue_depth', 'Outbox jobs not yet processed, by topic (whole system)', queueSamples(counts.queueByTopic)),
        renderGauge('inblack_fulfillment_retries', 'Game top-up attempts after the first one (whole system)', [{ value: counts.fulfillmentRetries }]),
        renderGauge('inblack_outbox_job_retries', 'Outbox job runs after the first one, all topics (whole system)', [{ value: counts.outboxRetries }]),
        renderGauge('inblack_dead_letters', 'Dead-letter jobs (whole system)', [
          { labels: { state: 'open' }, value: counts.deadLettersOpen },
          { labels: { state: 'all' }, value: counts.deadLettersTotal },
        ]),
      );
    }
    return `${parts.join('\n')}\n`;
  }
}
