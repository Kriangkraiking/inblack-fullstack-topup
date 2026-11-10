import { Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { ORDER_STATUSES } from '@inblack/domain';
import request from 'supertest';
import { ProblemFilter } from '../common/problem.filter.js';
import { AdminAuthGuard, SESSION_COOKIE } from './admin-auth.guard.js';
import { AdminAuthService } from './admin-auth.service.js';
import type { Admin } from './admin-roles.js';
import { AdminStatsController } from './admin-stats.controller.js';
import { AdminStatsRepository } from './admin-stats.repository.js';
import { renderStats, toSafeInteger, type StatsRow } from './admin-stats.js';

const ROW: StatsRow = {
  orders_today: '12',
  revenue_today_satang: '221187',
  orders_last_minute: '1',
  orders_last_hour: '7',
  queue_depth: '3',
  dead_letters_open: '0',
};

describe('renderStats', () => {
  it('lists every status, 0 when absent, and ignores a status the domain does not know', () => {
    const stats = renderStats(ROW, [{ status: 'PAID', n: '4' }, { status: 'BOGUS', n: '9' }], new Date(0));
    expect(new Set(Object.keys(stats.by_status))).toEqual(new Set(ORDER_STATUSES));
    expect(Object.keys(stats.by_status)).toHaveLength(ORDER_STATUSES.length);
    expect(stats.by_status.PAID).toBe(4);
    expect(stats.by_status.COMPLETED).toBe(0);
    expect(stats.generated_at).toBe('1970-01-01T00:00:00.000Z');
  });

  it('turns every number into an exact integer, money in satang', () => {
    const stats = renderStats(ROW, [], new Date());
    expect(stats.revenue_today_satang).toBe(221187);
    for (const value of [
      stats.orders_today,
      stats.revenue_today_satang,
      stats.orders_last_minute,
      stats.orders_last_hour,
      stats.queue_depth,
      stats.dead_letters_open,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });

  it('allows negative revenue (refunds settled today on older orders) but no fractions or overflow', () => {
    expect(toSafeInteger('-5000', 'x')).toBe(-5000);
    expect(() => toSafeInteger('10.5', 'x')).toThrow();
    expect(() => toSafeInteger('9007199254740993', 'x')).toThrow();
  });
});

describe('GET /api/v1/admin/stats', () => {
  let app: INestApplication;
  let current: Admin | undefined;
  let reads = 0;
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const get = () => request(server()).get('/api/v1/admin/stats').set('Cookie', `${SESSION_COOKIE}=${'a'.repeat(43)}`);

  beforeAll(async () => {
    @Module({
      controllers: [AdminStatsController],
      providers: [
        { provide: AdminAuthService, useValue: { authenticate: () => Promise.resolve(current) } },
        {
          provide: AdminStatsRepository,
          useValue: {
            read: () => {
              reads += 1;
              return Promise.resolve({ row: ROW, byStatus: [{ status: 'COMPLETED', n: '8' }] });
            },
          },
        },
        { provide: APP_GUARD, useClass: AdminAuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    })
    class StatsModule {}
    app = await NestFactory.create(StatsModule, { logger: false });
    await app.init();
  });

  afterAll(() => app.close());

  it('401 problem+json without a session', async () => {
    current = undefined;
    const res = await request(server()).get('/api/v1/admin/stats');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it.each(['viewer', 'support', 'finance', 'superadmin'] as const)('answers %s with integer stats', async (role) => {
    current = { id: '1', email: `${role}@inblackm.test`, role };
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.body as Record<string, unknown> & { by_status: Record<string, number> };
    expect(body).toMatchObject({
      orders_today: 12,
      revenue_today_satang: 221187,
      orders_last_minute: 1,
      orders_last_hour: 7,
      queue_depth: 3,
      dead_letters_open: 0,
    });
    expect(body.by_status.COMPLETED).toBe(8);
    expect(Object.keys(body.by_status)).toHaveLength(ORDER_STATUSES.length);
    expect(typeof body.generated_at).toBe('string');
    // Apart from the timestamp, the raw JSON has no decimal point anywhere.
    expect(res.text.replace(/"generated_at":"[^"]*"/, '')).not.toMatch(/\d\.\d/);
  });

  it('serves repeated requests from the 5 second cache', () => {
    // The role test above made four requests within 5 seconds: one read.
    expect(reads).toBe(1);
  });
});
