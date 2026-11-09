import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Controller, HttpCode, NotFoundException, Post } from '@nestjs/common';
import pg from 'pg';
import { ProblemError } from '../common/problem.js';

// Keeps the migration record and the state machine table, which seeding does not restore.
const TABLES_TO_KEEP = ['schema_migrations', 'order_status_transitions'];

/**
 * Wipes the database, so it answers 404 outside APP_ENV=test, the same as a route that
 * does not exist. inblack_app cannot truncate or get past the append-only triggers, so
 * this opens its own short-lived owner connection. That URL is only read after the check.
 */
@Controller('api/v1/_test')
export class TestResetController {
  @Post('reset')
  @HttpCode(200)
  async reset() {
    if (process.env.APP_ENV !== 'test') throw new NotFoundException();

    const connectionString = process.env.TEST_ADMIN_DATABASE_URL;
    if (!connectionString) {
      throw new ProblemError(
        503,
        'TEST_RESET_NOT_CONFIGURED',
        'set TEST_ADMIN_DATABASE_URL to use this endpoint',
      );
    }
    const seed = await readFile(
      process.env.SEED_FILE ?? join(process.cwd(), 'seed', 'seed.sql'),
      'utf8',
    );

    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      const { rows } = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND NOT (tablename = ANY($1))`,
        [TABLES_TO_KEEP],
      );
      const tables = rows.map((row) => client.escapeIdentifier(row.tablename)).join(', ');
      await client.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
      await client.query(seed);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
    return { status: 'reset' };
  }
}
