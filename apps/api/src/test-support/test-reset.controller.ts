import { Controller, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { TestResetRepository } from './test-reset.repository.js';

/**
 * Wipes the database, so it answers 404 outside APP_ENV=test, the same as a route that
 * does not exist. It takes no input. The function it calls also exists only under
 * APP_ENV=test, see syncTestReset in db/src/migrate.ts.
 */
@Controller('api/v1/_test')
export class TestResetController {
  constructor(private readonly repository: TestResetRepository) {}

  @Post('reset')
  @HttpCode(200)
  async reset() {
    if (process.env.APP_ENV !== 'test') throw new NotFoundException();
    await this.repository.wipeAndSeed();
    return { status: 'reset' };
  }
}
