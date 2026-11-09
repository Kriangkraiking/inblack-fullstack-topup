import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
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
    AppController,
    CatalogController,
    OrdersController,
    TestResetController,
  ],
  providers: [
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
