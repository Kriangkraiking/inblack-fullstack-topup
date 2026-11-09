import { Body, Controller, Get, Headers, HttpCode, Post, Res } from '@nestjs/common';
import { normalizeEmail } from '@inblack/domain';
import type { Response } from 'express';
import { z } from 'zod';
import { sessionCookieOptions } from '../common/cookies.js';
import { parseWith } from '../common/validate.js';
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
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @PublicAdminRoute()
  async login(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
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
