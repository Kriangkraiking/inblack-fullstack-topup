import { JsonLogger, maskEmail, redact } from './json-logger.js';
import { Histogram, renderGauge } from './metrics.js';
import { acceptRequestId, runWithRequestId } from './request-context.js';

describe('metrics text', () => {
  it('renders cumulative histogram buckets with route labels', () => {
    const h = new Histogram('http_request_duration_seconds', 'latency', [0.1, 1]);
    h.observe({ method: 'GET', route: '/api/v1/orders/:id', status: '404' }, 0.05);
    h.observe({ method: 'GET', route: '/api/v1/orders/:id', status: '404' }, 0.5);
    const text = h.render();
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/api/v1/orders/:id",status="404",le="0.1"} 1');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/api/v1/orders/:id",status="404",le="1"} 2');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/api/v1/orders/:id",status="404",le="+Inf"} 2');
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="/api/v1/orders/:id",status="404"} 2');
  });

  it('escapes label values', () => {
    expect(renderGauge('g', 'h', [{ labels: { a: 'x"y\\z' }, value: 1 }])).toContain('g{a="x\\"y\\\\z"} 1');
  });
});

describe('JSON log', () => {
  it('masks emails and game UIDs and drops secrets', () => {
    expect(maskEmail('pay for alice@example.com now')).toBe('pay for a***@example.com now');
    expect(redact({ email: 'bob@example.com', game_uid: 'player123', signature: 't=1,v1=ab', cookie: 'x', password: 'p' })).toEqual({
      email: 'b***@example.com',
      game_uid: 'p***3',
      signature: '[redacted]',
      cookie: '[redacted]',
      password: '[redacted]',
    });
  });

  it('writes one line with level, time, msg and the request id of the async context', () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ service: 'api' }, (line) => lines.push(line));
    runWithRequestId('req-123', () => logger.warn('hello carol@example.com', 'Ctx'));
    logger.log({ msg: 'request', status: 200 });
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(first).toMatchObject({ level: 'warn', service: 'api', context: 'Ctx', request_id: 'req-123', msg: 'hello c***@example.com' });
    expect(typeof first.time).toBe('string');
    expect(JSON.parse(lines[1])).not.toHaveProperty('request_id');
  });

  it('keeps a well-formed incoming request id and replaces anything else', () => {
    expect(acceptRequestId('abc-123_x.y')).toBe('abc-123_x.y');
    expect(acceptRequestId('bad id\n{')).toMatch(/^[0-9a-f-]{36}$/);
    expect(acceptRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
