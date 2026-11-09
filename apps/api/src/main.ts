import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { APP_OPTIONS } from './app-options.js';
import { JsonLogger } from './observability/json-logger.js';
import { requestObserver } from './observability/request-observer.middleware.js';

async function bootstrap() {
  const logger = new JsonLogger({ service: 'api', instance: process.env.INSTANCE_ID ?? 'unknown' });
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...APP_OPTIONS,
    logger,
  });
  app.disable('x-powered-by');
  // First, so the request id and the latency cover body parsing and every error answer too.
  app.use(requestObserver);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
