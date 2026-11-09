import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import pg from 'pg';
import { runFulfillment, runRefund, type HandlerDeps } from './job-handlers.js';
import { loadOutboxConfig } from './outbox-config.js';
import {
  claimNextJob,
  FencedError,
  FULFILLMENT_TOPIC,
  requeueOrphans,
  type Job,
} from './outbox.repository.js';
import { runWithRequestId } from './observability/request-context.js';
import { createGameClient, createPayClient } from './provider-clients.js';

const OUTBOX_CHANNEL = 'inblack:outbox';
const POOL_SIZE = 10;
const SHUTDOWN_WAIT_MS = 8000;

/**
 * Runs jobs from the outbox table. Postgres decides what is due: Redis only makes the worker look
 * sooner, and polling goes on without it. No connection is held during an HTTP call.
 */
@Injectable()
export class OutboxWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private readonly config = loadOutboxConfig();
  private readonly pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: POOL_SIZE,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  private readonly deps: HandlerDeps = {
    pool: this.pool,
    game: createGameClient(
      process.env.MOCK_GAME_URL ?? 'http://mock-game:4020',
      this.config.getTimeoutMs,
      this.config.postTimeoutMs,
    ),
    pay: createPayClient(process.env.MOCK_PAY_URL ?? 'http://mock-pay:4010', this.config.postTimeoutMs),
    config: this.config,
  };
  private subscriber?: Redis;
  private pollTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private running = 0;
  private claiming = false;
  private stopping = false;

  constructor() {
    // Without a listener, an idle connection dropped by Postgres would crash the process.
    this.pool.on('error', (error) => this.logger.error(error.message));
  }

  onApplicationBootstrap() {
    this.pollTimer = setInterval(() => void this.claimJobs(), this.config.pollMs);
    this.sweepTimer = setInterval(() => void this.sweep(), this.config.sweepMs);
    this.listenForSignals();
    void this.sweep();
    void this.claimJobs();
  }

  private listenForSignals(): void {
    const url = process.env.REDIS_URL;
    if (!url) return;
    this.subscriber = new Redis(url, { lazyConnect: true, retryStrategy: () => 5000 });
    this.subscriber.on('error', () => undefined); // Polling covers it, see the class comment.
    this.subscriber.on('message', () => void this.claimJobs());
    this.subscriber.connect().catch(() => undefined);
    this.subscriber.subscribe(OUTBOX_CHANNEL).catch(() => undefined);
  }

  /** Never throws: a database outage just means the next tick tries again. */
  async claimJobs(): Promise<void> {
    if (this.claiming) return;
    this.claiming = true;
    try {
      while (!this.stopping && this.running < this.config.concurrency) {
        const job = await claimNextJob(this.pool, this.config.leaseMs);
        if (!job) break;
        this.running += 1;
        void this.run(job).finally(() => {
          this.running -= 1;
          void this.claimJobs();
        });
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.claiming = false;
    }
  }

  /** A failure here leaves the lease to run out, and the job is then claimed again. */
  private run(job: Job): Promise<void> {
    // Logs and calls to mock-game carry the id of the request that queued the job (the webhook).
    const requestId = typeof job.payload.request_id === 'string' ? job.payload.request_id : `job-${job.id}`;
    return runWithRequestId(requestId, () => this.runInContext(job));
  }

  private async runInContext(job: Job): Promise<void> {
    this.logger.log({ msg: 'job claimed', job_id: job.id, topic: job.topic, order_id: job.aggregateId, attempt: job.attempts });
    try {
      if (job.topic === FULFILLMENT_TOPIC) await runFulfillment(this.deps, job);
      else await runRefund(this.deps, job);
    } catch (error) {
      if (error instanceof FencedError) return;
      this.logger.error(
        `job ${job.id} (${job.topic}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async sweep(): Promise<void> {
    try {
      const requeued = await requeueOrphans(this.pool);
      if (requeued > 0) this.logger.error(`requeued ${requeued} order(s) that had no open job`);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    }
  }

  /** Stops claiming and gives running jobs a moment. A kill is safe too: the lease covers it. */
  async onApplicationShutdown() {
    this.stopping = true;
    clearInterval(this.pollTimer);
    clearInterval(this.sweepTimer);
    this.subscriber?.disconnect();
    const deadline = Date.now() + SHUTDOWN_WAIT_MS;
    while (this.running > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.pool.end();
  }
}
