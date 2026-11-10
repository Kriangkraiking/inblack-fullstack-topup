import { Body, Controller, Get, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import { normalizeEmail } from '@inblack/domain';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { readTokenCookie, sessionCookieOptions } from '../common/cookies.js';
import { ProblemError } from '../common/problem.js';
import { parseWith, requireJson } from '../common/validate.js';
import { clientIp } from '../security/client-ip.js';
import { CUSTOMER_SESSION_COOKIE, SkipCsrf } from '../security/csrf.guard.js';
import {
  OTP_REQUEST_PER_EMAIL,
  OTP_REQUEST_PER_IP,
  OTP_VERIFY_PER_IP,
} from '../security/rate-limiter.js';
import { RateLimiterService } from '../security/rate-limiter.service.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { OTP_CODE_PATTERN } from './otp.js';

const emailSchema = z.string().transform(normalizeEmail).pipe(z.email().max(254));
const requestSchema = z.object({ email: emailSchema });
const verifySchema = z.object({ email: emailSchema, code: z.string().regex(OTP_CODE_PATTERN) });

export function readCustomerToken(cookieHeader: string | undefined): string | undefined {
  return readTokenCookie(cookieHeader, CUSTOMER_SESSION_COOKIE);
}

export function unauthenticated(): ProblemError {
  return new ProblemError(401, 'UNAUTHENTICATED', 'sign in with an email code to use this route');
}

@Controller('api/v1/auth')
export class CustomerAuthController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly limiter: RateLimiterService,
  ) {}

  /** 202 and the same body for every valid email, see CustomerAuthService.requestCode. */
  @Post('otp/request')
  @HttpCode(202)
  @SkipCsrf()
  async request(@Body() body: unknown, @Req() req: Request) {
    await this.limiter.consume(OTP_REQUEST_PER_IP, clientIp(req));
    const { email } = parseWith(requestSchema, body);
    await this.limiter.consume(OTP_REQUEST_PER_EMAIL, email);
    await this.auth.requestCode(email);
    return { detail: 'if this address can receive email, a sign-in code is on its way' };
  }

  @Post('otp/verify')
  @HttpCode(200)
  @SkipCsrf()
  async verify(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.limiter.consume(OTP_VERIFY_PER_IP, clientIp(req));
    requireJson(req.headers['content-type']);
    const input = parseWith(verifySchema, body);
    const { email, token } = await this.auth.verify(input.email, input.code);
    response.cookie(CUSTOMER_SESSION_COOKIE, token, {
      ...sessionCookieOptions(),
      maxAge: this.auth.ttlSeconds * 1000,
    });
    return { email };
  }

  /** Changes state with the session cookie, so CsrfGuard checks the Origin. */
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = readCustomerToken(cookie);
    if (token) await this.auth.logout(token);
    response.clearCookie(CUSTOMER_SESSION_COOKIE, sessionCookieOptions());
  }

  @Get('me')
  async me(@Headers('cookie') cookie: string | undefined) {
    const token = readCustomerToken(cookie);
    const email = token ? await this.auth.authenticate(token) : undefined;
    if (!email) throw unauthenticated();
    return { email };
  }
}
