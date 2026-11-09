import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProblemError } from '../common/problem.js';
import { AdminAuthService } from './admin-auth.service.js';
import {
  hasRole,
  MIN_ROLE_KEY,
  PUBLIC_ADMIN_KEY,
  type AdminRequest,
  type AdminRole,
} from './admin-roles.js';

export const SESSION_COOKIE = 'inblack_admin_session';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === SESSION_COOKIE) {
      const value = part.slice(separator + 1).trim();
      return TOKEN_PATTERN.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Registered globally and deny by default: every handler in a controller under api/v1/admin
 * needs a session and a @RequireRole, unless it is marked @PublicAdminRoute. It reads the path
 * the controller declares and not the request URL, because Express matches URLs regardless of
 * case and a check on the URL could be bypassed with /API/V1/ADMIN.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AdminAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const path = Reflect.getMetadata('path', context.getClass()) as string | undefined;
    if (!path?.replace(/^\//, '').startsWith('api/v1/admin')) return true;
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ADMIN_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = readSessionToken(request.headers.cookie);
    const admin = token ? await this.auth.authenticate(token) : undefined;
    if (!admin) throw new ProblemError(401, 'UNAUTHENTICATED', 'log in to use this route');

    const required = this.reflector.getAllAndOverride<AdminRole>(MIN_ROLE_KEY, targets);
    if (!required || !hasRole(admin.role, required)) {
      throw new ProblemError(403, 'FORBIDDEN', 'your role cannot use this route');
    }
    request.admin = admin;
    return true;
  }
}
