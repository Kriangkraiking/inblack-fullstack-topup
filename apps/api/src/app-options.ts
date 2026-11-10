import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

export const APP_OPTIONS: NestApplicationOptions = {
  // Keeps the original bytes on req.rawBody. Webhook signatures are checked against those.
  rawBody: true,
};

/**
 * Express settings every instance needs, called before any middleware so the router picks them
 * up. Case-sensitive routing: /METRICS must not reach the /metrics handler. nginx refuses every
 * spelling of it anyway, this is the second layer.
 */
export function configureHttp(app: NestExpressApplication): void {
  app.set('case sensitive routing', true);
  // Express builds its router on first use, which NestFactory.create has already caused, so the
  // setting above alone changes nothing (the unit test caught that). Controllers are added to
  // the router at init(), after this, and each route reads caseSensitive when it is added.
  const instance = app.getHttpAdapter().getInstance() as { router?: { caseSensitive?: boolean } };
  if (instance.router) instance.router.caseSensitive = true;
  app.disable('x-powered-by');
}
