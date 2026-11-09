import { CanActivate, Injectable } from '@nestjs/common';
import { orderNotFound } from './orders.service.js';

/**
 * Where the owner-or-admin check for GET /api/v1/orders/{id} goes (spec 8.1).
 * There is no session yet, so nobody can be the owner and every request gets 404.
 * 404 rather than 403 so the answer does not confirm that the order exists (spec 8.4).
 * When auth arrives, return true for the owner or an admin and keep this 404 for others.
 */
@Injectable()
export class OrderAccessGuard implements CanActivate {
  canActivate(): boolean {
    throw orderNotFound();
  }
}
