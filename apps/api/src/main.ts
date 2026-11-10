import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { APP_OPTIONS, configureHttp } from './app-options.js';
import { JsonLogger } from './observability/json-logger.js';
import { requestObserver } from './observability/request-observer.middleware.js';
import { allowedOrigins } from './security/csrf.guard.js';

async function bootstrap() {
  const logger = new JsonLogger({ service: 'api', instance: process.env.INSTANCE_ID ?? 'unknown' });
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...APP_OPTIONS,
    logger,
  });
  configureHttp(app);
  // First, so the request id and the latency cover body parsing and every error answer too.
  app.use(requestObserver);
  // The web app on :3000 calls the API on :8080 with credentials. Same list as the CSRF check,
  // so an origin that may read answers is exactly one that may send cookie requests.
  const origins = allowedOrigins();
  app.enableCors({
    origin: (origin, done) => done(null, origin !== undefined && origins.has(origin)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'Last-Event-ID', 'X-Request-Id'],
    exposedHeaders: ['Retry-After', 'X-Request-Id'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
