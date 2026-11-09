import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { ProblemFilter } from './common/problem.filter.js';
import { DbModule } from './db/db.module.js';
import { instanceHeader } from './instance-header.middleware.js';
import { OrderAccessGuard } from './orders/order-access.guard.js';
import { OrdersController } from './orders/orders.controller.js';
import { OrdersService } from './orders/orders.service.js';

@Module({
  imports: [DbModule],
  controllers: [
    AppController,
    CatalogController,
    OrdersController,
  ],
  providers: [
    AppService,
    OrdersService,
    OrderAccessGuard,
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(instanceHeader).forRoutes('{*splat}');
  }
}
