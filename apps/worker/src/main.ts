import { DOMAIN_PACKAGE_NAME } from '@inblack/domain';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  new Logger('Bootstrap').log(`Workspace package: ${DOMAIN_PACKAGE_NAME}`);
}
await bootstrap();
