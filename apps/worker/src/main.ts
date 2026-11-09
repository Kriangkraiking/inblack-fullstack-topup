import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { JsonLogger } from './observability/json-logger.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new JsonLogger({ service: 'worker' }),
  });
  app.enableShutdownHooks();
}
await bootstrap();
