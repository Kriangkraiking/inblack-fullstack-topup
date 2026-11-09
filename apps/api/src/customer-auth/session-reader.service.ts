import { Injectable } from '@nestjs/common';
import { readSessionToken } from '../admin/admin-auth.guard.js';
import { AdminAuthService } from '../admin/admin-auth.service.js';
import type { Viewer } from '../orders/order-query.service.js';
import { readCustomerToken, unauthenticated } from './customer-auth.controller.js';
import { CustomerAuthService } from './customer-auth.service.js';

/** Turns the session cookies of a request into who is asking, for routes open to both kinds. */
@Injectable()
export class SessionReader {
  constructor(
    private readonly admins: AdminAuthService,
    private readonly customers: CustomerAuthService,
  ) {}

  async viewer(cookieHeader: string | undefined): Promise<Viewer> {
    const adminToken = readSessionToken(cookieHeader);
    const customerToken = readCustomerToken(cookieHeader);
    const [admin, customerEmail] = await Promise.all([
      adminToken ? this.admins.authenticate(adminToken) : undefined,
      customerToken ? this.customers.authenticate(customerToken) : undefined,
    ]);
    return { admin, customerEmail };
  }

  async requireCustomer(cookieHeader: string | undefined): Promise<string> {
    const token = readCustomerToken(cookieHeader);
    const email = token ? await this.customers.authenticate(token) : undefined;
    if (!email) throw unauthenticated();
    return email;
  }
}
