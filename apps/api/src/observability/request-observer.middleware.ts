import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Histogram } from './metrics.js';
import { acceptRequestId, runWithRequestId } from './request-context.js';

export const httpRequestDuration = new Histogram(
  'http_request_duration_seconds',
  'HTTP request latency of this API instance, by route template',
);

const logger = new Logger('http');

/**
 * The route as declared (/api/v1/orders/:id), never the URL: an order id per series would grow
 * without end, and the query string can hold the events token.
 */
export function routeTemplate(req: Request): string {
  const route = (req as Request & { route?: { path?: unknown } }).route;
  return typeof route?.path === 'string' ? `${req.baseUrl}${route.path}` : 'unmatched';
}

/** Mounted first in main.ts, so every later log line of the request carries its id. */
export function requestObserver(req: Request, res: Response, next: NextFunction): void {
  const requestId = acceptRequestId(req.headers['x-request-id']);
  const started = process.hrtime.bigint();
  res.setHeader('X-Request-Id', requestId);
  runWithRequestId(requestId, () => {
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeTemplate(req);
      // A closed stream is how an SSE request ends; its length says nothing about latency.
      const status = res.headersSent ? res.statusCode : 499;
      httpRequestDuration.observe({ method: req.method, route, status: String(status) }, seconds);
      if (route !== '/healthz' && route !== '/metrics') {
        // Socket events do not keep the async context, so the id is set again here.
        runWithRequestId(requestId, () =>
          logger.log({ msg: 'request', method: req.method, route, status, duration_ms: Math.round(seconds * 1000) }),
        );
      }
    };
    res.on('finish', record);
    res.on('close', record);
    next();
  });
}
