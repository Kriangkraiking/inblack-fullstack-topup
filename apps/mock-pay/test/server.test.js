const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test, after } = require("node:test");
const { loadConfig } = require("../server.js");

const SERVER = path.join(__dirname, "..", "server.js");
const SECRET = "whsec_unit_test_secret";
const FAST = { WEBHOOK_BACKOFF_BASE_MS: "20", WEBHOOK_TICK_MS: "5", WEBHOOK_TIMEOUT_MS: "500" };
const running = new Set();
const receivers = new Set();
const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-pay-"));
  tempDirs.push(dir);
  return dir;
}

// Records raw bytes off the wire and answers with `respond(callNumber)`.
function startReceiver(respond = () => 200) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      calls.push({ at: Date.now(), raw, signature: req.headers["x-ibm-signature"], method: req.method, url: req.url });
      const status = respond(calls.length);
      if (status === null) return; // Hang.
      res.writeHead(status);
      res.end();
    });
  });
  receivers.add(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ calls, url: `http://127.0.0.1:${server.address().port}/api/v1/webhooks/payment` });
    });
  });
}

function startPay(env, dataDir = tempDir()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env.PATH, PORT: "0", DATA_DIR: dataDir, PAYMENT_WEBHOOK_SECRET: SECRET, ...FAST, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      const match = /port (\d+)/.exec(chunk.toString());
      if (match) resolve({ child, dataDir, base: `http://127.0.0.1:${match[1]}` });
    });
    child.on("exit", (code) => {
      running.delete(child);
      reject(new Error(`server exited early with ${code}: ${stderr}`));
    });
  });
}

function sigkill(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGKILL");
  });
}

function pay(base, scenario, orderId = "ORD-1", amount = "66980", returnUrl = "") {
  return fetch(`${base}/checkout/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ order_id: orderId, amount_satang: amount, return_url: returnUrl, scenario }),
    redirect: "manual",
  });
}

function refund(base, body) {
  return fetch(`${base}/refunds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function settlementRows(base) {
  const text = await (await fetch(`${base}/settlements.csv`)).text();
  const [header, ...rows] = text.trimEnd().split("\n");
  assert.equal(header, "event_id,order_id,type,amount_satang,settled_at");
  return rows.map((row) => row.split(","));
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bodyOf = (call) => JSON.parse(call.raw.toString("utf8"));

function assertValidSignature(call) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(call.signature);
  assert.ok(match, `bad signature header: ${call.signature}`);
  const signed = Buffer.concat([Buffer.from(`${match[1]}.`), call.raw]);
  assert.equal(match[2], crypto.createHmac("sha256", SECRET).update(signed).digest("hex"));
  return Number(match[1]);
}

after(() => {
  for (const child of running) child.kill("SIGKILL");
  for (const server of receivers) server.close();
  for (const server of receivers) server.closeAllConnections();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("defaults match the task and the spec", () => {
  const config = loadConfig({});
  assert.equal(config.port, 4010);
  assert.equal(config.dataDir, "/data");
  assert.equal(config.webhookUrl, "http://proxy/api/v1/webhooks/payment");
  assert.equal(config.secret, "whsec_test_inblackm_2026");
  assert.equal(config.maxRetries, 8);
  assert.equal(config.slowDelayMs, 60000);
});

test("healthz keeps its original response", async () => {
  const { url } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", service: "mock-pay" });
});

test("checkout page has all 5 buttons and escapes its input", async () => {
  const { url } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  const returnUrl = encodeURIComponent('http://web/x?a="><script>alert(1)</script>');
  const res = await fetch(`${base}/checkout?order_id=ORD-1&amount_satang=66980&return_url=${returnUrl}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /669\.80/);
  for (const label of [
    ">จ่ายสำเร็จ<",
    ">จ่ายไม่สำเร็จ<",
    ">จ่ายสำเร็จแต่ส่ง webhook ซ้ำ 5 ครั้ง<",
    ">จ่ายสำเร็จแต่ส่ง webhook ช้า 60 วินาที<",
    ">จ่ายยอดไม่ตรง<",
  ]) {
    assert.ok(html.includes(label), label);
  }
  assert.equal((html.match(/<button/g) || []).length, 5);
});

test("checkout rejects bad input", async () => {
  const { url } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  for (const query of [
    "amount_satang=100",
    "order_id=ORD-1",
    "order_id=ORD-1&amount_satang=10.5",
    "order_id=ORD-1&amount_satang=-1",
    "order_id=ORD-1&amount_satang=1e3",
    "order_id=%3Cb%3E&amount_satang=100",
    "order_id=ORD-1&amount_satang=100&return_url=javascript:alert(1)",
  ]) {
    assert.equal((await fetch(`${base}/checkout?${query}`)).status, 400, query);
  }
  assert.equal((await pay(base, "nope")).status, 400);
  assert.equal((await pay(base, "__proto__")).status, 400);
});

test("success sends a webhook that matches the spec, signed over the raw body", async () => {
  const { url, calls } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  const res = await pay(base, "success", "ORD-1", "66980", "http://web/orders?x=1");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "http://web/orders?x=1&order_id=ORD-1&payment_result=succeeded");

  await waitFor(() => calls.length === 1);
  const [call] = calls;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "/api/v1/webhooks/payment");
  const t = assertValidSignature(call);
  assert.ok(Math.abs(Date.now() / 1000 - t) < 5);
  const body = bodyOf(call);
  assert.deepEqual(Object.keys(body), ["event_id", "type", "order_id", "amount_satang", "currency", "occurred_at"]);
  assert.match(body.event_id, /^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(body.type, "payment.succeeded");
  assert.equal(body.order_id, "ORD-1");
  assert.equal(body.amount_satang, 66980);
  assert.equal(body.currency, "THB");
  assert.match(body.occurred_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

  await sleep(100);
  assert.equal(calls.length, 1, "a 2xx must stop delivery");
});

test("failed sends payment.failed, adds no settlement and allows a later payment", async () => {
  const { url, calls } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "failed");
  await waitFor(() => calls.length === 1);
  assert.equal(bodyOf(calls[0]).type, "payment.failed");
  assert.deepEqual(await settlementRows(base), []);

  await pay(base, "success");
  await waitFor(() => calls.length === 2);
  assert.equal((await settlementRows(base)).length, 1);
});

test("mismatch sends the different amount, and refunds are capped by what was charged", async () => {
  const { url, calls } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "amount_mismatch", "ORD-1", "66980");
  await waitFor(() => calls.length === 1);
  assert.equal(bodyOf(calls[0]).amount_satang, 66880);
  assert.equal((await refund(base, { refund_id: "r1", order_id: "ORD-1", amount_satang: 66980 })).status, 409);
  assert.equal((await refund(base, { refund_id: "r2", order_id: "ORD-1", amount_satang: 66880 })).status, 201);

  await pay(base, "amount_mismatch", "ORD-small", "50");
  await waitFor(() => calls.length === 3);
  assert.equal(bodyOf(calls[2]).amount_satang, 150);
});

test("a second payment click does not charge or settle again", async () => {
  const { url, calls } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "success");
  await pay(base, "success");
  await pay(base, "duplicate_webhook");
  await sleep(150);
  assert.equal(calls.length, 1);
  assert.equal((await settlementRows(base)).length, 1);
});

test("payment.failed after success still sends, without changing the money", async () => {
  const { url, calls } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "success");
  await pay(base, "failed");
  await waitFor(() => calls.length === 2);
  assert.equal((await settlementRows(base)).length, 1);
  assert.equal((await refund(base, { refund_id: "r1", order_id: "ORD-1", amount_satang: 66980 })).status, 201);
});

test("retry: 8 retries with doubling backoff, then stops", async () => {
  const { url, calls } = await startReceiver(() => 500);
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "success");
  await waitFor(() => calls.length === 9);
  await sleep(200);
  assert.equal(calls.length, 9, "1 first attempt + 8 retries, then no more");

  for (let retry = 0; retry < 8; retry += 1) {
    const gap = calls[retry + 1].at - calls[retry].at;
    const expected = 20 * 2 ** retry;
    assert.ok(gap >= expected - 5, `retry ${retry + 1}: gap ${gap}ms is below ${expected}ms`);
  }
  assert.ok(calls[8].at - calls[7].at > calls[5].at - calls[4].at, "later gaps must be longer");

  const ids = new Set(calls.map((call) => bodyOf(call).event_id));
  assert.equal(ids.size, 1, "retries must reuse event_id");
  assert.equal(new Set(calls.map((call) => call.raw.toString("utf8"))).size, 1, "retries must reuse the raw body");
  calls.forEach(assertValidSignature);
  assert.equal((await settlementRows(base)).length, 1, "the provider has the money even if delivery gave up");
});

test("retry: stops on the first 2xx", async () => {
  const { url, calls } = await startReceiver((n) => (n < 3 ? 503 : 204));
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "success");
  await waitFor(() => calls.length === 3);
  await sleep(200);
  assert.equal(calls.length, 3);
});

test("retry: a 3xx and a hang both count as failures", async () => {
  const { url, calls } = await startReceiver((n) => (n === 1 ? 302 : n === 2 ? null : 200));
  const { base } = await startPay({ WEBHOOK_URL: url, WEBHOOK_TIMEOUT_MS: "100" });
  await pay(base, "success");
  await waitFor(() => calls.length === 3);
  await sleep(100);
  assert.equal(calls.length, 3);
});

test("duplicate sends 5 concurrent copies with one event_id and one settlement row", async () => {
  const { url, calls } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "duplicate_webhook");
  await waitFor(() => calls.length === 5);
  await sleep(100);
  assert.equal(calls.length, 5);
  assert.equal(new Set(calls.map((call) => bodyOf(call).event_id)).size, 1);
  assert.ok(calls[4].at - calls[0].at < 100, "copies should arrive together");
  calls.forEach(assertValidSignature);
  assert.equal((await settlementRows(base)).length, 1);
});

test("duplicate copies are retried individually with the same event_id", async () => {
  const { url, calls } = await startReceiver((n) => (n <= 5 ? 500 : 200));
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "duplicate_webhook");
  await waitFor(() => calls.length === 10);
  await sleep(100);
  assert.equal(calls.length, 10);
  assert.equal(new Set(calls.map((call) => bodyOf(call).event_id)).size, 1);
});

test("slow sends late, signing with the send time rather than the click time", async () => {
  const { url, calls } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url, SLOW_WEBHOOK_DELAY_MS: "1500" });
  const clicked = Date.now();
  await pay(base, "slow_webhook");
  await sleep(1000);
  assert.equal(calls.length, 0, "must not send early");
  assert.equal((await settlementRows(base)).length, 1, "money settles at payment time");
  await waitFor(() => calls.length === 1);
  assert.ok(calls[0].at - clicked >= 1495);
  const t = assertValidSignature(calls[0]);
  assert.ok(t >= Math.floor(clicked / 1000) + 1, "t must be taken at send time");
  assert.ok(Date.parse(bodyOf(calls[0]).occurred_at) <= clicked, "occurred_at stays at payment time");
});

test("refund: partial refunds send payment.refunded and stop at the paid amount", async () => {
  const { url, calls } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "success", "ORD-1", "1000");
  await waitFor(() => calls.length === 1);

  const first = await refund(base, { refund_id: "r1", order_id: "ORD-1", amount_satang: 300 });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.refunded_total_satang, 300);
  assert.equal(firstBody.remaining_satang, 700);
  await waitFor(() => calls.length === 2);
  const webhook = bodyOf(calls[1]);
  assert.equal(webhook.type, "payment.refunded");
  assert.equal(webhook.amount_satang, 300);
  assert.equal(webhook.event_id, firstBody.event_id);
  assertValidSignature(calls[1]);

  const over = await refund(base, { refund_id: "r2", order_id: "ORD-1", amount_satang: 701 });
  assert.equal(over.status, 409);
  const overBody = await over.json();
  assert.equal(overBody.code, "REFUND_EXCEEDS_PAID");
  assert.equal(overBody.remaining_satang, 700);
  assert.equal((await refund(base, { refund_id: "r3", order_id: "ORD-1", amount_satang: 700 })).status, 201);

  const rows = await settlementRows(base);
  assert.deepEqual(rows.map((row) => [row[2], row[3]]), [
    ["payment.succeeded", "1000"],
    ["payment.refunded", "300"],
    ["payment.refunded", "700"],
  ]);
  assert.equal(rows[1][0], firstBody.event_id);
});

test("refund: repeating a refund_id is idempotent, and changing it is refused", async () => {
  const { url, calls } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "success", "ORD-1", "1000");
  const body = { refund_id: "r1", order_id: "ORD-1", amount_satang: 400 };
  const first = await (await refund(base, body)).json();
  const again = await refund(base, body);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).event_id, first.event_id);
  const changed = await refund(base, { ...body, amount_satang: 401 });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, "IDEMPOTENCY_KEY_REUSED");
  await waitFor(() => calls.length === 2);
  await sleep(100);
  assert.equal(calls.length, 2);
  assert.equal((await settlementRows(base)).length, 2);
});

test("refund: 20 concurrent requests cannot exceed the paid amount", async () => {
  const { url } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  await pay(base, "success", "ORD-1", "1000");
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => refund(base, { refund_id: `r${i}`, order_id: "ORD-1", amount_satang: 300 })),
  );
  assert.equal(results.filter((res) => res.status === 201).length, 3);
  assert.equal(results.filter((res) => res.status === 409).length, 17);
});

test("refund: invalid requests are rejected", async () => {
  const { url } = await startReceiver();
  const { base } = await startPay({ WEBHOOK_URL: url });
  const missing = await refund(base, { refund_id: "r1", order_id: "ORD-none", amount_satang: 1 });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "PAYMENT_NOT_FOUND");
  await pay(base, "failed", "ORD-failed");
  assert.equal((await refund(base, { refund_id: "r2", order_id: "ORD-failed", amount_satang: 1 })).status, 404);
  await pay(base, "success", "ORD-1", "1000");
  for (const body of [
    null,
    { order_id: "ORD-1", amount_satang: 1 },
    { refund_id: "r3", amount_satang: 1 },
    { refund_id: "r3", order_id: "ORD-1", amount_satang: 0 },
    { refund_id: "r3", order_id: "ORD-1", amount_satang: 1.5 },
    { refund_id: "r3", order_id: "ORD-1", amount_satang: "1" },
  ]) {
    assert.equal((await refund(base, body)).status, 400, JSON.stringify(body));
  }
});

test("restart: pending retries resume with the same event_id and keep their count", async () => {
  const { url, calls } = await startReceiver(() => 500);
  const first = await startPay({ WEBHOOK_URL: url });
  await pay(first.base, "success");
  await waitFor(() => calls.length === 3);
  await sigkill(first.child);
  const before = calls.length;

  // Without the journal the delivery would be forgotten and nothing would arrive.
  await startPay({ WEBHOOK_URL: url }, first.dataDir);
  await waitFor(() => calls.length >= 9);
  await sleep(500);
  // Restarting the count from 0 would give at least 12. One attempt may repeat
  // if the kill landed after it was received but before it was journaled.
  assert.ok(calls.length <= 10, `got ${calls.length} total, ${before} before the kill`);
  assert.equal(new Set(calls.map((call) => bodyOf(call).event_id)).size, 1);
  assert.equal(new Set(calls.map((call) => call.raw.toString("utf8"))).size, 1);
});

test("restart: a delayed webhook still arrives on schedule", async () => {
  const { url, calls } = await startReceiver();
  const first = await startPay({ WEBHOOK_URL: url, SLOW_WEBHOOK_DELAY_MS: "800" });
  const clicked = Date.now();
  await pay(first.base, "slow_webhook");
  await sigkill(first.child);

  await startPay({ WEBHOOK_URL: url, SLOW_WEBHOOK_DELAY_MS: "800" }, first.dataDir);
  await waitFor(() => calls.length === 1);
  assert.ok(calls[0].at - clicked >= 795);
});

test("restart: a delivered webhook is not sent again", async () => {
  const { url, calls } = await startReceiver();
  const first = await startPay({ WEBHOOK_URL: url });
  await pay(first.base, "success");
  await waitFor(() => calls.length === 1);
  await sleep(50); // Let the delivered record reach the journal.
  await sigkill(first.child);

  await startPay({ WEBHOOK_URL: url }, first.dataDir);
  await sleep(200);
  assert.equal(calls.length, 1);
});

test("restart: refund balance, idempotency and settlements all come back", async () => {
  const { url } = await startReceiver();
  const first = await startPay({ WEBHOOK_URL: url });
  await pay(first.base, "success", "ORD-1", "1000");
  const original = await (await refund(first.base, { refund_id: "r1", order_id: "ORD-1", amount_satang: 600 })).json();
  const rows = await settlementRows(first.base);
  await sigkill(first.child);

  const second = await startPay({ WEBHOOK_URL: url }, first.dataDir);
  assert.deepEqual(await settlementRows(second.base), rows);
  const replay = await refund(second.base, { refund_id: "r1", order_id: "ORD-1", amount_satang: 600 });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).event_id, original.event_id);
  assert.equal((await refund(second.base, { refund_id: "r2", order_id: "ORD-1", amount_satang: 401 })).status, 409);
  assert.equal((await refund(second.base, { refund_id: "r3", order_id: "ORD-1", amount_satang: 400 })).status, 201);
  assert.equal((await pay(second.base, "success", "ORD-1", "1000")).status, 200);
  assert.equal((await settlementRows(second.base)).length, 3);
});

test("restart: a torn journal tail is dropped and later appends stay readable", async () => {
  const { url } = await startReceiver();
  const first = await startPay({ WEBHOOK_URL: url });
  await pay(first.base, "success", "ORD-1", "1000");
  await sigkill(first.child);
  fs.appendFileSync(path.join(first.dataDir, "mock-pay.jsonl"), '{"k":"event","body":"{\\"event_');

  const second = await startPay({ WEBHOOK_URL: url }, first.dataDir);
  await pay(second.base, "success", "ORD-2", "1000");
  await sigkill(second.child);

  const third = await startPay({ WEBHOOK_URL: url }, first.dataDir);
  assert.equal((await settlementRows(third.base)).length, 2);
});
