import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { APP_OPTIONS } from './app-options.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, APP_OPTIONS);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
