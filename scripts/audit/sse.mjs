#!/usr/bin/env node
// SSE audit for SPEC 8.3, against a running compose stack. Node built-ins only.
//
//   node scripts/audit/sse.mjs [--api http://127.0.0.1:8080] [--clients 6] [--skip-redis]
//
// (a) streams spread over api-1 and api-2 see every status within 2 s of its order_events row
// (b) a stream cut mid-way and reopened with Last-Event-ID (header, then ?last_event_id=) gets
//     the missed events exactly once, in order
// (c) with Redis stopped (docker stop inblack-redis) streams still see every status within 2 s
// (d) a wrong, expired or foreign token, a bad checksum and an unknown order: the same 404
// Latency is the time the client read the frame minus occurred_at (order_events.created_at,
// written inside the transaction, so before the commit). Both clocks are this machine's when
// Docker runs locally.
// Exit code: 0 all checks passed, 1 a check failed, 2 the audit could not run.
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const API = opt('api', 'http://127.0.0.1:8080');
const CLIENTS = Number(opt('clients', 6));
const SKIP_REDIS = argv.includes('--skip-redis');
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? 'whsec_test_inblackm_2026';
// The compose default. Only used to forge an expired token, which needs the real key to be a fair test.
const TOKEN_SECRET = process.env.ORDER_EVENTS_TOKEN_SECRET ?? 'test_only_order_events_secret_change_me';
const LIMIT_MS = 2000;
const RUN = randomBytes(3).toString('hex');
const FLOW = ['PENDING_PAYMENT', 'PAID', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

const results = [];
function check(id, what, pass, evidence) {
  results.push({ id, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${what} :: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
}
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// ---------- HTTP helpers ----------

async function http(method, path, { headers = {}, body } = {}) {
  const res = await fetch(`${API}${path}`, { method, headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json, type: res.headers.get('content-type') ?? '' };
}

async function newOrder() {
  const email = `sse-${RUN}-${(seq += 1)}@audit.test`;
  const r = await http('POST', '/api/v1/orders', {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `sse-${randomUUID()}` },
    body: JSON.stringify({ email, game_uid: `ssePlayer${seq}`, payment_method: 'PROMPTPAY', voucher_code: null, items: [{ sku: 'DIAMOND-1000', qty: 1 }] }),
  });
  if (r.status !== 201) throw new Error(`create order: ${r.status} ${r.text}`);
  const t = await http('POST', '/api/v1/orders/track', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: r.json.order_id, email }) });
  if (t.status !== 200 || typeof t.json?.events_token !== 'string') throw new Error(`track: ${t.status} ${t.text}`);
  if (JSON.stringify(t.json).includes('actor')) throw new Error('track answer leaks an actor');
  return { id: r.json.order_id, total: r.json.total_satang, token: t.json.events_token };
}

async function payWebhook(order) {
  const raw = JSON.stringify({ event_id: `evt_sse_${randomUUID()}`, type: 'payment.succeeded', order_id: order.id, amount_satang: order.total, currency: 'THB', occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex')}`;
  const r = await http('POST', '/api/v1/webhooks/payment', { headers: { 'Content-Type': 'application/json', 'X-IBM-Signature': sig }, body: raw });
  if (r.status !== 200) throw new Error(`webhook: ${r.status} ${r.text}`);
}

// ---------- SSE client ----------

/** A minimal EventSource over fetch that records when each frame was read. */
function openStream(order, { lastEventId, query = '', token = order.token } = {}) {
  const controller = new AbortController();
  const events = [];
  const waiters = [];
  const headers = { Accept: 'text/event-stream' };
  if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
  const url = `${API}/api/v1/orders/${order.id}/events?token=${encodeURIComponent(token)}${query}`;
  const stream = { events, instance: null, status: 0, error: null, close: () => controller.abort() };
  stream.ready = (async () => {
    const res = await fetch(url, { headers, signal: controller.signal });
    stream.status = res.status;
    stream.instance = res.headers.get('x-instance');
    stream.buffering = res.headers.get('x-accel-buffering');
    if (res.status !== 200) return;
    (async () => {
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          const now = Date.now();
          buf += decoder.decode(chunk, { stream: true });
          let cut;
          while ((cut = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const id = /^id: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (id === undefined || data === undefined) continue;
            events.push({ id, data: JSON.parse(data), at: now });
            for (const w of [...waiters]) w();
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') stream.error = String(e);
      }
    })();
  })();
  stream.waitFor = (pred, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const drop = () => {
        const i = waiters.indexOf(test);
        if (i !== -1) waiters.splice(i, 1);
      };
      const test = () => {
        if (pred(events)) {
          drop();
          clearTimeout(timer);
          resolve(events);
        }
      };
      const timer = setTimeout(() => {
        drop();
        reject(new Error(`timed out; saw ${events.map((e) => e.data.status).join(',')}${stream.error ? ` (${stream.error})` : ''}`));
      }, timeoutMs);
      waiters.push(test);
      test();
    });
  return stream;
}
const has = (status) => (events) => events.some((e) => e.data.status === status);
const ids = (events) => events.map((e) => e.id);
const strictlyIncreasing = (list) => list.every((id, i) => i === 0 || BigInt(id) > BigInt(list[i - 1]));

function latencies(stream) {
  return stream.events.filter((e) => e.data.status !== 'PENDING_PAYMENT').map((e) => ({ status: e.data.status, ms: e.at - Date.parse(e.data.occurred_at) }));
}

async function streamsOnBothReplicas(order, n) {
  const streams = [];
  for (let i = 0; i < n || new Set(streams.map((s) => s.instance)).size < 2; i += 1) {
    if (i >= n + 10) break;
    const s = openStream(order);
    await s.ready;
    streams.push(s);
  }
  return streams;
}

// ---------- Scenarios ----------

async function scenarioA() {
  const order = await newOrder();
  const streams = await streamsOnBothReplicas(order, CLIENTS);
  const byInstance = {};
  for (const s of streams) byInstance[s.instance] = (byInstance[s.instance] ?? 0) + 1;
  check('a/spread', `${streams.length} streams opened through the proxy reach both replicas`, streams.every((s) => s.status === 200) && Object.keys(byInstance).length >= 2, { by_instance: byInstance, x_accel_buffering: streams[0].buffering });
  await Promise.all(streams.map((s) => s.waitFor(has('PENDING_PAYMENT'), 5000)));
  await payWebhook(order);
  await Promise.all(streams.map((s) => s.waitFor(has('COMPLETED'), 60_000)));
  await sleep(300);
  const all = streams.flatMap(latencies);
  const worst = Math.max(...all.map((l) => l.ms));
  const reference = ids(streams[0].events);
  check('a/latency', `every client saw PAID..COMPLETED within ${LIMIT_MS} ms of the DB write`, all.length > 0 && worst <= LIMIT_MS && Math.min(...all.map((l) => l.ms)) > -200, {
    worst_ms: worst,
    per_status_worst_ms: Object.fromEntries(FLOW.slice(1).map((st) => [st, Math.max(...all.filter((l) => l.status === st).map((l) => l.ms))])),
  });
  check('a/same-sequence', 'every client got the same events, ids strictly increasing, no repeats', streams.every((s) => JSON.stringify(ids(s.events)) === JSON.stringify(reference)) && strictlyIncreasing(reference), { ids: reference, statuses: streams[0].events.map((e) => e.data.status) });
  const leaked = streams[0].events.some((e) => Object.keys(e.data).sort().join() !== 'event_id,event_type,from_status,occurred_at,status');
  check('a/payload', 'payload is exactly {event_id,status,from_status,event_type,occurred_at}', !leaked, streams[0].events[0]?.data);
  streams.forEach((s) => s.close());
}

async function scenarioB() {
  const order = await newOrder();
  const first = openStream(order);
  await first.ready;
  await first.waitFor(has('PENDING_PAYMENT'), 5000);
  await payWebhook(order);
  await first.waitFor(has('PAID'), 10_000);
  first.close(); // the network drops right after PAID
  const seen = ids(first.events);
  const last = seen[seen.length - 1];

  const full = openStream(order, { lastEventId: '0' });
  await full.ready;
  await full.waitFor(has('COMPLETED'), 60_000);
  const reference = ids(full.events);
  full.close();

  const byHeader = openStream(order, { lastEventId: last });
  await byHeader.ready;
  await byHeader.waitFor(has('COMPLETED'), 10_000);
  await sleep(1500); // anything extra, such as a repeat, would arrive now
  byHeader.close();
  const byQuery = openStream(order, { query: `&last_event_id=${last}` });
  await byQuery.ready;
  await byQuery.waitFor(has('COMPLETED'), 10_000);
  await sleep(1500);
  byQuery.close();

  const joined = [...seen, ...ids(byHeader.events)];
  const missed = reference.length - seen.length;
  check('b/last-event-id-header', 'cut after PAID, reopened with Last-Event-ID header: missed events once each, in order', missed > 0 && JSON.stringify(joined) === JSON.stringify(reference) && strictlyIncreasing(joined), { before_cut: seen, after_reconnect: ids(byHeader.events), full_history: reference });
  check('b/last-event-id-query', 'same with ?last_event_id=', JSON.stringify([...seen, ...ids(byQuery.events)]) === JSON.stringify(reference), { after_reconnect: ids(byQuery.events) });
}

function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
async function waitHealthy(name, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (docker(['inspect', '-f', '{{.State.Health.Status}}', name]) === 'healthy') return;
    await sleep(500);
  }
  throw new Error(`${name} not healthy`);
}

async function scenarioC() {
  docker(['stop', 'inblack-redis']);
  log('docker stop inblack-redis');
  try {
    await sleep(1500);
    const ready = await http('GET', '/readyz');
    const order = await newOrder();
    const streams = await streamsOnBothReplicas(order, 2);
    await Promise.all(streams.map((s) => s.waitFor(has('PENDING_PAYMENT'), 5000)));
    await payWebhook(order);
    await Promise.all(streams.map((s) => s.waitFor(has('COMPLETED'), 60_000)));
    const all = streams.flatMap(latencies);
    const worst = Math.max(...all.map((l) => l.ms));
    check('c/redis-down', `Redis stopped: streams on ${[...new Set(streams.map((s) => s.instance))].join('+')} saw every status within ${LIMIT_MS} ms (Postgres poll)`, worst <= LIMIT_MS && streams.every((s) => s.events.length === 5), { worst_ms: worst, statuses: streams[0].events.map((e) => e.data.status), readyz_while_down: ready.status });
    streams.forEach((s) => s.close());
  } finally {
    docker(['start', 'inblack-redis']);
    log('docker start inblack-redis');
    await waitHealthy('inblack-redis');
  }
  await sleep(2000); // ioredis reconnects every second
  const order = await newOrder();
  const s = openStream(order);
  await s.ready;
  await s.waitFor(has('PENDING_PAYMENT'), 5000);
  await payWebhook(order);
  await s.waitFor(has('COMPLETED'), 60_000);
  const worst = Math.max(...latencies(s).map((l) => l.ms));
  check('c/redis-back', 'after Redis starts again, a new stream still sees every status in time', worst <= LIMIT_MS, { worst_ms: worst });
  s.close();
}

function forge(orderId, expiresAt) {
  const mac = createHmac('sha256', TOKEN_SECRET).update(`order-events:v1:${orderId}:${expiresAt}`).digest('base64url');
  return `v1.${expiresAt}.${mac}`;
}

async function scenarioD() {
  const mine = await newOrder();
  const other = await newOrder();
  const now = Math.floor(Date.now() / 1000);
  const flipped = mine.token.slice(0, -2) + (mine.token.at(-2) === 'A' ? 'B' : 'A') + mine.token.at(-1);
  const unknownId = 'ORD-0000000000000-000';
  const cases = {
    no_token: `/api/v1/orders/${mine.id}/events`,
    garbage_token: `/api/v1/orders/${mine.id}/events?token=nope`,
    tampered_token: `/api/v1/orders/${mine.id}/events?token=${encodeURIComponent(flipped)}`,
    expired_token: `/api/v1/orders/${mine.id}/events?token=${encodeURIComponent(forge(mine.id, now - 5))}`,
    other_orders_token: `/api/v1/orders/${mine.id}/events?token=${encodeURIComponent(other.token)}`,
    bad_checksum: `/api/v1/orders/ORD-2587965432159-458/events?token=${encodeURIComponent(forge('ORD-2587965432159-458', now + 600))}`,
    unknown_order_valid_token: `/api/v1/orders/${unknownId}/events?token=${encodeURIComponent(forge(unknownId, now + 600))}`,
  };
  const answers = {};
  for (const [name, path] of Object.entries(cases)) {
    const r = await http('GET', path, { headers: { Accept: 'text/event-stream' } });
    answers[name] = { status: r.status, type: r.type.split(';')[0], body: r.text };
  }
  const bodies = new Set(Object.values(answers).map((a) => `${a.status} ${a.type} ${a.body}`));
  check('d/same-404', 'wrong / expired / foreign token, bad checksum, unknown order: one identical 404 problem+json', bodies.size === 1 && Object.values(answers).every((a) => a.status === 404 && a.type === 'application/problem+json'), { distinct_answers: [...bodies], cases: Object.keys(cases) });
  const ok = openStream(mine);
  await ok.ready;
  check('d/valid', 'the real token still opens the stream', ok.status === 200, { status: ok.status });
  ok.close();
}

let exit = 0;
try {
  const ready = await http('GET', '/readyz');
  if (ready.status !== 200) throw new Error(`stack not ready: /readyz ${ready.status} ${ready.text}`);
  for (const [name, fn] of Object.entries({ a: scenarioA, b: scenarioB, c: scenarioC, d: scenarioD })) {
    if (name === 'c' && SKIP_REDIS) continue;
    console.log(`\n=== ${name} ===`);
    try {
      await fn();
    } catch (e) {
      check(`${name}/aborted`, 'scenario ran to the end', false, e.stack ?? String(e));
    }
  }
} catch (e) {
  console.error(`AUDIT COULD NOT RUN: ${e.stack ?? e}`);
  exit = 2;
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(exit || (failed ? 1 : 0));
