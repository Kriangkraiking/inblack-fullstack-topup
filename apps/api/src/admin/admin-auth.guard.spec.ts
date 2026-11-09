import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import request from 'supertest';
import { ProblemFilter } from '../common/problem.filter.js';
import { AdminAuthGuard, readSessionToken, SESSION_COOKIE } from './admin-auth.guard.js';
import { AdminAuthService } from './admin-auth.service.js';
import { PublicAdminRoute, RequireRole, type Admin } from './admin-roles.js';
import { verifyPassword } from './password.js';

const TOKEN = 'a'.repeat(43);
let current: Admin | undefined;

@Controller('api/v1/admin/probe')
class AdminProbeController {
  @Get('no-role')
  noRole() {
    return { reached: true };
  }

  @Get('finance')
  @RequireRole('finance')
  finance() {
    return { reached: true };
  }

  @Get('public')
  @PublicAdminRoute()
  open() {
    return { reached: true };
  }
}

@Controller('api/v1/public-probe')
class PublicProbeController {
  @Get()
  get() {
    return { reached: true };
  }
}

@Module({
  controllers: [AdminProbeController, PublicProbeController],
  providers: [
    { provide: AdminAuthService, useValue: { authenticate: () => Promise.resolve(current) } },
    { provide: APP_GUARD, useClass: AdminAuthGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
class ProbeModule {}

describe('AdminAuthGuard', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const asRole = (role: Admin['role']) => {
    current = { id: '1', email: `${role}@inblackm.test`, role };
  };
  const cookie = `${SESSION_COOKIE}=${TOKEN}`;

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    current = undefined;
  });

  it('answers 401 with no session', async () => {
    const response = await request(server()).get('/api/v1/admin/probe/finance').expect(401);
    expect((JSON.parse(response.text) as { code: string }).code).toBe('UNAUTHENTICATED');
  });

  it('cannot be avoided by changing the case of the URL', async () => {
    await request(server()).get('/API/V1/ADMIN/PROBE/FINANCE').expect(401);
  });

  it('denies a route that forgot to declare a role, even for superadmin', async () => {
    asRole('superadmin');
    await request(server()).get('/api/v1/admin/probe/no-role').set('Cookie', cookie).expect(403);
  });

  it.each([
    ['viewer', 403],
    ['support', 403],
    ['finance', 200],
    ['superadmin', 200],
  ] as const)('with a finance route, %s gets %d', async (role, status) => {
    asRole(role);
    await request(server()).get('/api/v1/admin/probe/finance').set('Cookie', cookie).expect(status);
  });

  it('lets through a route marked public, and routes outside admin', async () => {
    await request(server()).get('/api/v1/admin/probe/public').expect(200);
    await request(server()).get('/api/v1/public-probe').expect(200);
  });
});

describe('readSessionToken', () => {
  it('finds the token among other cookies', () => {
    expect(readSessionToken(`a=1; ${SESSION_COOKIE}=${TOKEN}; b=2`)).toBe(TOKEN);
  });

  it.each([undefined, '', 'a=1', `${SESSION_COOKIE}=short`, `${SESSION_COOKIE}=${'%'.repeat(43)}`])(
    'ignores %s',
    (header) => {
      expect(readSessionToken(header)).toBeUndefined();
    },
  );
});

describe('verifyPassword', () => {
  // The viewer account from db/seed/seed.sql, password in docs/SEED_CREDENTIALS.md.
  const stored =
    'scrypt$16384$8$1$xjiHPOO/t+WLzHItvqpTYg==$LjJ/8Yd76SMxK0dIqGOm77kLrQUiI/H2fsvYMFdWvpU=';

  it('accepts the right password and refuses a wrong one', async () => {
    await expect(verifyPassword('Viewer-Test-2026', stored)).resolves.toBe(true);
    await expect(verifyPassword('viewer-test-2026', stored)).resolves.toBe(false);
  });

  it.each(['', 'plain', 'scrypt$x$8$1$aa$bb', 'bcrypt$1$2$3$aa$bb'])('refuses the stored value %s', async (bad) => {
    await expect(verifyPassword('x', bad)).resolves.toBe(false);
  });
});
