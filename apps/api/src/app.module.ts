import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdminAuthController } from './admin/admin-auth.controller.js';
import { AdminAuthGuard } from './admin/admin-auth.guard.js';
import { AdminAuthRepository } from './admin/admin-auth.repository.js';
import { AdminAuthService } from './admin/admin-auth.service.js';
import { AuditLogsController } from './admin/audit-logs.controller.js';
import { CustomerAuthController } from './customer-auth/customer-auth.controller.js';
import { CustomerAuthRepository } from './customer-auth/customer-auth.repository.js';
import { CustomerAuthService, MAILER } from './customer-auth/customer-auth.service.js';
import { SessionReader } from './customer-auth/session-reader.service.js';
import { SmtpMailer } from './customer-auth/smtp-mailer.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AdminProductsController } from './catalog/admin-products.controller.js';
import { AdminProductsRepository } from './catalog/admin-products.repository.js';
import { AdminProductsService } from './catalog/admin-products.service.js';
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
import { OrderOpsRepository } from './orders/order-ops.repository.js';
import { AdminOrderQueryController, MyOrdersController } from './orders/order-query.controller.js';
import { OrderQueryRepository } from './orders/order-query.repository.js';
import { OrderQueryService } from './orders/order-query.service.js';
import { OrdersController } from './orders/orders.controller.js';
import { OrdersRepository } from './orders/orders.repository.js';
import { OrdersService } from './orders/orders.service.js';
import { ReconciliationController } from './reconciliation/reconciliation.controller.js';
import { ReconciliationRepository } from './reconciliation/reconciliation.repository.js';
import { AdminOrdersController } from './refunds/admin-orders.controller.js';
import { RefundsService } from './refunds/refunds.service.js';
import { CsrfGuard } from './security/csrf.guard.js';
import { RateLimiterService } from './security/rate-limiter.service.js';
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
    AdminOrderQueryController,
    AdminOrdersController,
    AdminProductsController,
    AppController,
    AuditLogsController,
    CatalogController,
    CustomerAuthController,
    HealthController,
    MyOrdersController,
    OrderEventsController,
    OrdersController,
    ReconciliationController,
    TestResetController,
    WebhooksController,
  ],
  providers: [
    AdminAuthRepository,
    AdminAuthService,
    AdminProductsRepository,
    AdminProductsService,
    // Guards run in this order: a forged cross-site request is refused before any session lookup.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AdminAuthGuard },
    AppService,
    CatalogRepository,
    CatalogService,
    CustomerAuthRepository,
    CustomerAuthService,
    { provide: MAILER, useFactory: () => new SmtpMailer() },
    EventsTokenService,
    MetricsRepository,
    MetricsService,
    MockPayResetClient,
    OrderOpsRepository,
    OrderQueryRepository,
    OrderQueryService,
    OrdersRepository,
    OrdersService,
    OrderEventsRepository,
    OrderSignalService,
    OutboxSignalService,
    RateLimiterService,
    ReadinessService,
    ReconciliationRepository,
    RefundsService,
    SessionReader,
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
