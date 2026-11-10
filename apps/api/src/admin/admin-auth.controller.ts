import { Body, Controller, Get, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import { normalizeEmail } from '@inblack/domain';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { sessionCookieOptions } from '../common/cookies.js';
import { parseWith, requireJson } from '../common/validate.js';
import { clientIp } from '../security/client-ip.js';
import { ADMIN_LOGIN_PER_IP } from '../security/rate-limiter.js';
import { RateLimiterService } from '../security/rate-limiter.service.js';
import { readSessionToken, SESSION_COOKIE } from './admin-auth.guard.js';
import { AdminAuthService } from './admin-auth.service.js';
import { CurrentAdmin, PublicAdminRoute, RequireRole, type Admin } from './admin-roles.js';

const loginSchema = z.object({
  email: z.string().transform(normalizeEmail).pipe(z.email().max(254)),
  // scrypt takes any length, so this bounds how much work one request can ask for.
  password: z.string().min(1).max(256),
});

const renderAdmin = (admin: Admin) => ({ email: admin.email, role: admin.role });

@Controller('api/v1/admin/auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @PublicAdminRoute()
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    // Before parsing, so malformed requests use up the allowance too. Redis, fail open; the
    // per-email limit in AdminAuthService is in Postgres and does not fail open (ADR 0005).
    await this.limiter.consume(ADMIN_LOGIN_PER_IP, clientIp(request));
    requireJson(request.headers['content-type']);
    const input = parseWith(loginSchema, body);
    const { admin, token } = await this.auth.login(input.email, input.password);
    response.cookie(SESSION_COOKIE, token, {
      ...sessionCookieOptions(),
      maxAge: this.auth.ttlSeconds * 1000,
    });
    return renderAdmin(admin);
  }

  @Post('logout')
  @HttpCode(204)
  @PublicAdminRoute()
  async logout(
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = readSessionToken(cookie);
    if (token) await this.auth.logout(token);
    response.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  }

  @Get('me')
  @RequireRole('viewer')
  me(@CurrentAdmin() admin: Admin) {
    return renderAdmin(admin);
  }
}
