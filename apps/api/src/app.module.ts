import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdminAuthController } from './admin/admin-auth.controller.js';
import { AdminAuthGuard } from './admin/admin-auth.guard.js';
import { AdminAuthRepository } from './admin/admin-auth.repository.js';
import { AdminAuthService } from './admin/admin-auth.service.js';
import { AuditLogsController } from './admin/audit-logs.controller.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogRepository } from './catalog/catalog.repository.js';
import { CatalogService } from './catalog/catalog.service.js';
import { ProblemFilter } from './common/problem.filter.js';
import { DbModule } from './db/db.module.js';
import { OutboxSignalService } from './db/outbox-signal.service.js';
import { instanceHeader } from './instance-header.middleware.js';
import { HealthController, ReadinessService } from './observability/health.controller.js';
import { MetricsRepository } from './observability/metrics.repository.js';
import { MetricsService } from './observability/metrics.service.js';
import { EventsTokenService } from './realtime/events-token.service.js';
import { OrderEventsController } from './realtime/order-events.controller.js';
import { OrderEventsRepository } from './realtime/order-events.repository.js';
import { OrderSignalService } from './realtime/order-signal.service.js';
import { OrderAccessGuard } from './orders/order-access.guard.js';
import { OrderOpsRepository } from './orders/order-ops.repository.js';
import { OrdersController } from './orders/orders.controller.js';
import { OrdersRepository } from './orders/orders.repository.js';
import { OrdersService } from './orders/orders.service.js';
import { ReconciliationController } from './reconciliation/reconciliation.controller.js';
import { ReconciliationRepository } from './reconciliation/reconciliation.repository.js';
import { AdminOrdersController } from './refunds/admin-orders.controller.js';
import { RefundsService } from './refunds/refunds.service.js';
import { MockPayResetClient } from './test-support/mock-pay-reset.client.js';
import { TestResetController } from './test-support/test-reset.controller.js';
import { TestResetRepository } from './test-support/test-reset.repository.js';
import { WebhooksController } from './webhooks/webhooks.controller.js';
import { WebhooksRepository } from './webhooks/webhooks.repository.js';
import { WebhooksService } from './webhooks/webhooks.service.js';

@Module({
  imports: [DbModule],
  controllers: [
    AdminAuthController,
    AdminOrdersController,
    AppController,
    AuditLogsController,
    CatalogController,
    HealthController,
    OrderEventsController,
    OrdersController,
    ReconciliationController,
    TestResetController,
    WebhooksController,
  ],
  providers: [
    AdminAuthRepository,
    AdminAuthService,
    { provide: APP_GUARD, useClass: AdminAuthGuard },
    AppService,
    CatalogRepository,
    CatalogService,
    EventsTokenService,
    MetricsRepository,
    MetricsService,
    MockPayResetClient,
    OrderOpsRepository,
    OrdersRepository,
    OrdersService,
    OrderAccessGuard,
    OrderEventsRepository,
    OrderSignalService,
    OutboxSignalService,
    ReadinessService,
    ReconciliationRepository,
    RefundsService,
    TestResetRepository,
    WebhooksRepository,
    WebhooksService,
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(instanceHeader).forRoutes('{*splat}');
  }
}
