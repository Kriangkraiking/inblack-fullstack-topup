#!/usr/bin/env node
// Security audit for SPEC 8.4, 8.5 and 8.1 (OTP, rate limits, IDOR, CSRF, PII masking, cursor
// pagination, headers), with real requests against a running compose stack. Node built-ins only.
//
//   node scripts/audit/security.mjs [--api http://127.0.0.1:8080] [--mailpit http://127.0.0.1:8025]
//
// Facts come from the HTTP answers, mailpit's API and Postgres (docker exec psql). The track
// timing check runs inside inblack-api-1, straight at the replica, with one made-up X-Real-IP per
// request, because 10 requests a minute from this machine's IP is too few to measure a median.
// The rate limit checks then go through nginx from this machine, which proves nginx's address
// is the one counted. They wait for a fresh window first, which can take up to a minute.
//
// Exit code: 0 all checks passed, 1 a check failed, 2 the audit could not run.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const API = opt('api', 'http://127.0.0.1:8080');
const MAIL = opt('mailpit', 'http://127.0.0.1:8025');
// The compose default of CSRF_ALLOWED_ORIGINS includes this.
const GOOD_ORIGIN = 'http://localhost:8080';
const EVIL_ORIGIN = 'https://evil.example';
const PG = 'inblack-postgres';
const REPLICA = 'inblack-api-1';
const RUN = randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const email = (tag) => `${tag}-${RUN}-${(seq += 1)}@audit.test`;

const results = [];
function check(id, what, pass, evidence) {
  results.push({ id, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${what} :: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
}
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// ---------- helpers ----------

async function http(method, path, { headers = {}, body, base = API } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json, headers: res.headers, setCookie: res.headers.getSetCookie?.() ?? [] };
}
const jsonBody = () => ({ 'Content-Type': 'application/json' });
const post = (path, value, headers = {}) => http('POST', path, { headers: { ...jsonBody(), ...headers }, body: JSON.stringify(value) });

function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', PG, 'psql', '-U', 'inblack_user', '-d', 'inblack_topup', '-At', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A valid order id (checksum included) that no order has. */
function unknownOrderId() {
  for (;;) {
    const digits = String(randomInt(1e12, 1e13 - 1)).padStart(13, '0');
    const id = `ORD-${digits}-${String(Number(BigInt(digits) % 997n)).padStart(3, '0')}`;
    if (psql(`SELECT count(*) FROM orders WHERE id = '${id}'`) === '0') return id;
  }
}

async function createOrder(buyer) {
  const r = await post(
    '/api/v1/orders',
    { email: buyer, game_uid: `secPlayer${seq}`, payment_method: 'PROMPTPAY', voucher_code: null, items: [{ sku: 'DIAMOND-1000', qty: 1 }] },
    { 'Idempotency-Key': `sec-${randomUUID()}` },
  );
  if (r.status !== 201) throw new Error(`create order: ${r.status} ${r.text}`);
  return r.json.order_id;
}

/** Every address in a run asks for one code, so the newest email to it is the one. */
async function readCode(address) {
  for (let i = 0; i < 40; i += 1) {
    const list = await http('GET', '/api/v1/messages?limit=100', { base: MAIL });
    const hit = (list.json?.messages ?? []).find(
      (m) => m.To?.some((t) => t.Address === address),
    );
    if (hit) {
      const full = await http('GET', `/api/v1/message/${hit.ID}`, { base: MAIL });
      const code = /\b(\d{6})\b/.exec(full.json?.Text ?? '')?.[1];
      if (code) return code;
    }
    await sleep(250);
  }
  throw new Error(`no OTP email for ${address} in mailpit`);
}

async function signIn(address) {
  const r = await post('/api/v1/auth/otp/request', { email: address });
  if (r.status !== 202) throw new Error(`otp request: ${r.status} ${r.text}`);
  const code = await readCode(address);
  const v = await post('/api/v1/auth/otp/verify', { email: address, code });
  if (v.status !== 200) throw new Error(`otp verify: ${v.status} ${v.text}`);
  return { cookie: v.setCookie[0].split(';')[0], setCookie: v.setCookie[0], code };
}

async function adminLogin(role) {
  const cap = role[0].toUpperCase() + role.slice(1);
  const r = await post('/api/v1/admin/auth/login', { email: `${role}@inblackm.test`, password: `${cap}-Test-2026` });
  if (r.status !== 200) throw new Error(`admin login ${role}: ${r.status} ${r.text}`);
  return r.setCookie[0].split(';')[0];
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ---------- checks ----------

async function headers() {
  const want = {
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  for (const path of ['/api/v1/products', '/api/v1/no-such-route', '/healthz']) {
    const r = await http('GET', path);
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, r.headers.get(k)]));
    const hsts = r.headers.get('strict-transport-security') ?? '';
    const pass = Object.entries(want).every(([k, v]) => got[k] === v) && /max-age=\d{7,}/.test(hsts);
    check('headers', `security headers on ${path} (${r.status})`, pass, { ...got, hsts });
  }
}

async function otp(ctx) {
  // The answer does not depend on whether the address has orders.
  const withOrders = ctx.b;
  const fresh = email('nobody');
  const r1 = await post('/api/v1/auth/otp/request', { email: withOrders });
  const r2 = await post('/api/v1/auth/otp/request', { email: fresh });
  check('otp/request-same', 'OTP request answers the same for an address with orders and one without', r1.status === 202 && r1.status === r2.status && r1.text === r2.text, { a: [r1.status, r1.text], b: [r2.status, r2.text] });

  // Full flow, with the code read from mailpit.
  const a = await signIn(ctx.a);
  ctx.aCookie = a.cookie;
  const flags = a.setCookie.toLowerCase();
  check('otp/cookie', 'session cookie is HttpOnly and SameSite=Strict', flags.includes('httponly') && flags.includes('samesite=strict') && flags.startsWith('inblack_session='), a.setCookie.replace(/=[^;]+/, '=<token>'));
  const me = await http('GET', '/api/v1/auth/me', { headers: { Cookie: a.cookie } });
  check('otp/me', 'GET /auth/me returns the signed-in email', me.status === 200 && me.json?.email === ctx.a, { status: me.status, body: me.json });

  const stored = psql(`SELECT code_hash FROM customer_otps WHERE email = '${ctx.a}'`);
  check('otp/hash-only', 'Postgres keeps a 64-hex HMAC, not the code', /^[0-9a-f]{64}$/.test(stored) && !stored.includes(a.code), stored.slice(0, 12) + '...');

  const reuse = await post('/api/v1/auth/otp/verify', { email: ctx.a, code: a.code });
  check('otp/reuse', 'a used code is refused', reuse.status === 401 && reuse.json?.code === 'OTP_INVALID', { status: reuse.status, code: reuse.json?.code });

  // Five wrong codes lock the email, after which the right code is refused too.
  const locked = email('lock');
  await post('/api/v1/auth/otp/request', { email: locked });
  const code = await readCode(locked);
  const wrong = code === '000000' ? '000001' : '000000';
  const answers = [];
  for (let i = 0; i < 5; i += 1) answers.push((await post('/api/v1/auth/otp/verify', { email: locked, code: wrong })).status);
  const after = await post('/api/v1/auth/otp/verify', { email: locked, code });
  const retry = Number(after.headers.get('retry-after'));
  check('otp/lock', '5 wrong codes, then the right one is locked out with Retry-After about 15 min', JSON.stringify(answers) === '[401,401,401,401,429]' && after.status === 429 && after.json?.code === 'OTP_LOCKED' && retry > 800 && retry <= 900, { answers, after: after.status, code: after.json?.code, retryAfter: retry });

  // Ten verifies at once with the right code: exactly one session.
  const racer = email('race');
  await post('/api/v1/auth/otp/request', { email: racer });
  const raceCode = await readCode(racer);
  const race = await Promise.all(Array.from({ length: 10 }, () => post('/api/v1/auth/otp/verify', { email: racer, code: raceCode })));
  const statuses = race.map((r) => r.status).sort();
  const sessions = Number(psql(`SELECT count(*) FROM customer_sessions WHERE email = '${racer}'`));
  check('otp/race', '10 concurrent verifies with the right code give one 200 and one session row', statuses.filter((s) => s === 200).length === 1 && statuses.filter((s) => s === 401).length === 9 && sessions === 1, { statuses, sessions });
}

async function idor(ctx) {
  const viewOwn = await http('GET', `/api/v1/orders/${ctx.aOrder}`, { headers: { Cookie: ctx.aCookie } });
  check('idor/own', 'customer A reads their own order with a timeline and no actor', viewOwn.status === 200 && viewOwn.json?.order_id === ctx.aOrder && Array.isArray(viewOwn.json?.timeline) && !viewOwn.text.includes('"actor"'), { status: viewOwn.status });
  const other = await http('GET', `/api/v1/orders/${ctx.bOrder}`, { headers: { Cookie: ctx.aCookie } });
  const missing = await http('GET', `/api/v1/orders/${unknownOrderId()}`, { headers: { Cookie: ctx.aCookie } });
  const anonymous = await http('GET', `/api/v1/orders/${ctx.bOrder}`);
  check('idor/other', "customer A asking for B's order gets the same 404 as an order that does not exist", other.status === 404 && other.text === missing.text && anonymous.text === missing.text, { other: [other.status, other.text], missing: [missing.status, missing.text], anonymous: anonymous.status });
  const mine = await http('GET', '/api/v1/me/orders?tab=current', { headers: { Cookie: ctx.aCookie } });
  const ids = (mine.json?.items ?? []).map((o) => o.order_id);
  check('idor/me-orders', '/me/orders lists A\'s orders only', mine.status === 200 && ids.includes(ctx.aOrder) && !ids.includes(ctx.bOrder), { status: mine.status, ids });
}

async function masking(ctx) {
  const viewer = await adminLogin('viewer');
  const support = await adminLogin('support');
  ctx.viewer = viewer;
  const q = encodeURIComponent(ctx.b);
  const asViewer = await http('GET', `/api/v1/admin/orders?q=${q}`, { headers: { Cookie: viewer } });
  const asSupport = await http('GET', `/api/v1/admin/orders?q=${q}`, { headers: { Cookie: support } });
  const v = asViewer.json?.items?.[0];
  const s = asSupport.json?.items?.[0];
  check('mask/list', 'admin list: viewer sees email and Game UID masked, support in full', v && s && v.order_id === ctx.bOrder && v.email !== ctx.b && v.email.includes('***') && !asViewer.text.includes(ctx.b) && v.game_uid.includes('*') && s.email === ctx.b && !s.game_uid.includes('*'), { viewer: v && [v.email, v.game_uid], support: s && [s.email, s.game_uid] });
  const dv = await http('GET', `/api/v1/admin/orders/${ctx.bOrder}`, { headers: { Cookie: viewer } });
  const ds = await http('GET', `/api/v1/admin/orders/${ctx.bOrder}`, { headers: { Cookie: support } });
  check('mask/detail', 'admin detail: masked for viewer, full for support, with timeline, webhooks, attempts and refunds', dv.status === 200 && !dv.text.includes(ctx.b) && ds.json?.email === ctx.b && ['timeline', 'webhooks', 'fulfillment_attempts', 'refunds'].every((k) => Array.isArray(ds.json?.[k])), { viewer: [dv.status, dv.json?.email], support: [ds.status, ds.json?.email] });
  const adminView = await http('GET', `/api/v1/orders/${ctx.bOrder}`, { headers: { Cookie: viewer } });
  check('mask/order-get', 'GET /orders/{id} as viewer admin: 200 and masked', adminView.status === 200 && !adminView.text.includes(ctx.b), { status: adminView.status, email: adminView.json?.email });
}

async function csrf(ctx) {
  const evil = await http('POST', '/api/v1/auth/logout', { headers: { Cookie: ctx.aCookie, Origin: EVIL_ORIGIN } });
  const none = await http('POST', '/api/v1/auth/logout', { headers: { Cookie: ctx.aCookie } });
  const still = await http('GET', '/api/v1/auth/me', { headers: { Cookie: ctx.aCookie } });
  check('csrf/customer', 'customer cookie POST from a foreign Origin, or none, gets 403 problem+json and changes nothing', evil.status === 403 && evil.json?.code === 'CSRF_ORIGIN_MISMATCH' && (evil.headers.get('content-type') ?? '').includes('application/problem+json') && none.status === 403 && still.status === 200, { evil: [evil.status, evil.json?.code], none: none.status, meAfter: still.status });

  const finance = await adminLogin('finance');
  const before = psql(`SELECT count(*) FROM refunds WHERE order_id = '${ctx.bOrder}'`);
  const forged = await post(`/api/v1/admin/orders/${ctx.bOrder}/refund`, { amount_satang: 1, reason: 'csrf audit' }, { Cookie: finance, Origin: EVIL_ORIGIN, 'Idempotency-Key': `sec-${randomUUID()}` });
  const after = psql(`SELECT count(*) FROM refunds WHERE order_id = '${ctx.bOrder}'`);
  check('csrf/admin', 'admin refund from a foreign Origin gets 403 and writes no refund', forged.status === 403 && forged.json?.code === 'CSRF_ORIGIN_MISMATCH' && before === after, { status: forged.status, code: forged.json?.code, refunds: [before, after] });

  const out = await http('POST', '/api/v1/auth/logout', { headers: { Cookie: ctx.aCookie, Origin: GOOD_ORIGIN } });
  const gone = await http('GET', '/api/v1/auth/me', { headers: { Cookie: ctx.aCookie } });
  check('csrf/allowed', 'the same POST from an allowed Origin works (logout 204, then /auth/me 401)', out.status === 204 && gone.status === 401, { logout: out.status, me: gone.status });
}

async function cursor(ctx) {
  const page = (limit, after) => http('GET', `/api/v1/admin/orders?limit=${limit}${after ? `&cursor=${after}` : ''}`, { headers: { Cookie: ctx.viewer } });
  const snapshot = (await page(15)).json.items.map((o) => o.order_id);
  const seen = [];
  let next = null;
  for (let i = 0; i < 3; i += 1) {
    const r = await page(5, next);
    seen.push(...r.json.items.map((o) => o.order_id));
    next = r.json.next_cursor;
    await createOrder(email('cursor'));
    await createOrder(email('cursor'));
  }
  check('cursor/admin', '3 pages of 5, with 6 orders created between pages, equal the first 15 taken before', snapshot.length === 15 && JSON.stringify(seen) === JSON.stringify(snapshot) && new Set(seen).size === 15, { snapshot: snapshot.length, seen: seen.length, distinct: new Set(seen).size, same: JSON.stringify(seen) === JSON.stringify(snapshot) });
}

/** Runs inside the replica, so each request can carry its own X-Real-IP. */
const TIMING_SCRIPT = `
const input = JSON.parse(process.env.AUDIT_INPUT);
const call = async (orderId, email, ip) => {
  const t = process.hrtime.bigint();
  const r = await fetch('http://127.0.0.1:3000/api/v1/orders/track', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify({ order_id: orderId, email }) });
  const text = await r.text();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, status: r.status, text };
};
const out = { wrong: [], missing: [] };
let ip = 0;
const nextIp = () => '10.77.' + Math.floor(++ip / 250) + '.' + (ip % 250 + 1);
for (let i = 0; i < 6; i++) await call(input.missing[i], 'warm@audit.test', nextIp());
for (let round = 0; round < input.rounds; round++) {
  for (let i = 0; i < input.orders.length; i++) {
    const pair = [() => call(input.orders[i].id, 'not-the-owner@audit.test', nextIp()), () => call(input.missing[(round * input.orders.length + i) % input.missing.length], input.orders[i].email, nextIp())];
    if ((round + i) % 2) pair.reverse();
    const first = await pair[0]();
    const second = await pair[1]();
    const [w, m] = (round + i) % 2 ? [second, first] : [first, second];
    out.wrong.push(w); out.missing.push(m);
  }
}
console.log(JSON.stringify(out));
`;

async function enumeration() {
  const orders = [];
  for (let i = 0; i < 15; i += 1) {
    const buyer = email('enum');
    orders.push({ id: await createOrder(buyer), email: buyer });
  }
  const missing = Array.from({ length: 60 }, () => unknownOrderId());
  const r = spawnSync('docker', ['exec', '-e', `AUDIT_INPUT=${JSON.stringify({ orders, missing, rounds: 4 })}`, REPLICA, 'node', '--input-type=module', '-e', TIMING_SCRIPT], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`timing script failed: ${r.stderr}`);
  const { wrong, missing: miss } = JSON.parse(r.stdout.trim().split('\n').pop());
  const bodies = new Set([...wrong, ...miss].map((x) => `${x.status} ${x.text}`));
  check('enum/body', '"no such order" and "wrong email" give the same status and the same bytes', bodies.size === 1 && wrong[0].status === 404, [...bodies]);
  const mw = median(wrong.map((x) => x.ms));
  const mm = median(miss.map((x) => x.ms));
  const diff = Math.abs(mw - mm) / Math.max(mw, mm);
  check('enum/time', 'median times differ by at most 20%', diff <= 0.2, { samples: wrong.length, wrongEmailMs: mw.toFixed(2), noOrderMs: mm.toFixed(2), diff: `${(diff * 100).toFixed(1)}%` });
}

async function trackLimits(ctx) {
  const track = (orderId, mail, extra = {}) => post('/api/v1/orders/track', { order_id: orderId, email: mail }, extra);
  // Start in a fresh window: run into the limit, then wait out the Retry-After it gives.
  log('waiting for a fresh rate limit window (up to a minute)');
  let wait = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = await track(unknownOrderId(), 'sync@audit.test');
    if (r.status === 429) {
      wait = Number(r.headers.get('retry-after'));
      break;
    }
  }
  if (!wait) throw new Error('no 429 after 12 track requests, cannot line up a window');
  await sleep((wait + 1) * 1000);

  const perOrder = [];
  for (let i = 0; i < 6; i += 1) perOrder.push(await track(ctx.bOrder, ctx.b));
  const sixth = perOrder[5];
  check('track/order', '6 track requests for one order id in a minute: 5 answered, the 6th 429 with Retry-After', perOrder.slice(0, 5).every((r) => r.status === 200) && sixth.status === 429 && sixth.json?.code === 'RATE_LIMITED' && Number(sixth.headers.get('retry-after')) > 0 && (sixth.headers.get('content-type') ?? '').includes('application/problem+json'), { statuses: perOrder.map((r) => r.status), retryAfter: sixth.headers.get('retry-after') });

  const perIp = [];
  for (let i = 0; i < 5; i += 1) perIp.push(await track(unknownOrderId(), 'ip@audit.test'));
  const eleventh = perIp[4];
  check('track/ip', '11 track requests from one IP in a minute: the 11th is 429 with Retry-After', perIp.slice(0, 4).every((r) => r.status === 404) && eleventh.status === 429 && Number(eleventh.headers.get('retry-after')) > 0, { statuses: [...perOrder, ...perIp].map((r) => r.status), retryAfter: eleventh.headers.get('retry-after') });

  const spoof = await track(unknownOrderId(), 'ip@audit.test', { 'X-Forwarded-For': '198.51.100.1', 'X-Real-IP': '198.51.100.2' });
  check('track/spoof', 'X-Forwarded-For and X-Real-IP sent by the client do not reset the count', spoof.status === 429, { status: spoof.status });
}

// ---------- main ----------

try {
  const ready = await http('GET', '/readyz').catch(() => ({ status: 0 }));
  if (ready.status !== 200) {
    console.error(`the stack is not ready at ${API} (/readyz ${ready.status})`);
    process.exit(2);
  }
  const ctx = { a: email('cust-a'), b: email('cust-b') };
  ctx.aOrder = await createOrder(ctx.a);
  ctx.bOrder = await createOrder(ctx.b);
  // The cursor check needs at least 15 orders.
  for (let i = 0; i < 15; i += 1) await createOrder(email('fill'));

  await headers();
  await otp(ctx);
  await idor(ctx);
  await masking(ctx);
  await csrf(ctx);
  await cursor(ctx);
  await enumeration();
  await trackLimits(ctx);
} catch (error) {
  console.error(`audit could not run: ${error.stack ?? error}`);
  process.exit(2);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, failed: ${failed.map((r) => r.id).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
