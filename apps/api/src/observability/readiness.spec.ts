import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { HealthController, ReadinessService } from './health.controller.js';
import { MetricsService } from './metrics.service.js';
import { evaluate } from './readiness.js';

describe('evaluate', () => {
  it('is ready when every check resolves', async () => {
    const result = await evaluate({ postgres: async () => 1, redis: async () => 'PONG' });
    expect(result).toEqual({ ready: true, checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('is not ready when one check rejects or throws', async () => {
    const result = await evaluate({
      postgres: async () => {
        throw new Error('ECONNREFUSED');
      },
      redis: () => {
        throw new Error('sync throw');
      },
    });
    expect(result).toEqual({ ready: false, checks: { postgres: 'fail', redis: 'fail' } });
  });

  it('gives up on a check that hangs, within the timeout', async () => {
    const started = Date.now();
    const result = await evaluate({ postgres: () => new Promise(() => undefined), redis: async () => 'PONG' }, 100);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ ready: false, checks: { postgres: 'fail', redis: 'ok' } });
  });
});

describe('GET /readyz', () => {
  let app: INestApplication;
  const readiness = { check: vi.fn() };

  @Module({
    controllers: [HealthController],
    providers: [
      { provide: ReadinessService, useValue: readiness },
      { provide: MetricsService, useValue: { render: async () => '' } },
    ],
  })
  class ProbeModule {}

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 when Postgres and Redis are up', async () => {
    readiness.check.mockResolvedValue({ ready: true, checks: { postgres: 'ok', redis: 'ok' } });
    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it.each([
    [{ postgres: 'fail', redis: 'ok' }, 'unavailable: postgres'],
    [{ postgres: 'ok', redis: 'fail' }, 'unavailable: redis'],
  ])('answers 503 problem+json when a dependency is down (%j)', async (checks, detail) => {
    readiness.check.mockResolvedValue({ ready: false, checks });
    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(JSON.parse(res.text)).toMatchObject({ status: 503, code: 'NOT_READY', detail });
  });
});
