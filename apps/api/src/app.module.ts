import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdminAuthController } from './admin/admin-auth.controller.js';
import { AdminAuthGuard } from './admin/admin-auth.guard.js';
import { AdminAuthRepository } from './admin/admin-auth.repository.js';
import { AdminAuthService } from './admin/admin-auth.service.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogRepository } from './catalog/catalog.repository.js';
import { CatalogService } from './catalog/catalog.service.js';
import { ProblemFilter } from './common/problem.filter.js';
import { DbModule } from './db/db.module.js';
import { instanceHeader } from './instance-header.middleware.js';
import { OrderAccessGuard } from './orders/order-access.guard.js';
import { OrdersController } from './orders/orders.controller.js';
import { OrdersRepository } from './orders/orders.repository.js';
import { OrdersService } from './orders/orders.service.js';
import { TestResetController } from './test-support/test-reset.controller.js';
import { TestResetRepository } from './test-support/test-reset.repository.js';

@Module({
  imports: [DbModule],
  controllers: [
    AdminAuthController,
    AppController,
    CatalogController,
    OrdersController,
    TestResetController,
  ],
  providers: [
    AdminAuthRepository,
    AdminAuthService,
    { provide: APP_GUARD, useClass: AdminAuthGuard },
    AppService,
    CatalogRepository,
    CatalogService,
    OrdersRepository,
    OrdersService,
    OrderAccessGuard,
    TestResetRepository,
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(instanceHeader).forRoutes('{*splat}');
  }
}
