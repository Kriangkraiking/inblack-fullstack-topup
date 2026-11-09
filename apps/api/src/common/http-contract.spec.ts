import { Controller, Get, Post, Req, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import { APP_OPTIONS } from '../app-options.js';
import { OrderAccessGuard } from '../orders/order-access.guard.js';
import { TestResetController } from '../test-support/test-reset.controller.js';
import { TestResetRepository } from '../test-support/test-reset.repository.js';
import { ProblemError } from './problem.js';
import { ProblemFilter } from './problem.filter.js';

@Controller()
class ProbeController {
  @Post('raw')
  raw(@Req() req: RawBodyRequest<Request>) {
    return { raw: req.rawBody?.toString('utf8') };
  }

  @Get('problem')
  problem() {
    throw new ProblemError(409, 'OUT_OF_STOCK', 'not enough stock');
  }

  @Get('crash')
  crash() {
    throw new Error('secret connection string');
  }
}

@Module({
  controllers: [ProbeController, TestResetController],
  providers: [TestResetRepository, { provide: APP_FILTER, useClass: ProblemFilter }],
})
class ProbeModule {}

describe('HTTP contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { ...APP_OPTIONS, logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

  it('keeps the exact request bytes for webhooks', async () => {
    const raw = '{ "b":1,   "a":2 }';
    const response = await request(server())
      .post('/raw')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect((response.body as { raw: string }).raw).toBe(raw);
  });

  it('renders a thrown problem as RFC 9457', async () => {
    const response = await request(server()).get('/problem').expect(409);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(JSON.parse(response.text)).toEqual({
      type: 'urn:inblack:problem:OUT_OF_STOCK',
      title: 'Conflict',
      status: 409,
      code: 'OUT_OF_STOCK',
      detail: 'not enough stock',
    });
  });

  it('does not leak the message of an unexpected error', async () => {
    const response = await request(server()).get('/crash').expect(500);

    expect(response.text).not.toContain('secret');
    expect((JSON.parse(response.text) as { code: string }).code).toBe('INTERNAL_ERROR');
  });

  it('renders broken JSON as a problem', async () => {
    const response = await request(server())
      .post('/raw')
      .set('Content-Type', 'application/json')
      .send('{not json')
      .expect(400);

    expect(response.headers['content-type']).toContain('application/problem+json');
    // Not the JSON parser's own message.
    expect((JSON.parse(response.text) as { detail: string }).detail).toBe('Bad Request');
  });

  it.each(['development', 'production', ''])(
    'hides _test/reset as an unknown route when APP_ENV is "%s"',
    async (appEnv) => {
      vi.stubEnv('APP_ENV', appEnv);
      vi.stubEnv('TEST_ADMIN_DATABASE_URL', 'postgresql://must-not-be-used');

      const reset = await request(server()).post('/api/v1/_test/reset').expect(404);
      const unknown = await request(server()).post('/api/v1/_test/other').expect(404);

      expect(reset.text).toBe(unknown.text);
    },
  );

  it('tells the operator when the reset connection is missing', async () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('TEST_ADMIN_DATABASE_URL', '');

    const response = await request(server()).post('/api/v1/_test/reset').expect(503);

    expect((JSON.parse(response.text) as { code: string }).code).toBe('TEST_RESET_NOT_CONFIGURED');
  });
});

describe('OrderAccessGuard', () => {
  it('turns every request away with 404 until auth exists', () => {
    expect(() => new OrderAccessGuard().canActivate()).toThrow(
      expect.objectContaining({ status: 404, code: 'ORDER_NOT_FOUND' }) as Error,
    );
  });
});
