import { readFileSync } from 'node:fs';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { APP_OPTIONS, configureHttp } from '../app-options.js';

@Controller()
class MetricsProbeController {
  @Get('metrics')
  metrics() {
    return 'metrics';
  }
}

@Module({ controllers: [MetricsProbeController] })
class MetricsProbeModule {}

describe('/metrics is reachable only by its exact path', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    const express = await NestFactory.create<NestExpressApplication>(MetricsProbeModule, {
      ...APP_OPTIONS,
      logger: false,
    });
    configureHttp(express);
    app = express;
    await app.init();
  });

  afterAll(() => app.close());

  it('serves /metrics inside the network', async () => {
    await request(server()).get('/metrics').expect(200);
  });

  it.each(['/METRICS', '/Metrics', '/metricS'])('does not route %s to the handler', async (path) => {
    await request(server()).get(path).expect(404);
  });
});

describe('nginx refuses every spelling of /metrics', () => {
  const conf = readFileSync(new URL('../../../../infra/nginx/nginx.conf', import.meta.url), 'utf8');
  const block = /location ~\* (\S+) \{\s*default_type application\/problem\+json;\s*return 404/.exec(conf);

  it('has a case-insensitive regex location that answers 404', () => {
    expect(block).not.toBeNull();
  });

  // nginx matches against the normalised URI: %XX decoded, // merged, so /%6detrics and
  // //metrics reach the regex as /metrics and //metrics (merge_slashes is on by default).
  it.each(['/metrics', '/METRICS', '/Metrics', '//metrics', '/metrics/', '/metrics?x=1'])(
    'matches %s',
    (uri) => {
      const pattern = new RegExp(block?.[1] ?? '$^', 'i');
      expect(pattern.test(uri.split('?')[0])).toBe(true);
    },
  );

  it('does not use ^~ on any prefix, which would skip the regex check', () => {
    expect(conf).not.toMatch(/location \^~/);
  });
});
