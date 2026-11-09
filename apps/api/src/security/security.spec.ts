import { Controller, Get, Module, Post, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import request from 'supertest';
import { ProblemError } from '../common/problem.js';
import { ProblemFilter } from '../common/problem.filter.js';
import { clientIp } from './client-ip.js';
import {
  ADMIN_SESSION_COOKIE,
  allowedOrigins,
  CsrfGuard,
  CUSTOMER_SESSION_COOKIE,
  passesCsrf,
  SkipCsrf,
} from './csrf.guard.js';
import { maskEmail, maskGameUid, maskPii } from './pii-mask.js';
import { MemoryRateStore, RateLimiter, TRACK_PER_IP, TRACK_PER_ORDER, type RateStore } from './rate-limiter.js';

describe('RateLimiter', () => {
  const retryAfterOf = async (promise: Promise<void>) => {
    try {
      await promise;
      return 'allowed';
    } catch (error) {
      const problem = error as ProblemError;
      return `${problem.status} ${problem.code} retry ${problem.headers['Retry-After']}`;
    }
  };

  it('allows 10 track calls a minute per IP, then 429 with Retry-After', async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(new MemoryRateStore(() => now));
    for (let i = 0; i < 10; i += 1) await limiter.consume(TRACK_PER_IP, '10.0.0.1');
    now += 20_000;
    expect(await retryAfterOf(limiter.consume(TRACK_PER_IP, '10.0.0.1'))).toBe('429 RATE_LIMITED retry 40');
    // Another IP has its own counter.
    expect(await retryAfterOf(limiter.consume(TRACK_PER_IP, '10.0.0.2'))).toBe('allowed');
    now += 40_000;
    expect(await retryAfterOf(limiter.consume(TRACK_PER_IP, '10.0.0.1'))).toBe('allowed');
  });

  it('allows 5 a minute per order id', async () => {
    const limiter = new RateLimiter(new MemoryRateStore(() => 0));
    const answers = [];
    for (let i = 0; i < 6; i += 1) answers.push(await retryAfterOf(limiter.consume(TRACK_PER_ORDER, 'ORD-2587965432159-229')));
    expect(answers).toEqual([...Array(5).fill('allowed'), '429 RATE_LIMITED retry 60']);
  });

  it('never puts the subject in the key, and keeps rules apart', async () => {
    const keys: string[] = [];
    const store: RateStore = { hit: (key) => (keys.push(key), Promise.resolve({ count: 1, ttlMs: 1000 })) };
    const limiter = new RateLimiter(store);
    await limiter.consume(TRACK_PER_IP, 'buyer@example.com');
    await limiter.consume(TRACK_PER_ORDER, 'buyer@example.com');
    expect(keys[0]).not.toContain('buyer');
    expect(keys[0]).toMatch(/^rl:track-ip:[0-9a-f]{32}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('lets the request through when the store is down (fail open)', async () => {
    const errors: unknown[] = [];
    const limiter = new RateLimiter({ hit: () => Promise.reject(new Error('redis down')) }, (e) => errors.push(e));
    await expect(limiter.consume(TRACK_PER_IP, '10.0.0.1')).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: '172.18.0.9' } }) as never;

  it('reads X-Real-IP, which nginx overwrites', () => {
    expect(clientIp(req({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('ignores X-Forwarded-For and junk, falling back to the socket', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }))).toBe('172.18.0.9');
    expect(clientIp(req({ 'x-real-ip': 'evil, 1.2.3.4' }))).toBe('172.18.0.9');
  });
});

describe('passesCsrf', () => {
  const allowed = allowedOrigins('http://localhost:8080, http://localhost:3000');
  const admin = `${ADMIN_SESSION_COOKIE}=x`;
  const customer = `a=1; ${CUSTOMER_SESSION_COOKIE}=x`;

  it.each([
    ['GET with a cookie and a foreign origin', 'GET', admin, 'https://evil.example', true],
    ['POST without a session cookie', 'POST', 'theme=dark', 'https://evil.example', true],
    ['POST with admin cookie from the web app', 'POST', admin, 'http://localhost:3000', true],
    ['POST with customer cookie through the proxy', 'POST', customer, 'http://localhost:8080', true],
    ['POST with admin cookie from a foreign origin', 'POST', admin, 'https://evil.example', false],
    ['POST with customer cookie from a foreign origin', 'POST', customer, 'http://localhost:3001', false],
    ['POST with a cookie and no Origin', 'POST', admin, undefined, false],
    ['POST with a cookie and Origin null', 'POST', customer, 'null', false],
    ['DELETE with a cookie from a foreign origin', 'DELETE', admin, 'https://evil.example', false],
  ] as const)('%s: %s', (_name, method, cookieHeader, origin, expected) => {
    expect(passesCsrf({ method, cookieHeader, origin }, allowed)).toBe(expected);
  });

  it('falls back to the compose origins when the env is empty', () => {
    expect([...allowedOrigins('')]).toEqual(['http://localhost:8080', 'http://localhost:3000']);
  });
});

@Controller('csrf-probe')
class CsrfProbeController {
  @Post('change')
  change() {
    return { changed: true };
  }

  @Post('open')
  @SkipCsrf()
  open() {
    return { changed: true };
  }

  @Get('read')
  read() {
    return { read: true };
  }
}

@Module({
  controllers: [CsrfProbeController],
  providers: [
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
class CsrfProbeModule {}

describe('CsrfGuard', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const cookie = `${CUSTOMER_SESSION_COOKIE}=${'a'.repeat(43)}`;

  beforeAll(async () => {
    app = await NestFactory.create(CsrfProbeModule, { logger: false });
    await app.init();
  });
  afterAll(() => app.close());

  it('refuses a cookie POST from a foreign origin with 403 problem+json', async () => {
    const response = await request(server())
      .post('/csrf-probe/change')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .expect(403);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect((JSON.parse(response.text) as { code: string }).code).toBe('CSRF_ORIGIN_MISMATCH');
  });

  it('lets an allowed origin, a GET and a @SkipCsrf route through', async () => {
    await request(server()).post('/csrf-probe/change').set('Cookie', cookie).set('Origin', 'http://localhost:3000').expect(201);
    await request(server()).get('/csrf-probe/read').set('Cookie', cookie).set('Origin', 'https://evil.example').expect(200);
    await request(server()).post('/csrf-probe/open').set('Cookie', cookie).set('Origin', 'https://evil.example').expect(201);
  });
});

describe('PII masking', () => {
  const row = { email: 'buyer@example.com', game_uid: 'player_01', total_satang: 100 };

  it('masks email and Game UID for viewer only', () => {
    expect(maskPii(row, 'viewer')).toEqual({ email: 'b***@example.com', game_uid: 'pl****01', total_satang: 100 });
    for (const role of ['support', 'finance', 'superadmin'] as const) expect(maskPii(row, role)).toBe(row);
  });

  it('keeps short values unreadable too', () => {
    expect(maskGameUid('abcd')).toBe('a***');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
    expect(maskEmail('broken')).toBe('***');
  });
});
