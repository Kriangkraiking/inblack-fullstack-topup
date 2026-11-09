import { Controller, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { MockPayResetClient } from './mock-pay-reset.client.js';
import { TestResetRepository } from './test-reset.repository.js';

/**
 * Wipes the database, so it answers 404 outside APP_ENV=test, the same as a route that
 * does not exist. It takes no input. The function it calls also exists only under
 * APP_ENV=test, see syncTestReset in db/src/migrate.ts. mock-pay is emptied first, so no
 * webhook it still had queued arrives in the fresh database, and its settlement file is empty.
 */
@Controller('api/v1/_test')
export class TestResetController {
  constructor(
    private readonly repository: TestResetRepository,
    private readonly mockPay: MockPayResetClient,
  ) {}

  @Post('reset')
  @HttpCode(200)
  async reset() {
    if (process.env.APP_ENV !== 'test') throw new NotFoundException();
    await this.mockPay.reset();
    await this.repository.wipeAndSeed();
    return { status: 'reset' };
  }
}
