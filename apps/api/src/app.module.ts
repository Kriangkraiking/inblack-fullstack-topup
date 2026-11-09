import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { ProblemFilter } from './common/problem.filter.js';
import { DbModule } from './db/db.module.js';
import { instanceHeader } from './instance-header.middleware.js';

@Module({
  imports: [DbModule],
  controllers: [AppController, CatalogController],
  providers: [AppService, { provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(instanceHeader).forRoutes('{*splat}');
  }
}
