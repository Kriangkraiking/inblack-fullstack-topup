import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';

/** A connection inside an open transaction. */
export type Tx = pg.PoolClient;

const DEFAULT_POOL_SIZE = 20;
const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 15_000;

@Injectable()
export class DbService implements OnApplicationShutdown {
  private readonly logger = new Logger(DbService.name);
  private readonly pool: pg.Pool;

  constructor() {
    // Connects on first use, so a database outage cannot stop /healthz from answering.
    this.pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_SIZE ?? DEFAULT_POOL_SIZE),
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: STATEMENT_TIMEOUT_MS,
    });
    // Without a listener, an idle connection dropped by Postgres would crash the process.
    this.pool.on('error', (error) => this.logger.error(error.message));
  }

  query<Row extends pg.QueryResultRow>(sql: string, params?: unknown[]) {
    return this.pool.query<Row>(sql, params);
  }

  /** Commits if `work` resolves and rolls back if it throws. */
  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let failure: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // The connection state is unknown, so it must not go back into the pool.
        failure = rollbackError as Error;
      }
      throw error;
    } finally {
      client.release(failure);
    }
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
