import { Injectable } from '@nestjs/common';
import { ProblemError } from '../common/problem.js';

const TIMEOUT_MS = 5000;

/**
 * Empties mock-pay as part of POST /api/v1/_test/reset, so its settlement file starts empty
 * along with the database. mock-pay serves this route only when it also runs with APP_ENV=test.
 */
@Injectable()
export class MockPayResetClient {
  async reset(): Promise<void> {
    const base = process.env.MOCK_PAY_URL ?? 'http://mock-pay:4010';
    let status: number;
    try {
      const response = await fetch(new URL('/_test/reset', base), {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.arrayBuffer();
      status = response.status;
    } catch {
      throw new ProblemError(503, 'TEST_RESET_PROVIDER_UNAVAILABLE', 'mock-pay did not answer the reset');
    }
    if (status === 404) {
      throw new ProblemError(503, 'TEST_RESET_NOT_CONFIGURED', 'run mock-pay with APP_ENV=test');
    }
    if (status !== 200) {
      throw new ProblemError(503, 'TEST_RESET_PROVIDER_UNAVAILABLE', `mock-pay answered ${status}`);
    }
  }
}
