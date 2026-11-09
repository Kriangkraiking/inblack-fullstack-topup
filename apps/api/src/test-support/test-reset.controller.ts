import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Controller, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { ProblemError } from '../common/problem.js';
import { TestResetRepository } from './test-reset.repository.js';

/**
 * Wipes the database, so it answers 404 outside APP_ENV=test, the same as a route that
 * does not exist. The owner connection URL is only read after that check. It takes no input.
 */
@Controller('api/v1/_test')
export class TestResetController {
  constructor(private readonly repository: TestResetRepository) {}

  @Post('reset')
  @HttpCode(200)
  async reset() {
    if (process.env.APP_ENV !== 'test') throw new NotFoundException();

    const connectionString = process.env.TEST_ADMIN_DATABASE_URL;
    if (!connectionString) {
      throw new ProblemError(503, 'TEST_RESET_NOT_CONFIGURED', 'test reset is not configured');
    }
    const seedSql = await readFile(
      process.env.SEED_FILE ?? join(process.cwd(), 'seed', 'seed.sql'),
      'utf8',
    );
    await this.repository.wipeAndSeed(connectionString, seedSql);
    return { status: 'reset' };
  }
}
