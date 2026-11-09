import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { CurrentAdmin, RequireRole, type Admin } from '../admin/admin-roles.js';
import { SessionReader } from '../customer-auth/session-reader.service.js';
import { parseAdminListQuery, parseMyListQuery } from './order-query-input.js';
import { OrderQueryService } from './order-query.service.js';

/** GET /api/v1/me/orders: the signed-in customer's orders, newest first. */
@Controller('api/v1/me/orders')
export class MyOrdersController {
  constructor(
    private readonly sessions: SessionReader,
    private readonly queries: OrderQueryService,
  ) {}

  @Get()
  async list(@Headers('cookie') cookie: string | undefined, @Query() query: unknown) {
    const email = await this.sessions.requireCustomer(cookie);
    return this.queries.listForCustomer(email, parseMyListQuery(query));
  }
}

/** Read side of the admin order pages. Viewers see email and Game UID masked. */
@Controller('api/v1/admin/orders')
export class AdminOrderQueryController {
  constructor(private readonly queries: OrderQueryService) {}

  @Get()
  @RequireRole('viewer')
  list(@CurrentAdmin() admin: Admin, @Query() query: unknown) {
    return this.queries.listForAdmin(admin, parseAdminListQuery(query));
  }

  @Get(':id')
  @RequireRole('viewer')
  detail(@CurrentAdmin() admin: Admin, @Param('id') id: string) {
    return this.queries.detailForAdmin(admin, id);
  }
}
