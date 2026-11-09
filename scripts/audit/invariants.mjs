#!/usr/bin/env node
// Invariant audit for SPEC 5.4, run against a fresh clone with real concurrent requests.
// Node built-ins only. Facts come from Postgres (docker exec psql), mock-game /stats and the
// mock-pay settlement CSV, never from the API's own answers.
//
//   node scripts/audit/invariants.mjs [--commit <sha>] [--only s1a,s3] [--keep]
//   node scripts/audit/invariants.mjs --reuse <clone dir> --project <name> --only s4   (stack already up)
//
// Exit code: 0 all invariants held, 1 at least one check failed, 2 the audit itself could not run.
// The compose file fixes container names and host ports, so the project name separates volumes and
// networks only. The script refuses to start if inblack-* containers from elsewhere exist.
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO = opt('repo', path.resolve(scriptDir, '..', '..'));
const COMMIT = opt('commit', 'HEAD');
const REUSE = opt('reuse', undefined);
const PROJECT = opt('project', 'inblack-audit');
const ONLY = opt('only', undefined)?.split(',');
const KEEP = flag('keep');
const FLASH_REQUESTS = Number(opt('flash-requests', 600));
const WORK = REUSE ? path.dirname(REUSE) : fs.mkdtempSync(path.join(os.tmpdir(), 'inblack-audit-'));
const CLONE = REUSE ?? path.join(WORK, 'clone');
const OVERRIDE = path.join(WORK, 'audit.override.yml');

const API = 'http://127.0.0.1:8080';
const PAY = 'http://127.0.0.1:4010';
const GAME = 'http://127.0.0.1:4020';
const SECRET = 'whsec_test_inblackm_2026';
const PG = 'inblack-postgres';
const FLASH = 'FLASH-SKIN-01';
const D1000 = 'DIAMOND-1000';
const NOT_ACTIVE = `('EXPIRED','PAYMENT_FAILED','FAILED','REFUNDED')`;
const RUN = randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const email = (tag = 'u') => `${tag}-${RUN}-${(seq += 1)}@audit.test`;
const key = () => `audit-${randomUUID()}`;

// ---------- Reporting ----------

const results = [];
const notes = [];
function check(id, invariant, method, pass, evidence) {
  const text = typeof evidence === 'string' ? evidence : JSON.stringify(evidence);
  results.push({ id, invariant, method, pass, evidence: text });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${method} :: ${text}`);
}
function note(text) {
  notes.push(text);
  console.log(`NOTE ${text}`);
}
const log = (text) => console.log(`     ${new Date().toISOString().slice(11, 19)} ${text}`);

// ---------- Processes ----------

function run(cmd, args, { input, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => err.push(Buffer.from(String(e))));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() });
    });
    child.stdin.end(input ?? '');
  });
}

async function q(sql) {
  const r = await run('docker', ['exec', '-i', PG, 'psql', '-U', 'inblack_user', '-d', 'inblack_topup', '-At', '-q', '-v', 'ON_ERROR_STOP=1'], {
    input: `SELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t;`,
  });
  if (r.code !== 0) throw new Error(`psql failed: ${r.err}\n${sql}`);
  return JSON.parse(r.out.trim());
}
async function exec(sql) {
  const r = await run('docker', ['exec', '-i', PG, 'psql', '-U', 'inblack_user', '-d', 'inblack_topup', '-At', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql });
  if (r.code !== 0) throw new Error(`psql failed: ${r.err}\n${sql}`);
  return r.out;
}
const ids = (orders) => `ARRAY[${orders.map((o) => `'${o}'`).join(',') || "''"}]::text[]`;

function composeArgs(withOverride) {
  const files = ['-f', path.join(CLONE, 'docker-compose.yml')];
  if (withOverride) files.push('-f', OVERRIDE);
  return ['compose', '-p', PROJECT, ...files];
}
async function compose(args, { withOverride = true, timeoutMs = 600_000 } = {}) {
  const r = await run('docker', [...composeArgs(withOverride), ...args], { cwd: CLONE, timeoutMs });
  return r;
}
function writeOverride(game = {}) {
  const rates = { FAIL_RATE: 0, TIMEOUT_RATE: 0, SUCCESS_BUT_TIMEOUT_RATE: 0, LATENCY_MS: 0, ...game };
  const env = Object.entries(rates).map(([k, v]) => `      ${k}: "${v}"`).join('\n');
  const test = ['migrate', 'api-1', 'api-2', 'worker', 'mock-pay']
    .map((s) => `  ${s}:\n    environment:\n      APP_ENV: test`)
    .join('\n');
  fs.writeFileSync(OVERRIDE, `services:\n${test}\n  mock-game:\n    environment:\n${env}\n`);
}
async function setGame(game) {
  writeOverride(game);
  const r = await compose(['up', '-d', '--wait', '--no-deps', 'mock-game']);
  if (r.code !== 0) throw new Error(`mock-game recreate failed: ${r.err}`);
  log(`mock-game env ${JSON.stringify(game)}`);
}
async function dockerKill(name) {
  const r = await run('docker', ['kill', `inblack-${name}`]);
  if (r.code !== 0) throw new Error(`docker kill ${name}: ${r.err}`);
  log(`docker kill ${name}`);
}
async function dockerStart(name) {
  const r = await run('docker', ['start', `inblack-${name}`]);
  if (r.code !== 0) throw new Error(`docker start ${name}: ${r.err}`);
  log(`docker start ${name}`);
}
async function containerState(name) {
  const r = await run('docker', ['inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} policy={{.HostConfig.RestartPolicy.Name}}', `inblack-${name}`]);
  return r.out.trim();
}
async function waitHealthy(name, timeoutMs = 90_000) {
  await waitFor(`${name} healthy`, async () => (await containerState(name)).includes('healthy') && !(await containerState(name)).includes('unhealthy'), timeoutMs);
}

// ---------- HTTP ----------

async function http(method, url, { headers = {}, body, timeoutMs = 90_000 } = {}) {
  try {
    const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, instance: res.headers.get('x-instance'), setCookie: res.headers.getSetCookie?.() ?? [] };
  } catch (e) {
    return { status: 0, text: String(e.cause?.code ?? e.name), json: undefined, instance: null, setCookie: [] };
  }
}
const jsonHeaders = { 'Content-Type': 'application/json' };

function orderBody({ mail, items, voucher, method = 'PROMPTPAY' }) {
  return JSON.stringify({ email: mail, game_uid: `player${(seq += 1)}`, payment_method: method, voucher_code: voucher ?? null, items });
}
async function postOrder(body, idemKey = key()) {
  const r = await http('POST', `${API}/api/v1/orders`, { headers: { ...jsonHeaders, 'Idempotency-Key': idemKey }, body });
  return { ...r, key: idemKey, body };
}
const buy = (spec) => postOrder(orderBody(spec));
const mustBuy = async (spec) => {
  const r = await buy(spec);
  if (r.status !== 201) throw new Error(`setup order failed ${r.status}: ${r.text}`);
  return r.json;
};
async function inPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
function tally(responses) {
  const by = {};
  for (const r of responses) {
    const label = r.status === 0 ? `net:${r.text}` : r.status < 400 ? String(r.status) : `${r.status}:${r.json?.code ?? '?'}`;
    by[label] = (by[label] ?? 0) + 1;
  }
  return by;
}
function instances(responses) {
  const by = {};
  for (const r of responses) if (r.instance) by[r.instance] = (by[r.instance] ?? 0) + 1;
  return by;
}

async function pay(orderId, amount, scenario = 'success') {
  const r = await http('POST', `${PAY}/checkout/pay`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ order_id: orderId, amount_satang: String(amount), scenario }).toString(),
  });
  if (r.status !== 200) throw new Error(`mock-pay ${r.status}: ${r.text}`);
}
function mkEvent(type, orderId, amount, eventId = `evt_audit_${randomUUID()}`) {
  return { event_id: eventId, type, order_id: orderId, amount_satang: amount, currency: 'THB', occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
}
function signature(raw, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}
function webhookRaw(raw, sig = signature(raw)) {
  return http('POST', `${API}/api/v1/webhooks/payment`, { headers: { ...jsonHeaders, 'X-IBM-Signature': sig }, body: raw });
}
const webhook = (event) => webhookRaw(JSON.stringify(event));

async function login() {
  const r = await http('POST', `${API}/api/v1/admin/auth/login`, {
    headers: jsonHeaders,
    body: JSON.stringify({ email: 'finance@inblackm.test', password: 'Finance-Test-2026' }),
  });
  if (r.status !== 200) throw new Error(`login failed ${r.status}: ${r.text}`);
  return r.setCookie[0].split(';')[0];
}
function refund(session, orderId, amount, idemKey = key()) {
  return http('POST', `${API}/api/v1/admin/orders/${orderId}/refund`, {
    headers: { ...jsonHeaders, Cookie: session, 'Idempotency-Key': idemKey },
    body: JSON.stringify({ amount_satang: amount, reason: 'audit' }),
  }).then((r) => ({ ...r, amount, key: idemKey }));
}

// ---------- Truth ----------

async function waitFor(label, fn, timeoutMs = 120_000, everyMs = 500) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(everyMs);
  }
}
async function reset() {
  const r = await http('POST', `${API}/api/v1/_test/reset`);
  if (r.status !== 200) throw new Error(`reset failed ${r.status}: ${r.text}`);
}
const statusOf = async (orders) => q(`SELECT id, status, paid_satang, refunded_satang FROM orders WHERE id = ANY(${ids(orders)})`);
const statusTally = async () => Object.fromEntries((await q(`SELECT status, count(*)::int n FROM orders GROUP BY 1 ORDER BY 1`)).map((r) => [r.status, r.n]));
const waitStatus = (orders, wanted, timeoutMs = 60_000) =>
  waitFor(`${orders.length} order(s) in ${wanted}`, async () => (await statusOf(orders)).every((o) => wanted.includes(o.status)), timeoutMs);
async function flashState() {
  const [r] = await q(`SELECT (SELECT stock FROM products WHERE sku='${FLASH}') stock,
    (SELECT coalesce(sum(i.qty),0)::int FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.sku='${FLASH}' AND o.status NOT IN ${NOT_ACTIVE}) active`);
  return r;
}
async function voucherState() {
  const [r] = await q(`SELECT (SELECT used_count FROM vouchers WHERE code='SAVE10') used,
    (SELECT count(*)::int FROM voucher_redemptions WHERE voucher_code='SAVE10' AND released_at IS NULL) open,
    (SELECT count(*)::int FROM orders WHERE voucher_code='SAVE10' AND status NOT IN ('EXPIRED','PAYMENT_FAILED')) holding`);
  return r;
}
async function expireNow(orders) {
  await exec(`UPDATE orders SET expires_at = now() WHERE id = ANY(${ids(orders)});`);
}
function sampler(fn, everyMs = 100) {
  const samples = [];
  let stop = false;
  const done = (async () => {
    while (!stop) {
      samples.push(await fn());
      await sleep(everyMs);
    }
  })();
  return async () => {
    stop = true;
    await done;
    return samples;
  };
}
async function gameStats() {
  const r = await http('GET', `${GAME}/stats`);
  if (r.status !== 200) throw new Error(`mock-game /stats ${r.status}`);
  return r.json.by_reference;
}
async function settlementRows() {
  const r = await http('GET', `${PAY}/settlements.csv`);
  if (r.status !== 200) throw new Error(`mock-pay csv ${r.status}`);
  const rows = r.text.trim().split('\n').slice(1).map((line) => {
    const [event_id, order_id, type, amount, settled_at] = line.split(',');
    return { event_id, order_id, type, amount_satang: Number(amount), settled_at };
  });
  return { csv: r.text, rows };
}
const drained = async () => {
  const [r] = await q(`SELECT
    (SELECT count(*)::int FROM orders WHERE status IN ('PAID','IN_QUEUE','IN_PROGRESS')) busy,
    (SELECT count(*)::int FROM outbox WHERE processed_at IS NULL) open_jobs,
    (SELECT count(*)::int FROM refunds WHERE status='PENDING') pending_refunds`);
  return r.busy === 0 && r.open_jobs === 0 ? r : false;
};
const waitDrained = (timeoutMs = 300_000) => waitFor('outbox and fulfillment to drain', drained, timeoutMs, 1000);

const SPEC_EDGES = new Set([
  'PENDING_PAYMENT>PAID', 'PENDING_PAYMENT>EXPIRED', 'PENDING_PAYMENT>PAYMENT_FAILED', 'PAID>IN_QUEUE', 'IN_QUEUE>IN_PROGRESS',
  'IN_PROGRESS>COMPLETED', 'IN_PROGRESS>FAILED', 'COMPLETED>REFUNDED', 'FAILED>REFUNDED',
]);
const ADR_EDGES = new Set(['EXPIRED>PAID', 'EXPIRED>REFUNDED', 'NEEDS_REVIEW>PAID', 'NEEDS_REVIEW>COMPLETED', 'NEEDS_REVIEW>REFUNDED']);

/** Invariant 6: every order's event chain follows the state machine and ends on orders.status. */
async function auditEvents(id) {
  const orders = await q(`SELECT id, status FROM orders`);
  const events = await q(`SELECT order_id, event_type, from_status, to_status FROM order_events ORDER BY id`);
  const byOrder = new Map(orders.map((o) => [o.id, []]));
  for (const e of events) byOrder.get(e.order_id)?.push(e);
  const problems = [];
  const adrUsed = {};
  for (const o of orders) {
    const chain = byOrder.get(o.id);
    let state = null;
    chain.forEach((e, i) => {
      if (i === 0) {
        if (e.event_type !== 'order.created' || e.from_status !== null || e.to_status !== 'PENDING_PAYMENT') problems.push(`${o.id}: bad first event ${JSON.stringify(e)}`);
        state = e.to_status;
        return;
      }
      if (e.from_status !== state) problems.push(`${o.id}: event ${e.event_type} from ${e.from_status} but state was ${state}`);
      if (e.event_type === 'status.changed') {
        const edge = `${e.from_status}>${e.to_status}`;
        if (ADR_EDGES.has(edge)) adrUsed[edge] = (adrUsed[edge] ?? 0) + 1;
        else if (!SPEC_EDGES.has(edge) && e.to_status !== 'NEEDS_REVIEW') problems.push(`${o.id}: edge outside the state machine ${edge}`);
        state = e.to_status;
      } else if (e.to_status !== state) problems.push(`${o.id}: note ${e.event_type} says ${e.to_status} but state was ${state}`);
    });
    if (state !== o.status) problems.push(`${o.id}: orders.status=${o.status} but last event says ${state}`);
  }
  check(`${id}/events`, 6, 'order_events chain follows the state machine and matches orders.status', problems.length === 0, {
    orders: orders.length, events: events.length, adr_edges_used: adrUsed, problems: problems.slice(0, 5), problem_count: problems.length,
  });
}

/** Invariants 3 and 5, per order: Postgres against the provider's own settlement file. */
async function auditMoney(id, { orderIds, requireNoPending = true } = {}) {
  const filter = orderIds ? `WHERE o.id = ANY(${ids(orderIds)})` : '';
  const db = await q(`SELECT o.id, o.status, o.paid_satang::bigint paid, o.refunded_satang::bigint reserved,
      coalesce((SELECT sum(amount_satang) FROM refunds r WHERE r.order_id=o.id AND r.status='SUCCEEDED'),0)::bigint settled,
      coalesce((SELECT sum(amount_satang) FROM refunds r WHERE r.order_id=o.id AND r.status='PENDING'),0)::bigint pending
    FROM orders o ${filter}`);
  const { rows } = await settlementRows();
  const provider = new Map();
  for (const r of rows) {
    const p = provider.get(r.order_id) ?? { paid: 0, refunded: 0 };
    if (r.type === 'payment.succeeded') p.paid += r.amount_satang;
    if (r.type === 'payment.refunded') p.refunded += r.amount_satang;
    provider.set(r.order_id, p);
  }
  const bad = [];
  let paidDb = 0, paidPr = 0, refDb = 0, refPr = 0;
  for (const o of db) {
    const p = provider.get(o.id) ?? { paid: 0, refunded: 0 };
    paidDb += o.paid; paidPr += p.paid; refDb += o.settled; refPr += p.refunded;
    const wrong = [];
    if (o.paid !== p.paid) wrong.push('paid differs');
    if (o.settled !== p.refunded) wrong.push('settled refunds differ from provider');
    if (o.settled + o.pending !== o.reserved) wrong.push('refunded_satang is not settled+pending');
    if (p.refunded > p.paid || o.reserved > o.paid) wrong.push('REFUND OVER PAID');
    if (requireNoPending && o.pending > 0) wrong.push('PENDING refund after drain');
    if (wrong.length) bad.push({ ...o, provider: p, wrong });
  }
  check(`${id}/money`, 3, 'per order: DB paid and settled refunds equal the mock-pay CSV, refunds never over paid', bad.length === 0, {
    orders: db.length, paid_db: paidDb, paid_provider: paidPr, refunded_db: refDb, refunded_provider: refPr, bad: bad.slice(0, 5), bad_count: bad.length,
  });
}

async function auditGame(id) {
  const stats = await gameStats();
  const dup = Object.entries(stats).filter(([, n]) => n > 1);
  check(`${id}/stats`, 2, 'mock-game GET /stats: no reference above 1', dup.length === 0, {
    references: Object.keys(stats).length, max: Math.max(0, ...Object.values(stats)), duplicates: dup.slice(0, 10),
  });
}

/** Every COMPLETED line has exactly one top-up, and an order refunded after FAILED has none. */
async function auditDelivery(id) {
  const stats = await gameStats();
  const rows = await q(`SELECT o.id, o.status, i.sku, (SELECT count(*)::int FROM order_events e WHERE e.order_id=o.id AND e.to_status='FAILED') failed
    FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.status IN ('COMPLETED','FAILED','REFUNDED','NEEDS_REVIEW')`);
  const bad = [];
  const seen = {};
  for (const r of rows) {
    const n = stats[`${r.id}:${r.sku}`] ?? 0;
    seen[r.status] = (seen[r.status] ?? 0) + 1;
    if (r.status === 'COMPLETED' && n !== 1) bad.push({ ...r, topups: n, why: 'COMPLETED without exactly one top-up' });
    if ((r.status === 'FAILED' || r.failed > 0) && n > 0) bad.push({ ...r, topups: n, why: 'FAILED or refunded after FAILED, yet the game was topped up' });
  }
  check(`${id}/delivery`, 2, 'COMPLETED lines have exactly 1 top-up, FAILED lines have 0', bad.length === 0, { lines_by_status: seen, bad: bad.slice(0, 5), bad_count: bad.length });
}

const flashBuyers = (n, qtyFor = (i) => (i % 2) + 1) => Array.from({ length: n }, (_, i) => ({ mail: email('flash'), items: [{ sku: FLASH, qty: qtyFor(i) }] }));

// ---------- 1. Oversell ----------

async function s1a() {
  await reset();
  const replies = await Promise.all(flashBuyers(FLASH_REQUESTS).map(buy));
  const won = replies.filter((r) => r.status === 201);
  const sold = won.reduce((sum, r) => sum + r.json.items[0].qty, 0);
  const state = await flashState();
  const others = replies.filter((r) => r.status !== 201 && r.json?.code !== 'OUT_OF_STOCK');
  check('s1a/burst', 1, `${FLASH_REQUESTS} concurrent requests, qty 1 and 2, distinct emails`, sold <= 100 && state.stock >= 0 && state.stock + state.active === 100 && others.length === 0, {
    replies: tally(replies), replicas: instances(replies), sold_qty: sold, ...state,
  });
  await inPool(won, 50, (r) => pay(r.json.order_id, r.json.total_satang));
  await waitDrained();
  const stats = await gameStats();
  const delivered = won.reduce((sum, r) => sum + (stats[`${r.json.order_id}:${FLASH}`] ?? 0) * r.json.items[0].qty, 0);
  check('s1a/delivered', 1, 'all winners paid through mock-pay, units delivered per /stats', delivered === sold && delivered <= 100, { delivered_qty: delivered, statuses: await statusTally(), ...(await flashState()) });
  await auditGame('s1a');
  await auditMoney('s1a');
}

async function s1b() {
  await reset();
  const orders = (await inPool(flashBuyers(50, () => 2), 20, mustBuy)).map((o) => o);
  const stopSampling = sampler(flashState);
  const expiring = orders.slice(0, 30).map((o) => o.order_id);
  const failing = orders.slice(20, 40);
  const buyers = [];
  await expireNow(expiring);
  const hooks = failing.flatMap((o) => {
    const event = mkEvent('payment.failed', o.order_id, o.total_satang);
    return [webhook(event), webhook(event), webhook(mkEvent('payment.failed', o.order_id, o.total_satang))];
  });
  for (let wave = 0; wave < 8; wave += 1) {
    buyers.push(...flashBuyers(60).map(buy));
    await sleep(1000);
  }
  await Promise.all(hooks);
  const replies = await Promise.all(buyers);
  await waitStatus(orders.slice(0, 40).map((o) => o.order_id), ['EXPIRED', 'PAYMENT_FAILED']);
  const samples = await stopSampling();
  const total = samples.map((s) => s.stock + s.active);
  const state = await flashState();
  const won = replies.filter((r) => r.status === 201).reduce((sum, r) => sum + r.json.items[0].qty, 0);
  check('s1b/release', 1, 'expiry and payment.failed return stock (10 orders got both) while 480 buyers arrive', Math.max(...total) <= 100 && Math.min(...samples.map((s) => s.stock)) >= 0 && state.stock + state.active === 100, {
    samples: samples.length, stock_plus_active_max: Math.max(...total), stock_plus_active_min: Math.min(...total), min_stock: Math.min(...samples.map((s) => s.stock)), bought_during_release: won, replies: tally(replies), ...state, statuses: await statusTally(),
  });
}

function shuffleCase(mail, i) {
  if (i % 4 === 0) return mail;
  if (i % 4 === 1) return mail.toUpperCase();
  if (i % 4 === 2) return mail.replace(/^./, (c) => c.toUpperCase()).replace('audit', 'AuDiT');
  return `  ${mail.toUpperCase()} `;
}
async function s1c() {
  await reset();
  const heldBy = async (mail) => (await q(`SELECT coalesce(sum(i.qty),0)::int qty FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.sku='${FLASH}' AND o.email='${mail.toLowerCase()}' AND o.status NOT IN ${NOT_ACTIVE}`))[0].qty;

  const a = email('same');
  const r1 = await Promise.all(Array.from({ length: 60 }, (_, i) => buy({ mail: shuffleCase(a, i), items: [{ sku: FLASH, qty: 1 }] })));
  const heldA = await heldBy(a);
  check('s1c/qty1', 1, 'one email, 60 concurrent qty=1, mixed case and surrounding spaces', heldA <= 2, { replies: tally(r1), active_qty: heldA, replicas: instances(r1) });

  const b = email('same');
  const r2 = await Promise.all(Array.from({ length: 40 }, (_, i) => buy({ mail: shuffleCase(b, i), items: [{ sku: FLASH, qty: (i % 2) + 1 }] })));
  const heldB = await heldBy(b);
  check('s1c/mixed', 1, 'one email, 40 concurrent qty 1 and 2, mixed case', heldB <= 2, { replies: tally(r2), active_qty: heldB });

  const c = email('same');
  const r3 = await buy({ mail: c, items: [{ sku: FLASH, qty: 1 }, { sku: FLASH, qty: 2 }] });
  check('s1c/split-lines', 1, 'qty split over two lines of one order cannot dodge the limit', r3.status === 422 || r3.status === 409, { status: r3.status, code: r3.json?.code });

  // Allowance returns on expiry and must not overshoot while the same email buys again.
  const d = email('same');
  const held = await mustBuy({ mail: d, items: [{ sku: FLASH, qty: 2 }] });
  await expireNow([held.order_id]);
  const stop = sampler(() => heldBy(d));
  const r4 = [];
  for (let wave = 0; wave < 7; wave += 1) {
    r4.push(...(await Promise.all(Array.from({ length: 10 }, (_, i) => buy({ mail: shuffleCase(d, i), items: [{ sku: FLASH, qty: 1 }] })))));
    await sleep(1000);
  }
  await waitStatus([held.order_id], ['EXPIRED']);
  const samplesD = await stop();
  check('s1c/expiry-return', 1, 'one email keeps buying while its own order expires', Math.max(...samplesD) <= 2, { replies: tally(r4), max_active_qty: Math.max(...samplesD), final: await heldBy(d) });

  // A late payment must not lift the email over the limit either.
  const e = email('same');
  const x = await mustBuy({ mail: e, items: [{ sku: FLASH, qty: 2 }] });
  await expireNow([x.order_id]);
  await waitStatus([x.order_id], ['EXPIRED']);
  await mustBuy({ mail: e, items: [{ sku: FLASH, qty: 2 }] });
  await pay(x.order_id, x.total_satang);
  await waitStatus([x.order_id], ['REFUNDED']);
  const heldE = await heldBy(e);
  check('s1c/late-pay-limit', 1, 'late payment after the email bought 2 again: refunded, not reinstated', heldE === 2, { active_qty: heldE, order: (await statusOf([x.order_id]))[0] });
  await auditMoney('s1c', { orderIds: [x.order_id] });
  const worst = await q(`SELECT o.email, sum(i.qty)::int qty FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.sku='${FLASH}' AND o.status NOT IN ${NOT_ACTIVE} GROUP BY 1 HAVING sum(i.qty) > 2`);
  check('s1c/db', 1, 'no email above 2 active units in the whole table', worst.length === 0, { over_limit: worst });
}

async function s1d(rounds = 10) {
  const outcomes = { reinstated: 0, refunded: 0 };
  const bad = [];
  const late = [];
  for (let round = 0; round < rounds; round += 1) {
    await reset();
    await inPool(flashBuyers(49, () => 2), 20, mustBuy);
    await mustBuy({ mail: email('flash'), items: [{ sku: FLASH, qty: 1 }] });
    const x = await mustBuy({ mail: email('late'), items: [{ sku: FLASH, qty: 1 }] });
    await expireNow([x.order_id]);
    await waitStatus([x.order_id], ['EXPIRED']);
    const before = await flashState();
    const offset = (round / rounds) * 350;
    const buyersDone = sleep(offset).then(() => Promise.all(flashBuyers(20, () => 1).map(buy)));
    await pay(x.order_id, x.total_satang);
    const replies = await buyersDone;
    const [order] = await waitFor('late order to finish', async () => {
      const s = await statusOf([x.order_id]);
      return ['COMPLETED', 'REFUNDED'].includes(s[0].status) ? s : false;
    }, 60_000);
    const won = replies.filter((r) => r.status === 201).length;
    const state = await flashState();
    late.push(x.order_id);
    const { rows } = await settlementRows();
    const refunded = rows.filter((r) => r.order_id === x.order_id && r.type === 'payment.refunded').reduce((s, r) => s + r.amount_satang, 0);
    const ok =
      before.stock === 1 && state.stock === 0 && state.active <= 100 &&
      (order.status === 'COMPLETED' ? won === 0 && refunded === 0 : won === 1 && refunded === order.paid_satang);
    outcomes[order.status === 'COMPLETED' ? 'reinstated' : 'refunded'] += 1;
    if (!ok) bad.push({ round, order, won, refunded, state, before });
  }
  check('s1d/last-piece', 1, `${rounds} rounds: payment.succeeded after EXPIRED races 20 buyers for the last unit`, bad.length === 0, { outcomes, bad });
  await auditGame('s1d');
}

// ---------- 2. Double top-up ----------

async function s2a() {
  await reset();
  // Rates high enough that some orders use up every POST and reach FAILED, not only COMPLETED.
  await setGame({ SUCCESS_BUT_TIMEOUT_RATE: 0.2, TIMEOUT_RATE: 0.25, FAIL_RATE: 0.35, LATENCY_MS: 100 });
  const specs = [
    ...Array.from({ length: 70 }, () => ({ mail: email('game'), items: [{ sku: D1000, qty: 1 }] })),
    ...Array.from({ length: 20 }, () => ({ mail: email('game'), items: [{ sku: 'MONTHLY-PASS', qty: 1 }, { sku: 'DIAMOND-5000', qty: 1 }] })),
    ...Array.from({ length: 10 }, () => ({ mail: email('game'), items: [{ sku: FLASH, qty: 1 }] })),
  ];
  const orders = await inPool(specs, 20, mustBuy);
  await inPool(orders, 20, (o) => pay(o.order_id, o.total_satang));

  const inProgress = async () => (await q(`SELECT count(*)::int n FROM orders WHERE status='IN_PROGRESS'`))[0].n;
  await waitFor('some IN_PROGRESS', async () => (await inProgress()) > 0, 30_000, 100);
  const kills = [];
  for (const wait of [3000, 7000, 7000]) {
    await sleep(wait);
    const n = await inProgress();
    if (n === 0) break; // A kill with nothing in progress proves nothing, the check below counts real ones.
    const open = (await q(`SELECT count(*)::int n FROM fulfillment_attempts WHERE status='IN_FLIGHT'`))[0].n;
    await dockerKill('worker');
    await sleep(5000);
    kills.push({ in_progress_at_kill: n, in_flight_at_kill: open, state_5s_after_kill: await containerState('worker') });
    await dockerStart('worker');
  }
  const lastStart = Date.now();
  note(`docker kill worker: ${kills[0].state_5s_after_kill} (Docker does not restart a killed container here, the audit runs docker start)`);
  check('s2a/kills', 2, 'worker killed 3 times, each while orders were IN_PROGRESS', kills.length >= 2, kills);
  await waitDrained(420_000);
  const recoveredIn = Date.now() - lastStart;
  await auditGame('s2a');
  await auditDelivery('s2a');
  const [{ max_seconds: dwell }] = await q(`
    SELECT greatest(coalesce(max(extract(epoch FROM x.left_at - greatest(x.entered, to_timestamp(${lastStart / 1000})))),0),0)::int max_seconds FROM (
      SELECT e.created_at entered, (SELECT min(n.created_at) FROM order_events n WHERE n.order_id=e.order_id AND n.id>e.id AND n.event_type='status.changed') left_at
      FROM order_events e WHERE e.to_status='IN_PROGRESS' AND e.event_type='status.changed') x WHERE x.left_at IS NOT NULL`);
  const stuck = await q(`SELECT id, status FROM orders WHERE status IN ('PAID','IN_QUEUE','IN_PROGRESS')`);
  check('s2a/settled', 2, 'after the last restart nothing stays in IN_QUEUE or IN_PROGRESS, longest IN_PROGRESS under 120s', stuck.length === 0 && dwell <= 120, {
    drained_ms_after_last_start: recoveredIn, max_in_progress_after_restart_s: dwell, statuses: await statusTally(),
    jobs: await q(`SELECT topic, count(*)::int n, max(attempts) max_attempts FROM outbox GROUP BY 1`), dead_letters: (await q(`SELECT count(*)::int n FROM dead_letters`))[0].n,
  });
  await auditMoney('s2a');
}

async function s2b() {
  await reset();
  await setGame({ SUCCESS_BUT_TIMEOUT_RATE: 0.3 });
  const orders = await inPool(Array.from({ length: 20 }, () => ({ mail: email('hook'), items: [{ sku: D1000, qty: 1 }] })), 10, mustBuy);
  const same = orders.slice(0, 10);
  const distinct = orders.slice(10);

  const r1 = await Promise.all(same.flatMap((o) => {
    const event = mkEvent('payment.succeeded', o.order_id, o.total_satang);
    return Array.from({ length: 20 }, () => webhook(event));
  }));
  const r2 = await Promise.all(distinct.flatMap((o) => Array.from({ length: 20 }, () => webhook(mkEvent('payment.succeeded', o.order_id, o.total_satang)))));
  const outcomes = (replies) => replies.reduce((acc, r) => ({ ...acc, [`${r.status}:${r.json?.outcome}`]: (acc[`${r.status}:${r.json?.outcome}`] ?? 0) + 1 }), {});
  const counts = async (list) => q(`SELECT o.id,
      (SELECT count(*)::int FROM outbox j WHERE j.aggregate_id=o.id AND j.topic='fulfillment.requested') jobs,
      (SELECT count(*)::int FROM order_events e WHERE e.order_id=o.id AND e.to_status='PAID') paid_events,
      (SELECT count(*)::int FROM webhook_events w WHERE w.order_id=o.id) rows
    FROM orders o WHERE o.id = ANY(${ids(list.map((x) => x.order_id))})`);
  const c1 = await counts(same);
  const c2 = await counts(distinct);
  check('s2b/same-event', 2, '10 orders, same event_id sent 20 times at once', c1.every((c) => c.jobs === 1 && c.paid_events === 1 && c.rows === 1) && r1.every((r) => r.status === 200), { outcomes: outcomes(r1), replicas: instances(r1), max_jobs: Math.max(...c1.map((c) => c.jobs)), max_paid_events: Math.max(...c1.map((c) => c.paid_events)) });
  check('s2b/new-event', 2, '10 orders, 20 different event_ids at once', c2.every((c) => c.jobs === 1 && c.paid_events === 1) && r2.every((r) => r.status === 200), { outcomes: outcomes(r2), max_jobs: Math.max(...c2.map((c) => c.jobs)), max_paid_events: Math.max(...c2.map((c) => c.paid_events)) });

  await waitDrained();
  const statsBefore = await gameStats();
  const after = await Promise.all(orders.flatMap((o) => [webhook(mkEvent('payment.succeeded', o.order_id, o.total_satang)), webhook(mkEvent('payment.failed', o.order_id, o.total_satang))]));
  await sleep(4000);
  const statuses = await statusOf(orders.map((o) => o.order_id));
  const statsAfter = await gameStats();
  const unchanged = orders.every((o) => statsBefore[`${o.order_id}:${D1000}`] === statsAfter[`${o.order_id}:${D1000}`]);
  check('s2b/after-completed', 2, 'new succeeded and failed events after COMPLETED change nothing', statuses.every((s) => s.status === 'COMPLETED') && unchanged, { outcomes: outcomes(after), statuses: [...new Set(statuses.map((s) => s.status))] });
  await auditGame('s2b');
  await auditDelivery('s2b');

  const probe = await mustBuy({ mail: email('hook'), items: [{ sku: D1000, qty: 1 }] });
  const raw = JSON.stringify(mkEvent('payment.succeeded', probe.order_id, probe.total_satang));
  const old = Math.floor(Date.now() / 1000) - 301;
  const bad = [
    await webhookRaw(raw, signature(raw, undefined, 'whsec_wrong')),
    await webhookRaw(raw, signature(raw, old)),
    await webhookRaw(raw.replace('"THB"', '"THB" '), signature(raw)),
  ];
  const good = await webhookRaw(`  ${raw.replace('{', '{ ')}\n`);
  check('s2b/signature', 2, 'wrong secret, stale t and changed bytes refused, spaced raw body accepted', bad.every((r) => r.status === 401) && good.status === 200, { refused: bad.map((r) => r.status), spaced_body: good.status });
  await waitDrained();
  await setGame({});
}

// ---------- 3. Refunds, and 5. reconciliation over the same data ----------

async function paidCompleted(n, spec = () => ({ mail: email('ref'), items: [{ sku: D1000, qty: 1 }] })) {
  const orders = await inPool(Array.from({ length: n }, spec), 20, mustBuy);
  await inPool(orders, 20, (o) => pay(o.order_id, o.total_satang));
  await waitStatus(orders.map((o) => o.order_id), ['COMPLETED'], 90_000);
  return orders;
}

async function s3() {
  // Start the provider empty too, so the settlement file below is compared whole, with no filter.
  const wipe = await run('docker', ['exec', 'inblack-mock-pay', 'sh', '-c', ': > /data/mock-pay.jsonl']);
  if (wipe.code !== 0) throw new Error(`could not empty the mock-pay journal: ${wipe.err}`);
  await run('docker', ['restart', 'inblack-mock-pay']);
  await waitHealthy('mock-pay');
  await reset();
  await setGame({});
  const [s1, s2] = [await login(), await login()];
  const session = (i) => (i % 2 ? s1 : s2);
  const T = 34900;

  const races = [
    { label: 'full vs full', amounts: () => Array(10).fill(T) },
    { label: 'partial and full', amounts: () => [...Array(8).fill(10000), ...Array(4).fill(T)] },
    { label: 'different partials', amounts: () => [12000, 11000, 10000, 9000, 8000, 7000, 6000, 5000] },
    { label: 'same partials', amounts: () => Array(12).fill(5000) },
  ];
  for (const race of races) {
    const orders = await paidCompleted(5);
    const replies = (await Promise.all(orders.map((o) => Promise.all(race.amounts().map((a, i) => refund(session(i), o.order_id, a)))))).flat();
    const accepted = {};
    for (const r of replies.filter((x) => x.status === 202)) accepted[r.json.order_id] = (accepted[r.json.order_id] ?? 0) + r.amount;
    check(`s3/race ${race.label}`, 3, `2 finance sessions, ${race.amounts().length} concurrent refunds per order, 5 orders`, Object.values(accepted).every((sum) => sum <= T), { replies: tally(replies), replicas: instances(replies), accepted_per_order: Object.values(accepted) });
  }
  await waitDrained();
  await auditMoney('s3/race');

  // The same key from both sessions.
  const [idem] = await paidCompleted(1);
  const k = key();
  const same = await Promise.all(Array.from({ length: 20 }, (_, i) => refund(session(i), idem.order_id, 5000, k)));
  const bodies = new Set(same.map((r) => `${r.status} ${r.text}`));
  const rows = await q(`SELECT count(*)::int n FROM refunds WHERE order_id='${idem.order_id}'`);
  const reused = await refund(s1, idem.order_id, 6000, k);
  check('s3/idempotency', 3, 'same Idempotency-Key 20 times from 2 sessions', rows[0].n === 1 && bodies.size === 1 && same[0].status === 202 && reused.status === 422 && reused.json?.code === 'IDEMPOTENCY_KEY_REUSED', { refund_rows: rows[0].n, distinct_replies: bodies.size, status: same[0].status, reused: `${reused.status} ${reused.json?.code}` });

  // Kill the worker at different moments around the POST to the provider.
  const killLog = [];
  for (const delay of [20, 60, 100, 150, 200, 300, 400, 500]) {
    const orders = await paidCompleted(10);
    // Not awaited first: the kill has to land while the worker is still sending these.
    const fired = orders.flatMap((o) => Array.from({ length: 6 }, (_, i) => refund(session(i), o.order_id, 5000)));
    await sleep(delay);
    await dockerKill('worker');
    const replies = await Promise.all(fired);
    const list = orders.map((o) => o.order_id);
    const [{ settled, pending }] = await q(`SELECT count(*) FILTER (WHERE status='SUCCEEDED')::int settled, count(*) FILTER (WHERE status='PENDING')::int pending FROM refunds WHERE order_id = ANY(${ids(list)})`);
    const atProvider = (await settlementRows()).rows.filter((r) => r.type === 'payment.refunded' && list.includes(r.order_id)).length;
    await sleep(1500); // Let webhooks for what did reach the provider arrive while the worker is down.
    await dockerStart('worker');
    killLog.push({ delay, accepted: replies.filter((r) => r.status === 202).length, settled_at_kill: settled, pending_at_kill: pending, at_provider_at_kill: atProvider });
  }
  check('s3/kill-ran', 3, 'worker killed 8 times while it was sending 60 refunds of one amount', killLog.filter((k2) => k2.pending_at_kill > 0 && k2.at_provider_at_kill > 0).length >= 2, killLog);
  await waitFor('refund jobs after kills', async () => (await q(`SELECT count(*)::int n FROM outbox WHERE processed_at IS NULL`))[0].n === 0, 180_000, 1000);
  await sleep(4000);
  await auditMoney('s3/kill');
  const stuckRows = await q(`SELECT r.order_id, r.id, r.status, r.amount_satang, r.provider_event_id IS NOT NULL has_event,
      (SELECT count(*)::int FROM outbox j WHERE j.payload->>'refund_id' = r.id::text AND j.processed_at IS NULL) open_jobs,
      (SELECT last_error FROM outbox j WHERE j.payload->>'refund_id' = r.id::text LIMIT 1) job_note,
      (SELECT count(*)::int FROM dead_letters d WHERE d.aggregate_id = r.order_id) dead_letters
    FROM refunds r WHERE r.status='PENDING' ORDER BY r.id`);
  if (stuckRows.length) note(`PENDING refunds after every job closed, with no synthetic step: ${JSON.stringify(stuckRows.slice(0, 3))} (total ${stuckRows.length})`);

  // Every other button on the checkout page, so the settlement file holds each kind of row.
  const dupe = await mustBuy({ mail: email('var'), items: [{ sku: D1000, qty: 1 }] });
  await pay(dupe.order_id, dupe.total_satang, 'duplicate_webhook');
  const flashHeld = await flashState();
  const mismatch = await mustBuy({ mail: email('var'), items: [{ sku: FLASH, qty: 1 }] });
  await pay(mismatch.order_id, mismatch.total_satang, 'amount_mismatch');
  const failedThenPaid = await mustBuy({ mail: email('var'), items: [{ sku: D1000, qty: 1 }] });
  await pay(failedThenPaid.order_id, failedThenPaid.total_satang, 'failed');
  await waitStatus([failedThenPaid.order_id], ['PAYMENT_FAILED']);
  await pay(failedThenPaid.order_id, failedThenPaid.total_satang);
  const reinstated = await mustBuy({ mail: email('var'), items: [{ sku: D1000, qty: 1 }] });
  await expireNow([reinstated.order_id]);
  await waitStatus([reinstated.order_id], ['EXPIRED']);
  await pay(reinstated.order_id, reinstated.total_satang);
  await waitStatus([dupe.order_id, reinstated.order_id], ['COMPLETED']);
  await waitStatus([mismatch.order_id, failedThenPaid.order_id], ['NEEDS_REVIEW']);
  const [mm] = await statusOf([mismatch.order_id]);
  const reviewRefunds = await Promise.all([refund(s1, mismatch.order_id, mm.paid_satang), refund(s2, mismatch.order_id, mm.paid_satang), refund(s1, failedThenPaid.order_id, failedThenPaid.total_satang), refund(s2, failedThenPaid.order_id, failedThenPaid.total_satang)]);
  await waitStatus([mismatch.order_id, failedThenPaid.order_id], ['REFUNDED']);
  const flashAfter = await flashState();
  check('s3/review-refund-returns-stock', 1, 'amount_mismatch order (never queued) refunded in full twice at once: FLASH stock+active back to 100', flashAfter.stock + flashAfter.active === flashHeld.stock + flashHeld.active && flashAfter.stock + flashAfter.active === 100, { before: flashHeld, after: flashAfter });
  log(`review refunds ${JSON.stringify(tally(reviewRefunds))}`);

  // Paid only by a webhook signed here, as the review team does, so mock-pay never saw the payment.
  const signed = await mustBuy({ mail: email('signed'), items: [{ sku: D1000, qty: 1 }] });
  const signedPay = await webhook(mkEvent('payment.succeeded', signed.order_id, signed.total_satang));
  await waitStatus([signed.order_id], ['COMPLETED']);
  const signedReplies = await Promise.all(Array.from({ length: 24 }, (_, i) => refund(session(i), signed.order_id, 5000)));
  await waitFor('signed-webhook refunds to finish', async () => (await q(`SELECT count(*)::int n FROM refunds WHERE order_id='${signed.order_id}' AND status='PENDING'`))[0].n === 0, 90_000, 500);
  await sleep(3000);
  const signedRows = await q(`SELECT status, count(*)::int n, coalesce(sum(amount_satang),0)::bigint s FROM refunds WHERE order_id='${signed.order_id}' GROUP BY 1`);
  const [signedOrder] = await statusOf([signed.order_id]);
  const signedCsv = (await settlementRows()).rows.filter((r) => r.order_id === signed.order_id);
  const signedProvider = {
    paid: signedCsv.filter((r) => r.type === 'payment.succeeded').reduce((a, r) => a + r.amount_satang, 0),
    refunded: signedCsv.filter((r) => r.type === 'payment.refunded').reduce((a, r) => a + r.amount_satang, 0),
  };
  const signedAccepted = signedReplies.filter((r) => r.status === 202).length;
  const signedSettled = signedRows.find((r) => r.status === 'SUCCEEDED')?.s ?? 0;
  check('s3/signed-webhook-refund', 3, 'order paid only by a self-signed webhook, 24 concurrent 5000 refunds on 34900: at most 6 accepted, all settled, DB equals mock-pay', signedPay.status === 200 && signedAccepted <= 6 && signedAccepted === 6 && !signedRows.some((r) => r.status === 'FAILED') && signedSettled === signedProvider.refunded && signedProvider.paid === T && signedProvider.refunded <= signedProvider.paid && signedOrder.status === 'COMPLETED', {
    webhook: signedPay.status, replies: tally(signedReplies), rows: signedRows, order: signedOrder, provider: signedProvider,
  });

  // payment.refunded replayed with the provider's own event ids.
  await sleep(3000);
  const { rows: csvRows } = await settlementRows();
  const refundRows = csvRows.filter((r) => r.type === 'payment.refunded').slice(0, 15);
  const before = await q(`SELECT sum(amount_satang)::bigint s FROM refunds WHERE status='SUCCEEDED'`);
  const replays = await Promise.all(refundRows.flatMap((r) => Array.from({ length: 5 }, () => webhook({ event_id: r.event_id, type: r.type, order_id: r.order_id, amount_satang: r.amount_satang, currency: 'THB', occurred_at: r.settled_at }))));
  const after = await q(`SELECT sum(amount_satang)::bigint s FROM refunds WHERE status='SUCCEEDED'`);
  check('s3/webhook-replay', 3, '15 payment.refunded events replayed 5 times each at once', before[0].s === after[0].s && replays.every((r) => r.status === 200), { settled_before: before[0].s, settled_after: after[0].s, outcomes: [...new Set(replays.map((r) => `${r.status}:${r.json?.outcome}`))] });

  await waitDrained();
  await auditMoney('s3/all');
  await auditGame('s3');
  await auditEvents('s3');

  // ---------- 5. Reconciliation ----------
  const { csv, rows: all } = await settlementRows();
  const rec = await http('POST', `${API}/api/v1/admin/reconciliation`, { headers: { Cookie: s1, 'Content-Type': 'text/csv' }, body: csv });
  const owed = (await q(`SELECT count(*)::int rows, coalesce(sum(amount_satang),0)::bigint satang FROM refunds WHERE status='PENDING'`))[0];
  check('s5/clean', 5, 'POST /admin/reconciliation with the whole, unfiltered mock-pay CSV', rec.status === 200 && rec.json.mismatches.length === 0, { status: rec.status, rows: rec.json?.rows, csv_rows: all.length, counts: rec.json?.counts, first: rec.json?.mismatches?.slice(0, 3), pending_refunds_not_reported: owed });

  // Deliberate differences must be caught, or a clean run above proves nothing.
  const [victim] = await paidCompleted(1);
  await http('POST', `${PAY}/refunds`, { headers: jsonHeaders, body: JSON.stringify({ refund_id: `rf_audit_${randomUUID()}`, order_id: victim.order_id, amount_satang: 1234 }) });
  await sleep(2500);
  const [victimRow] = await statusOf([victim.order_id]);
  const tampered = (await settlementRows()).csv;
  const lines = tampered.trim().split('\n');
  const paidLine = lines.findIndex((l) => l.includes(',payment.succeeded,') && !l.includes(victim.order_id));
  lines[paidLine] = lines[paidLine].replace(/,(\d+),/, (_, a) => `,${Number(a) + 1},`);
  const rec2 = await http('POST', `${API}/api/v1/admin/reconciliation`, { headers: { Cookie: s1, 'Content-Type': 'text/csv' }, body: `${lines.join('\n')}\n` });
  const types = rec2.json?.counts ?? {};
  const caughtRefund = rec2.json?.mismatches?.some((m) => m.order_id === victim.order_id);
  check('s5/detects', 5, 'a refund made only at the provider and a CSV amount changed by 1 satang are both reported', caughtRefund && types.AMOUNT_MISMATCH >= 1, { counts: types, provider_only_refund_reported: caughtRefund, order_after: victimRow.status, db_refunded: victimRow.refunded_satang });

  // Refund rows with one amount, when the provider got the later row first. The audit plays the
  // part of a worker that sent row B and died, and restarts the real worker afterwards.
  const [twin] = await paidCompleted(1);
  await dockerKill('worker');
  const r2a = await refund(s1, twin.order_id, 5000);
  const r2b = await refund(s2, twin.order_id, 5000);
  const twinRows = await q(`SELECT id, refund_ref FROM refunds WHERE order_id='${twin.order_id}' ORDER BY id`);
  const post = await http('POST', `${PAY}/refunds`, { headers: jsonHeaders, body: JSON.stringify({ refund_id: twinRows[1].refund_ref, order_id: twin.order_id, amount_satang: 5000 }) });
  await waitFor('webhook to settle one row', async () => (await q(`SELECT count(*)::int n FROM refunds WHERE order_id='${twin.order_id}' AND status='SUCCEEDED'`))[0].n === 1, 15_000);
  await dockerStart('worker');
  await waitFor('refund jobs after restart', async () => (await q(`SELECT count(*)::int n FROM outbox WHERE processed_at IS NULL`))[0].n === 0, 60_000, 500);
  await sleep(4000);
  const finalRows = await q(`SELECT id, status, amount_satang, provider_event_id IS NOT NULL has_event FROM refunds WHERE order_id='${twin.order_id}' ORDER BY id`);
  const providerSum = (await settlementRows()).rows.filter((r) => r.order_id === twin.order_id && r.type === 'payment.refunded').reduce((s, r) => s + r.amount_satang, 0);
  const dbSettled = finalRows.filter((r) => r.status === 'SUCCEEDED').reduce((s, r) => s + r.amount_satang, 0);
  const stuck = finalRows.filter((r) => r.status === 'PENDING');
  const rec3 = await http('POST', `${API}/api/v1/admin/reconciliation`, { headers: { Cookie: s1, 'Content-Type': 'text/csv' }, body: (await settlementRows()).csv });
  check('s3/same-amount-order', 5, 'two 5000 refunds, provider receives the second row first, worker restarted: both rows finish and match the provider', stuck.length === 0 && dbSettled === providerSum && providerSum === 10000, {
    accepted: [r2a.status, r2b.status], provider_post: post.status, rows: finalRows, db_settled: dbSettled, provider_refunded: providerSum, reconciliation_flags_this_order: rec3.json?.mismatches?.filter((m) => m.order_id === twin.order_id).length,
  });
}

// ---------- 4. Vouchers ----------

const voucherBuyer = (mail) => ({ mail, voucher: 'SAVE10', items: [{ sku: D1000, qty: 1 }] });

async function s4() {
  await reset();
  const r1 = await Promise.all(Array.from({ length: 150 }, () => buy(voucherBuyer(email('v')))));
  const v1 = await voucherState();
  const won1 = r1.filter((r) => r.status === 201).length;
  const stray = r1.filter((r) => r.status !== 201 && r.json?.code !== 'VOUCHER_EXHAUSTED');
  check('s4/global', 4, '150 concurrent SAVE10 from different emails (15 times the limit)', won1 === 10 && v1.used === 10 && v1.open === 10 && stray.length === 0, { replies: tally(r1), replicas: instances(r1), ...v1 });

  await reset();
  const a = email('v');
  const r2 = await Promise.all(Array.from({ length: 40 }, (_, i) => buy(voucherBuyer(shuffleCase(a, i)))));
  const v2 = await voucherState();
  const won2 = r2.filter((r) => r.status === 201).length;
  check('s4/per-email', 4, '40 concurrent SAVE10 from one email in mixed case', won2 === 1 && v2.open === 1 && v2.used === 1, { replies: tally(r2), ...v2 });

  // Giving uses back while others take them.
  await reset();
  const held = await inPool(Array.from({ length: 10 }, () => voucherBuyer(email('v'))), 10, mustBuy);
  const stop = sampler(voucherState);
  const expiring = held.slice(0, 5).map((o) => o.order_id);
  await expireNow(expiring);
  const hooks = held.slice(3, 8).flatMap((o) => Array.from({ length: 4 }, () => webhook(mkEvent('payment.failed', o.order_id, o.total_satang))));
  const buyers = [];
  for (let wave = 0; wave < 8; wave += 1) {
    buyers.push(...Array.from({ length: 15 }, () => buy(voucherBuyer(email('v')))));
    await sleep(1000);
  }
  await Promise.all(hooks);
  const r3 = await Promise.all(buyers);
  await waitStatus(held.slice(0, 8).map((o) => o.order_id), ['EXPIRED', 'PAYMENT_FAILED']);
  const samples = await stop();
  const v3 = await voucherState();
  check('s4/release', 4, 'expiry and repeated payment.failed give uses back (2 orders got both) while 120 buyers arrive', Math.max(...samples.map((s) => s.used)) <= 10 && Math.min(...samples.map((s) => s.used)) >= 0 && v3.used === v3.open && v3.open === v3.holding && v3.used <= 10, {
    samples: samples.length, max_used: Math.max(...samples.map((s) => s.used)), max_open: Math.max(...samples.map((s) => s.open)), replies: tally(r3), ...v3,
  });

  // Late payments on expired voucher orders, racing new buyers for the same uses.
  await reset();
  const late = await inPool(Array.from({ length: 10 }, () => voucherBuyer(email('v'))), 10, mustBuy);
  await expireNow(late.map((o) => o.order_id));
  await waitStatus(late.map((o) => o.order_id), ['EXPIRED']);
  const stop2 = sampler(voucherState);
  const raced = await Promise.all([
    ...late.map((o) => pay(o.order_id, o.total_satang).then(() => ({ status: 200 }))),
    // Spread over mock-pay's 250 ms delivery tick, so both sides of the race get to win.
    ...Array.from({ length: 40 }, (_, i) => sleep(i * 12).then(() => buy(voucherBuyer(email('v'))))),
  ]);
  const lateIds = late.map((o) => o.order_id);
  await waitStatus(lateIds, ['COMPLETED', 'REFUNDED'], 90_000);
  const samples2 = await stop2();
  const v4 = await voucherState();
  const lateFinal = await statusOf(lateIds);
  const lateCounts = lateFinal.reduce((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {});
  check('s4/late-pay', 4, '10 late payments race 40 buyers for 10 uses: every late order is reinstated or refunded', Math.max(...samples2.map((s) => s.used)) <= 10 && v4.used === v4.open && v4.used <= 10, { late_orders: lateCounts, new_buyers: tally(raced.slice(10)), max_used: Math.max(...samples2.map((s) => s.used)), ...v4 });
  await auditMoney('s4', { orderIds: lateIds });
  await auditEvents('s4/late');

  // A late payment while a use is free: the released redemption row and the new one must coexist.
  await reset();
  const back = await mustBuy(voucherBuyer(email('v')));
  await expireNow([back.order_id]);
  await waitStatus([back.order_id], ['EXPIRED']);
  const v5 = await voucherState();
  await pay(back.order_id, back.total_satang);
  await waitStatus([back.order_id], ['COMPLETED', 'REFUNDED', 'NEEDS_REVIEW'], 30_000);
  const [backRow] = await statusOf([back.order_id]);
  const v6 = await voucherState();
  check('s4/reinstate', 4, 'late payment with a free use: reinstated, the use taken once again', backRow.status === 'COMPLETED' && v5.used === 0 && v6.used === 1 && v6.open === 1, { order: backRow.status, after_expiry: v5, after_payment: v6 });
  await auditMoney('s4/reinstate', { orderIds: [back.order_id] });
}

// ---------- 7. Chaos: api-1 and Redis down during the same scenarios ----------

async function s7() {
  await reset();
  await setGame({ SUCCESS_BUT_TIMEOUT_RATE: 0.2 });
  const [s1, s2] = [await login(), await login()];
  const plan = [...flashBuyers(400), ...Array.from({ length: 100 }, () => voucherBuyer(email('v')))].sort(() => Math.random() - 0.5);
  const bodies = plan.map((p) => ({ key: key(), body: orderBody(p) }));
  const fire = (list) => list.map((b) => postOrder(b.body, b.key));

  // The kills land while requests are in flight, in the waves that decide who gets the stock.
  const first = [...(await Promise.all(fire(bodies.slice(0, 10))))];
  const wave2 = fire(bodies.slice(10, 300));
  await sleep(50);
  await dockerKill('api-1');
  first.push(...(await Promise.all(wave2)));
  const killRedis = dockerKill('redis');
  const wave3 = fire(bodies.slice(300));
  await killRedis;
  first.push(...(await Promise.all(wave3)));
  await sleep(1000);
  note(`docker kill leaves these down until docker start, under restart policy unless-stopped: api-1 "${await containerState('api-1')}", redis "${await containerState('redis')}"`);
  const stateMid = await flashState();
  const voucherMid = await voucherState();
  check('s7/orders-under-kill', 1, '500 orders, api-1 then Redis killed during bursts', stateMid.stock >= 0 && stateMid.stock + stateMid.active === 100 && voucherMid.used <= 10 && voucherMid.used === voucherMid.open, { replies: tally(first), replicas: instances(first), ...stateMid, voucher: voucherMid });

  const ready = await http('GET', `${API}/readyz`);
  check('s7/readyz-down', 'spec 8.1', 'GET /readyz answers 503 while Redis is down', ready.status === 503, { status: ready.status, code: ready.json?.code });

  await dockerStart('api-1');
  await waitHealthy('api-1');

  // A client with no clear answer retries with its own key, as the idempotency contract says.
  const finalBy = new Map(first.map((r) => [r.key, r]));
  const unclear = (r) => r.status === 0 || r.status >= 500;
  const unclearAtFirst = first.filter(unclear).length;
  const retryUnclear = async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const todo = [...finalBy.values()].filter(unclear);
      if (!todo.length) break;
      (await inPool(todo, 50, (r) => postOrder(r.body, r.key))).forEach((r) => finalBy.set(r.key, r));
      await sleep(1500);
    }
  };
  await retryUnclear();

  // Reopen stock and uses while Redis is down, so the outage also sees real contention.
  const flashWon = [...finalBy.values()].filter((r) => r.status === 201 && !r.json.voucher_code);
  const voucherWon = [...finalBy.values()].filter((r) => r.status === 201 && r.json.voucher_code);
  const reopened = [...flashWon.slice(0, 15), ...voucherWon.slice(0, 4)].map((r) => r.json.order_id);
  await expireNow(reopened);
  await waitStatus(reopened, ['EXPIRED']);
  const contested = [...flashBuyers(150), ...Array.from({ length: 60 }, () => voucherBuyer(email('v')))].map((p) => ({ key: key(), body: orderBody(p) }));
  const stopFlash = sampler(flashState);
  (await Promise.all(fire(contested))).forEach((r) => finalBy.set(r.key, r));
  await retryUnclear();
  const samples = await stopFlash();
  const stateOrders = await flashState();
  const voucherOrders = await voucherState();
  const finals = [...finalBy.values()];
  const won = finals.filter((r) => r.status === 201);
  const dbOrders = (await q('SELECT count(*)::int n FROM orders'))[0].n;
  check('s7/retries', 1, 'every unclear reply retried with the same key: exactly one order per winning key, no unclear reply left', dbOrders === won.length && finals.every((r) => !unclear(r)), { unclear_before_retry: unclearAtFirst, final_replies: tally(finals), orders_in_db: dbOrders });
  check('s7/stock-redis-down', 1, '210 buyers contest stock and uses reopened by expiry, Redis down', Math.max(...samples.map((x) => x.stock + x.active)) <= 100 && stateOrders.stock >= 0 && stateOrders.stock + stateOrders.active === 100, { samples: samples.length, max_stock_plus_active: Math.max(...samples.map((x) => x.stock + x.active)), ...stateOrders });
  check('s7/voucher', 4, 'SAVE10 after the kills and the contest, Redis down', voucherOrders.used <= 10 && voucherOrders.used === voucherOrders.open, voucherOrders);

  const stillHeld = won.filter((r) => !reopened.includes(r.json.order_id));
  const sample = stillHeld.slice(0, 40);
  const replay = await inPool(sample, 20, (r) => postOrder(r.body, r.key));
  const sameBytes = replay.every((r, i) => r.status === 201 && r.text === sample[i].text);
  check('s7/replay', 1, '40 keys replayed after the kills give the first reply byte for byte, Redis down', sameBytes && (await q('SELECT count(*)::int n FROM orders'))[0].n === dbOrders, { all_identical: sameBytes });

  // Paying, top-ups and refunds with Redis still down, and one more worker kill.
  await inPool(stillHeld, 30, (r) => pay(r.json.order_id, r.json.total_satang));
  await sleep(1500);
  const busyAtKill = (await q("SELECT count(*)::int n FROM orders WHERE status IN ('PAID','IN_QUEUE','IN_PROGRESS')"))[0].n;
  await dockerKill('worker');
  await sleep(3000);
  await dockerStart('worker');
  await waitDrained(300_000);
  log(`orders in flight at the worker kill: ${busyAtKill}`);
  await auditGame('s7');
  await auditDelivery('s7');
  const victims = stillHeld.filter((r) => r.json.voucher_code).slice(0, 5).map((r) => r.json);
  const refundReplies = await Promise.all(victims.flatMap((o) => [refund(s1, o.order_id, o.total_satang), refund(s2, o.order_id, o.total_satang), refund(s1, o.order_id, 5000), refund(s2, o.order_id, 5000)]));
  await waitDrained(120_000);
  await sleep(3000);
  const acceptedBy = {};
  for (const r of refundReplies.filter((x) => x.status === 202)) acceptedBy[r.json.order_id] = (acceptedBy[r.json.order_id] ?? 0) + r.amount;
  const within = victims.every((o) => (acceptedBy[o.order_id] ?? 0) <= o.total_satang);
  check('s7/refund-redis-down', 3, 'refund race by 2 finance sessions with Redis down', within && refundReplies.some((r) => r.status === 202), { replies: tally(refundReplies), total_each: victims[0]?.total_satang, accepted: Object.values(acceptedBy) });
  await auditMoney('s7/redis-down');
  const statesFinal = await flashState();
  check('s7/final-stock', 1, 'stock after payment and fulfillment', statesFinal.stock >= 0 && statesFinal.stock + statesFinal.active === 100, { ...statesFinal, statuses: await statusTally() });

  await dockerStart('redis');
  await waitHealthy('redis');
  if (ready.status === 503) {
    const readyAgain = await waitFor('/readyz 200', async () => (await http('GET', `${API}/readyz`)).status === 200, 30_000).catch(() => false);
    check('s7/readyz-up', 'spec 8.1', 'GET /readyz returns to 200 after Redis comes back', readyAgain === true, { ok: readyAgain });
  }
  const afterRedis = await mustBuy({ mail: email('after'), items: [{ sku: D1000, qty: 1 }] });
  await pay(afterRedis.order_id, afterRedis.total_satang);
  await waitStatus([afterRedis.order_id], ['COMPLETED']);
  check('s7/after-redis', 7, 'a new order completes after Redis returned', true, 'COMPLETED');
  await auditEvents('s7');
  await setGame({});
}

/** Does the proxy reach a replica again after docker kill and docker start, with nothing else done? */
async function s8() {
  const spreadAfter = async (waitMs) => {
    const end = Date.now() + waitMs;
    let seen = {};
    while (Date.now() < end) {
      seen = instances(await Promise.all(Array.from({ length: 20 }, () => http('GET', `${API}/healthz`))));
      if (Object.keys(seen).length === 2) return seen;
      await sleep(2000);
    }
    return seen;
  };
  const ipOf = async (name) => (await run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', `inblack-${name}`])).out.trim();
  const restartProxy = async () => {
    await run('docker', ['restart', 'inblack-proxy']);
    await waitHealthy('proxy');
  };
  await restartProxy();

  const before = await ipOf('api-1');
  await dockerKill('api-1');
  await sleep(1000);
  await dockerStart('api-1');
  await waitHealthy('api-1');
  const one = await spreadAfter(45_000);
  check('s8/one-replica', 'spec 3', 'docker kill api-1, docker start api-1, up to 45s: nginx reaches both replicas', Object.keys(one).length === 2, { replicas: one, ip_before: before, ip_after: await ipOf('api-1') });
  await restartProxy();

  // Another container taking the freed address is what moves a replica, as a chaos run does.
  const ip2 = await ipOf('api-1');
  await dockerKill('api-1');
  await dockerKill('redis');
  await dockerStart('redis');
  await dockerStart('api-1');
  await waitHealthy('api-1');
  await waitHealthy('redis');
  const moved = await spreadAfter(45_000);
  check('s8/after-redis-kill', 'spec 3', 'api-1 and Redis killed, Redis started first, up to 45s: nginx reaches both replicas', Object.keys(moved).length === 2, { replicas: moved, ip_before: ip2, ip_after: await ipOf('api-1'), redis_ip: await ipOf('redis') });
  await restartProxy();

  await dockerKill('api-1');
  await dockerKill('api-2');
  await dockerKill('redis');
  await dockerStart('redis');
  await dockerStart('api-2');
  await dockerStart('api-1');
  await waitHealthy('api-1');
  await waitHealthy('api-2');
  const both = await spreadAfter(45_000);
  const probe = await http('GET', `${API}/api/v1/products`);
  check('s8/both-replicas', 'spec 3', 'both replicas and Redis killed then started, up to 45s: the API answers through nginx', probe.status === 200 && Object.keys(both).length >= 1, { replicas: both, products_status: probe.status, products_code: probe.json?.code });
  await restartProxy();
}

// ---------- Run ----------

const phases = { s1a, s1b, s1c, s1d, s2a, s2b, s3, s4, s7, s8 };
// s3 runs its own event audit before it adds its deliberate differences.
const EVENT_AUDIT = new Set(['s1a', 's1b', 's1c', 's1d', 's2a', 's2b', 's4']);

async function bringUpFromClean() {
  const others = await run('docker', ['ps', '-a', '--filter', 'name=inblack-', '--format', '{{.Names}} {{.Label "com.docker.compose.project"}}']);
  const foreign = others.out.split('\n').filter((l) => l.trim() && !l.endsWith(` ${PROJECT}`));
  if (foreign.length) throw new Error(`containers from elsewhere use the fixed inblack-* names, stop them first:\n${foreign.join('\n')}`);

  const clone = spawnSync('git', ['clone', '-q', REPO, CLONE], { encoding: 'utf8' });
  if (clone.status !== 0) throw new Error(`git clone: ${clone.stderr}`);
  const co = spawnSync('git', ['-C', CLONE, 'checkout', '-q', COMMIT], { encoding: 'utf8' });
  if (co.status !== 0) throw new Error(`git checkout: ${co.stderr}`);
  const sha = spawnSync('git', ['-C', CLONE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const hasEnv = fs.existsSync(path.join(CLONE, '.env'));
  log(`clone at ${sha} in ${CLONE}, .env present: ${hasEnv}`);

  const started = Date.now();
  const up = await compose(['up', '--build', '-d', '--wait'], { withOverride: false, timeoutMs: 1_500_000 });
  fs.writeFileSync(path.join(WORK, 'compose-up.log'), up.out + up.err);
  check('s0/clean-up', 'gate', `docker compose up --build -d --wait, clean clone of ${sha}, no .env, project ${PROJECT}`, up.code === 0 && !hasEnv, { exit_code: up.code, seconds: Math.round((Date.now() - started) / 1000), ps: (await compose(['ps', '-a', '--format', '{{.Service}}={{.State}}'], { withOverride: false })).out.trim().split('\n').join(' ') });
  if (up.code !== 0) throw new Error(`compose up failed, see ${path.join(WORK, 'compose-up.log')}\n${up.err.slice(-2000)}`);
  const resetOff = await http('POST', `${API}/api/v1/_test/reset`);
  check('s0/reset-off', 'gate', 'POST /_test/reset without APP_ENV=test', resetOff.status === 404, { status: resetOff.status });
}

let exitCode = 0;
try {
  if (!REUSE) await bringUpFromClean();
  writeOverride({});
  const up2 = await compose(['up', '-d', '--wait']);
  if (up2.code !== 0) throw new Error(`could not switch to APP_ENV=test: ${up2.err.slice(-2000)}`);
  // up -d recreates the API containers, and nginx resolved their names once at its own start.
  const stale = instances(await Promise.all(Array.from({ length: 20 }, () => http('GET', `${API}/healthz`))));
  if (Object.keys(stale).length < 2) note(`nginx keeps stale upstream IPs after the API containers are recreated: 20 requests reached only ${JSON.stringify(stale)} until the proxy restarted`);
  await run('docker', ['restart', 'inblack-proxy']);
  await waitHealthy('proxy');
  const spread = instances(await Promise.all(Array.from({ length: 20 }, () => http('GET', `${API}/healthz`))));
  if (Object.keys(spread).length < 2) throw new Error(`proxy reaches only ${JSON.stringify(spread)}, this audit needs both replicas`);
  await reset();

  for (const [name, fn] of Object.entries(phases)) {
    if (ONLY && !ONLY.includes(name)) continue;
    console.log(`\n=== ${name} ===`);
    try {
      await fn();
      if (EVENT_AUDIT.has(name)) {
        await waitDrained().catch(() => undefined);
        await auditEvents(name);
      }
    } catch (error) {
      check(`${name}/aborted`, '-', 'scenario ran to the end', false, error.stack ?? String(error));
      // Later scenarios need these up, and an aborted one may have left them down.
      for (const c of ['worker', 'redis', 'api-1']) await dockerStart(c).catch(() => undefined);
    }
  }
} catch (error) {
  console.error(`AUDIT COULD NOT RUN: ${error.stack ?? error}`);
  exitCode = 2;
} finally {
  if (KEEP || REUSE) {
    log(`left running: project ${PROJECT}, clone ${CLONE}`);
  } else {
    const down = await compose(['down', '-v', '--remove-orphans'], { withOverride: false });
    log(`compose down -v exit ${down.code}`);
    try {
      fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5 });
      log(`removed ${WORK}`);
    } catch (error) {
      log(`could not remove ${WORK}: ${error.message}`);
    }
  }
}

const failed = results.filter((r) => !r.pass);
console.log('\n## Invariant audit summary\n');
console.log('| Check | Invariant | Method | Result | Evidence |\n|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.id} | ${r.invariant} | ${r.method} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.evidence.replaceAll('|', '/').slice(0, 400)} |`);
if (notes.length) console.log(`\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (exitCode === 0 && failed.length > 0) exitCode = 1;
process.exit(exitCode);
