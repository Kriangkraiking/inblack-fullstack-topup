import { Injectable } from '@nestjs/common';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';

/** undefined_function and insufficient_privilege: migrate did not run with APP_ENV=test. */
const NOT_INSTALLED = new Set(['42883', '42501']);

@Injectable()
export class TestResetRepository {
  constructor(private readonly db: DbService) {}

  async wipeAndSeed(): Promise<void> {
    try {
      await this.db.query('SELECT test_reset_database()');
    } catch (error) {
      if (NOT_INSTALLED.has((error as { code?: string }).code ?? '')) {
        throw new ProblemError(503, 'TEST_RESET_NOT_CONFIGURED', 'run migrate with APP_ENV=test');
      }
      throw error;
    }
  }
}
