import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

/** Each role has the rights of the ones before it (spec section 4). */
export const ADMIN_ROLES = ['viewer', 'support', 'finance', 'superadmin'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface Admin {
  id: string;
  email: string;
  role: AdminRole;
}

export type AdminRequest = Request & { admin?: Admin };

export const MIN_ROLE_KEY = 'inblack:min-admin-role';
export const PUBLIC_ADMIN_KEY = 'inblack:public-admin-route';

/** A route under api/v1/admin without this answers 403 to everyone. See AdminAuthGuard. */
export const RequireRole = (role: AdminRole) => SetMetadata(MIN_ROLE_KEY, role);
export const PublicAdminRoute = () => SetMetadata(PUBLIC_ADMIN_KEY, true);

export function hasRole(actual: AdminRole, required: AdminRole): boolean {
  return ADMIN_ROLES.indexOf(actual) >= ADMIN_ROLES.indexOf(required);
}

export const CurrentAdmin = createParamDecorator(
  (_: unknown, context: ExecutionContext): Admin => {
    const admin = context.switchToHttp().getRequest<AdminRequest>().admin;
    if (!admin) throw new Error('CurrentAdmin used on a route without an admin session');
    return admin;
  },
);

/** order_events holds this rather than the email, because viewers read the timeline. */
export function adminActor(admin: Admin): string {
  return `admin:${admin.id}`;
}
