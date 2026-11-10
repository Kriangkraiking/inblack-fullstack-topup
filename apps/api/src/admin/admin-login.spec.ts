import { Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import request from 'supertest';
import { ProblemFilter } from '../common/problem.filter.js';
import { MemoryRateStore, RateLimiter, type RateStore } from '../security/rate-limiter.js';
import { RateLimiterService } from '../security/rate-limiter.service.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthRepository } from './admin-auth.repository.js';
import { AdminAuthService } from './admin-auth.service.js';
import {
  ADMIN_LOGIN_MAX_ATTEMPTS,
  ADMIN_LOGIN_WINDOW_SECONDS,
  decideLoginAttempt,
  loginEmailKey,
} from './login-limit.js';

// The viewer account from db/seed/seed.sql, password in docs/SEED_CREDENTIALS.md.
const VIEWER = {
  id: '1',
  email: 'viewer@inblackm.test',
  role: 'viewer' as const,
  password_hash:
    'scrypt$16384$8$1$xjiHPOO/t+WLzHItvqpTYg==$LjJ/8Yd76SMxK0dIqGOm77kLrQUiI/H2fsvYMFdWvpU=',
};
const PASSWORD = 'Viewer-Test-2026';

/** What admin_login_attempt does in Postgres: a fixed window per key, counted before the check. */
class FakeAuthRepository {
  attempts = new Map<string, number>();
  lookups = 0;
  sessions = 0;

  registerLoginAttempt(key: string, windowSeconds: number) {
    const attempts = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempts);
    return Promise.resolve({ attempts, retryAfterSeconds: windowSeconds - 10 });
  }

  clearLoginAttempts(key: string) {
    this.attempts.delete(key);
    return Promise.resolve();
  }

  findActiveByEmail(email: string) {
    this.lookups += 1;
    return Promise.resolve(email === VIEWER.email ? VIEWER : undefined);
  }

  createSession() {
    this.sessions += 1;
    return Promise.resolve();
  }
}

describe('decideLoginAttempt', () => {
  it('checks the password up to the limit and locks after it', () => {
    expect(decideLoginAttempt({ attempts: 1, retryAfterSeconds: 900 }).kind).toBe('check-password');
    expect(decideLoginAttempt({ attempts: ADMIN_LOGIN_MAX_ATTEMPTS, retryAfterSeconds: 900 }).kind).toBe(
      'check-password',
    );
    expect(decideLoginAttempt({ attempts: ADMIN_LOGIN_MAX_ATTEMPTS + 1, retryAfterSeconds: 800 })).toEqual({
      kind: 'locked',
      retryAfterSeconds: 800,
    });
  });

  it('never sends Retry-After 0', () => {
    expect(decideLoginAttempt({ attempts: 99, retryAfterSeconds: 0 })).toEqual({
      kind: 'locked',
      retryAfterSeconds: 1,
    });
  });

  it('keys by the normalised email and stores no plain address', () => {
    const key = loginEmailKey('viewer@inblackm.test');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('viewer');
    expect(loginEmailKey('other@inblackm.test')).not.toBe(key);
  });
});

describe('POST /api/v1/admin/auth/login limits', () => {
  let app: INestApplication;
  let repository: FakeAuthRepository;
  let store: RateStore;
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const login = (email: string, password: string, ip = '203.0.113.1') =>
    request(server()).post('/api/v1/admin/auth/login').set('X-Real-IP', ip).send({ email, password });

  beforeEach(async () => {
    repository = new FakeAuthRepository();
    store = new MemoryRateStore();
    @Module({
      controllers: [AdminAuthController],
      providers: [
        AdminAuthService,
        { provide: AdminAuthRepository, useValue: repository },
        { provide: RateLimiterService, useValue: new RateLimiter(store) },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    })
    class LoginModule {}
    app = await NestFactory.create(LoginModule, { logger: false });
    await app.init();
  });

  afterEach(() => app.close());

  it('answers an unknown email and a wrong password with the same bytes', async () => {
    const unknown = await login('nobody@inblackm.test', 'wrong-password', '203.0.113.2');
    const wrong = await login(VIEWER.email, 'wrong-password', '203.0.113.3');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.text).toBe(wrong.text);
  });

  it('locks an email after 5 attempts, before the password is checked, even the right one', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < ADMIN_LOGIN_MAX_ATTEMPTS; i += 1) {
      statuses.push((await login(VIEWER.email, 'wrong-password', `198.51.100.${i}`)).status);
    }
    const lookupsBefore = repository.lookups;
    const locked = await login(VIEWER.email, PASSWORD, '198.51.100.99');
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    expect(locked.status).toBe(429);
    expect(locked.headers['content-type']).toContain('application/problem+json');
    expect(locked.headers['retry-after']).toBe(String(ADMIN_LOGIN_WINDOW_SECONDS - 10));
    expect((JSON.parse(locked.text) as { code: string }).code).toBe('LOGIN_LOCKED');
    // The lock answered without reading the admin or running scrypt.
    expect(repository.lookups).toBe(lookupsBefore);
    expect(repository.sessions).toBe(0);
  });

  it('locks an unknown email exactly like a real one', async () => {
    for (let i = 0; i < ADMIN_LOGIN_MAX_ATTEMPTS; i += 1) await login('nobody@inblackm.test', 'x', `198.51.100.${i}`);
    for (let i = 0; i < ADMIN_LOGIN_MAX_ATTEMPTS; i += 1) await login(VIEWER.email, 'x', `192.0.2.${i}`);
    const unknown = await login('nobody@inblackm.test', 'x', '198.51.100.200');
    const real = await login(VIEWER.email, 'x', '192.0.2.200');
    expect(unknown.status).toBe(429);
    expect(real.status).toBe(429);
    expect(unknown.text).toBe(real.text);
  });

  it('a successful login clears the count', async () => {
    await login(VIEWER.email, 'wrong-password', '198.51.100.1');
    const ok = await login(VIEWER.email, PASSWORD, '198.51.100.2');
    expect(ok.status).toBe(200);
    expect(repository.attempts.has(loginEmailKey(VIEWER.email))).toBe(false);
  });

  it('allows 10 attempts a minute from one IP, then 429 with Retry-After before anything else', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) statuses.push((await login(`spray${i}@inblackm.test`, 'x')).status);
    const eleventh = await login('spray-last@inblackm.test', 'x');
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect(eleventh.status).toBe(429);
    expect((JSON.parse(eleventh.text) as { code: string }).code).toBe('RATE_LIMITED');
    expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
    // The eleventh never reached the per-email counter.
    expect(repository.attempts.has(loginEmailKey('spray-last@inblackm.test'))).toBe(false);
  });

  it('refuses a body that is not JSON with 415, so a cross-site form cannot sign anyone in', async () => {
    const form = await request(server())
      .post('/api/v1/admin/auth/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`email=${VIEWER.email}&password=${PASSWORD}`);
    expect(form.status).toBe(415);
    expect((JSON.parse(form.text) as { code: string }).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(repository.sessions).toBe(0);
  });
});
