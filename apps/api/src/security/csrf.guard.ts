import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { readCookie } from '../common/cookies.js';
import { ProblemError } from '../common/problem.js';

/** The cookies that carry a session. A request with either of them is checked. */
export const ADMIN_SESSION_COOKIE = 'inblack_admin_session';
export const CUSTOMER_SESSION_COOKIE = 'inblack_session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:8080,http://localhost:3000';
export const SKIP_CSRF_KEY = 'inblack:skip-csrf';

/**
 * For routes that never read a session cookie: the payment webhook, POST /orders, /orders/track
 * and the OTP routes. A forged request there gains nothing a direct request would not.
 */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);

/** Exact origins (scheme, host and port), from CSRF_ALLOWED_ORIGINS, comma separated. */
export function allowedOrigins(raw = process.env.CSRF_ALLOWED_ORIGINS): ReadonlySet<string> {
  return new Set(
    (raw?.trim() ? raw : DEFAULT_ALLOWED_ORIGINS)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export interface CsrfInput {
  method: string;
  cookieHeader: string | undefined;
  origin: string | undefined;
}

/**
 * True when the request may go on. A request that changes something and carries a session
 * cookie must name an allowed Origin. A missing Origin is refused too: browsers send it on every
 * POST, so only a non-browser client leaves it out, and that client can add it (ADR 0005).
 */
export function passesCsrf({ method, cookieHeader, origin }: CsrfInput, allowed: ReadonlySet<string>) {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  const hasSession =
    readCookie(cookieHeader, ADMIN_SESSION_COOKIE) !== undefined ||
    readCookie(cookieHeader, CUSTOMER_SESSION_COOKIE) !== undefined;
  if (!hasSession) return true;
  return origin !== undefined && allowed.has(origin);
}

/** Registered globally, before the admin guard, so a forged request never reaches a handler. */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowed = allowedOrigins();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.headers.origin;
    const ok = passesCsrf(
      { method: request.method, cookieHeader: request.headers.cookie, origin },
      this.allowed,
    );
    if (!ok) {
      throw new ProblemError(403, 'CSRF_ORIGIN_MISMATCH', 'this request did not come from an allowed origin');
    }
    return true;
  }
}
