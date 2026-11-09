// Mock payment gateway (SPEC section 6). Node built-ins only.
//
// All state is rebuilt by replaying an fsynced journal through one reducer, so
// live behaviour and restart behaviour cannot drift apart. Webhook delivery is
// at-least-once: a process killed mid-attempt sends that attempt again.
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const MAX_BODY_BYTES = 64 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DUPLICATE_COPIES = 5;
const MISMATCH_DELTA_SATANG = 100;

const SCENARIOS = {
  success: { label: "จ่ายสำเร็จ", type: "payment.succeeded" },
  failed: { label: "จ่ายไม่สำเร็จ", type: "payment.failed" },
  duplicate_webhook: { label: "จ่ายสำเร็จแต่ส่ง webhook ซ้ำ 5 ครั้ง", type: "payment.succeeded", copies: DUPLICATE_COPIES },
  slow_webhook: { label: "จ่ายสำเร็จแต่ส่ง webhook ช้า 60 วินาที", type: "payment.succeeded", slow: true },
  amount_mismatch: { label: "จ่ายยอดไม่ตรง", type: "payment.succeeded", mismatch: true },
};

function positiveInt(name, value, fallback, min = 1) {
  if (value === undefined || value === "") return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${value}"`);
  }
  return parsed;
}

function loadConfig(env) {
  const webhookUrl = env.WEBHOOK_URL || "http://proxy/api/v1/webhooks/payment";
  new URL(webhookUrl); // Fail at startup, not on every delivery.
  return {
    port: positiveInt("PORT", env.PORT, 4010, 0),
    dataDir: env.DATA_DIR || "/data",
    webhookUrl,
    secret: env.PAYMENT_WEBHOOK_SECRET || "whsec_test_inblackm_2026",
    maxRetries: positiveInt("WEBHOOK_MAX_RETRIES", env.WEBHOOK_MAX_RETRIES, 8, 0),
    backoffBaseMs: positiveInt("WEBHOOK_BACKOFF_BASE_MS", env.WEBHOOK_BACKOFF_BASE_MS, 1000),
    timeoutMs: positiveInt("WEBHOOK_TIMEOUT_MS", env.WEBHOOK_TIMEOUT_MS, 10000),
    tickMs: positiveInt("WEBHOOK_TICK_MS", env.WEBHOOK_TICK_MS, 250),
    slowDelayMs: positiveInt("SLOW_WEBHOOK_DELAY_MS", env.SLOW_WEBHOOK_DELAY_MS, 60000),
    // POST /_test/reset exists only when this is exactly "test". Off by default.
    testReset: env.APP_ENV === "test",
  };
}

function signatureHeader(secret, unixSeconds, rawBody) {
  const hmac = crypto.createHmac("sha256", secret).update(`${unixSeconds}.${rawBody}`).digest("hex");
  return `t=${unixSeconds},v1=${hmac}`;
}

function newEventId(now) {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const random = [...crypto.randomBytes(16)].map((byte) => CROCKFORD[byte % 32]).join("");
  return `evt_${time}${random}`;
}

// Replays the journal into `apply` and returns an fsyncing append function, and a
// truncate function for the test reset.
// A last line without a newline is a write that was never acknowledged, so it
// is cut off; otherwise the next append would be glued onto it.
function openJournal(filePath, apply) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a+");
  const content = fs.readFileSync(filePath);
  const end = content.lastIndexOf(0x0a) + 1;
  if (end < content.length) {
    console.warn(`dropping ${content.length - end} bytes of torn journal tail`);
    fs.ftruncateSync(fd, end);
  }
  for (const line of content.subarray(0, end).toString("utf8").split("\n")) {
    if (line) apply(JSON.parse(line));
  }
  const append = (record) => {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } catch (err) {
      // The journal may now end in a partial line. Restarting repairs it.
      console.error("journal write failed, exiting", err);
      process.exit(1);
    }
  };
  const truncate = () => {
    fs.ftruncateSync(fd, 0);
    fs.fsyncSync(fd);
  };
  return { append, truncate };
}

function createState() {
  const state = {
    payments: new Map(), // order_id -> { paid, refunded }
    refunds: new Map(), // refund_id -> { event_id, order_id, amount_satang }
    settlements: [], // Money movements, kept even if their webhook never arrives.
    deliveries: new Map(), // Only pending deliveries: id -> { body, attempts, next_attempt_at }
  };
  state.clear = () => {
    state.payments.clear();
    state.refunds.clear();
    state.settlements.length = 0;
    state.deliveries.clear();
  };
  state.apply = (record) => {
    // A payment this provider learns of from a refund request: the merchant was paid by a
    // webhook signed elsewhere (the review team signs its own). Settled, never delivered.
    if (record.k === "payment") {
      state.payments.set(record.order_id, { paid: record.amount_satang, refunded: 0 });
      state.settlements.push({
        event_id: record.event_id,
        type: "payment.succeeded",
        order_id: record.order_id,
        amount_satang: record.amount_satang,
        occurred_at: record.occurred_at,
      });
      return;
    }
    if (record.k === "attempt") {
      const delivery = state.deliveries.get(record.id);
      if (record.status !== "pending") state.deliveries.delete(record.id);
      else if (delivery) Object.assign(delivery, { attempts: record.attempts, next_attempt_at: record.next_attempt_at });
      return;
    }
    const event = JSON.parse(record.body);
    if (event.type === "payment.succeeded") {
      state.payments.set(event.order_id, { paid: event.amount_satang, refunded: 0 });
    }
    if (event.type === "payment.refunded") {
      state.payments.get(event.order_id).refunded += event.amount_satang;
      state.refunds.set(record.refund_id, {
        event_id: event.event_id,
        order_id: event.order_id,
        amount_satang: event.amount_satang,
      });
    }
    if (event.type !== "payment.failed") state.settlements.push(event);
    for (let copy = 1; copy <= record.copies; copy += 1) {
      state.deliveries.set(`${event.event_id}#${copy}`, {
        body: record.body,
        attempts: 0,
        next_attempt_at: record.next_attempt_at,
      });
    }
  };
  return state;
}

// Retries reuse the stored bytes, so event_id and body never change. Only `t`
// is fresh, because a receiver rejects a signature older than 300 seconds.
async function postWebhook(config, body) {
  const signature = signatureHeader(config.secret, Math.floor(Date.now() / 1000), body);
  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-IBM-Signature": signature },
    body,
    redirect: "manual", // A 3xx is not a 2xx, so it must count as a failure.
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}

function startDeliveryLoop(config, state, commit) {
  const inFlight = new Set();

  const attempt = async (id, delivery) => {
    inFlight.add(id);
    let outcome;
    try {
      outcome = await postWebhook(config, delivery.body);
    } catch (err) {
      outcome = err.name;
    }
    const attempts = delivery.attempts + 1;
    const ok = typeof outcome === "number" && outcome >= 200 && outcome < 300;
    let status = "pending";
    if (ok) status = "delivered";
    else if (attempts > config.maxRetries) status = "exhausted";
    const delay = config.backoffBaseMs * 2 ** (attempts - 1);
    commit({ k: "attempt", id, attempts, next_attempt_at: Date.now() + delay, status });
    inFlight.delete(id);
    console.log(`webhook ${id} attempt ${attempts}: ${outcome} (${status})`);
  };

  const tick = () => {
    const now = Date.now();
    for (const [id, delivery] of state.deliveries) {
      if (delivery.next_attempt_at <= now && !inFlight.has(id)) attempt(id, delivery);
    }
  };
  return setInterval(tick, config.tickMs);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function formatBaht(satang) {
  const digits = String(satang).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function page(title, content) {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
dt { font-size: .85rem; color: #555; } dd { margin: 0 0 .75rem; font-weight: 600; overflow-wrap: anywhere; }
button { display: block; width: 100%; min-height: 44px; margin: .5rem 0; padding: .5rem; font: inherit; cursor: pointer; }
</style>
</head>
<body>
${content}
</body>
</html>`;
}

function checkoutPage({ orderId, amount, returnUrl }) {
  const buttons = Object.entries(SCENARIOS)
    .map(([value, scenario]) => `<button type="submit" name="scenario" value="${value}">${escapeHtml(scenario.label)}</button>`)
    .join("\n");
  return page(
    "Mock Pay checkout",
    `<h1>Mock Pay</h1>
<dl>
<dt>เลขออเดอร์</dt><dd>${escapeHtml(orderId)}</dd>
<dt>ยอดชำระ</dt><dd>${formatBaht(amount)} บาท</dd>
</dl>
<form method="post" action="/checkout/pay">
<input type="hidden" name="order_id" value="${escapeHtml(orderId)}">
<input type="hidden" name="amount_satang" value="${amount}">
<input type="hidden" name="return_url" value="${escapeHtml(returnUrl || "")}">
${buttons}
</form>`,
  );
}

function sendJson(res, status, body, contentType = "application/json") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(JSON.stringify(body));
}

function problem(res, status, code, detail, extra = {}) {
  sendJson(res, status, { type: "about:blank", title: http.STATUS_CODES[status], status, code, detail, ...extra }, "application/problem+json");
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { tooLarge: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseCheckoutParams(params) {
  const orderId = params.get("order_id") || "";
  if (!ID_PATTERN.test(orderId)) return { error: "order_id must match [A-Za-z0-9_.:-]{1,128}" };
  const rawAmount = params.get("amount_satang") || "";
  const amount = /^[1-9]\d*$/.test(rawAmount) ? Number(rawAmount) : NaN;
  if (!Number.isSafeInteger(amount)) return { error: "amount_satang must be a positive integer" };
  const returnUrl = params.get("return_url") || "";
  if (returnUrl) {
    let protocol;
    try {
      protocol = new URL(returnUrl).protocol;
    } catch {
      protocol = "";
    }
    if (protocol !== "http:" && protocol !== "https:") return { error: "return_url must be an http or https URL" };
  }
  return { orderId, amount, returnUrl };
}

function start(config) {
  const state = createState();
  const journal = openJournal(path.join(config.dataDir, "mock-pay.jsonl"), state.apply);
  const append = journal.append;
  const commit = (record) => {
    append(record);
    state.apply(record);
  };

  const recordEvent = ({ type, orderId, amount, copies = 1, delayMs = 0, refundId }) => {
    const now = Date.now();
    const event = {
      event_id: newEventId(now),
      type,
      order_id: orderId,
      amount_satang: amount,
      currency: "THB",
      occurred_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    const record = { k: "event", body: JSON.stringify(event), copies, next_attempt_at: now + delayMs };
    if (refundId) record.refund_id = refundId;
    commit(record);
    return event;
  };

  const finishCheckout = (res, returnUrl, orderId, paymentResult, message) => {
    if (!returnUrl) return sendHtml(res, 200, page("Mock Pay", `<h1>${escapeHtml(message)}</h1>`));
    const target = new URL(returnUrl);
    target.searchParams.set("order_id", orderId);
    target.searchParams.set("payment_result", paymentResult);
    res.writeHead(303, { Location: target.href });
    return res.end();
  };

  const handlePay = (res, raw) => {
    const params = new URLSearchParams(raw);
    const parsed = parseCheckoutParams(params);
    if (parsed.error) return problem(res, 400, "INVALID_CHECKOUT", parsed.error);
    const { orderId, amount, returnUrl } = parsed;
    const name = params.get("scenario") || "";
    if (!Object.hasOwn(SCENARIOS, name)) return problem(res, 400, "INVALID_SCENARIO", "unknown scenario");
    const scenario = SCENARIOS[name];

    if (scenario.type === "payment.failed") {
      recordEvent({ type: scenario.type, orderId, amount });
      return finishCheckout(res, returnUrl, orderId, "failed", "ชำระเงินไม่สำเร็จ");
    }
    // An order is charged once, so a double click cannot settle the money twice.
    if (state.payments.has(orderId)) return finishCheckout(res, returnUrl, orderId, "succeeded", "ออเดอร์นี้ชำระแล้ว");

    let charged = amount;
    if (scenario.mismatch) {
      charged = amount > MISMATCH_DELTA_SATANG ? amount - MISMATCH_DELTA_SATANG : amount + MISMATCH_DELTA_SATANG;
    }
    recordEvent({
      type: scenario.type,
      orderId,
      amount: charged,
      copies: scenario.copies,
      delayMs: scenario.slow ? config.slowDelayMs : 0,
    });
    return finishCheckout(res, returnUrl, orderId, "succeeded", "ชำระเงินสำเร็จ");
  };

  const refundResponse = (refundId, refund) => {
    const payment = state.payments.get(refund.order_id);
    return {
      refund_id: refundId,
      event_id: refund.event_id,
      order_id: refund.order_id,
      amount_satang: refund.amount_satang,
      refunded_total_satang: payment.refunded,
      remaining_satang: payment.paid - payment.refunded,
    };
  };

  // Check and commit run without an await, so concurrent requests cannot both
  // pass the balance check.
  const handleRefund = (res, raw) => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return problem(res, 400, "INVALID_JSON", "body is not valid JSON");
    }
    const {
      refund_id: refundId,
      order_id: orderId,
      amount_satang: amount,
      paid_satang: paidSatang,
      payment_event_id: paymentEventId,
    } = body ?? {};
    if (typeof refundId !== "string" || !ID_PATTERN.test(refundId)) {
      return problem(res, 400, "INVALID_REFUND", "refund_id must match [A-Za-z0-9_.:-]{1,128}");
    }
    if (typeof orderId !== "string" || !ID_PATTERN.test(orderId)) {
      return problem(res, 400, "INVALID_REFUND", "order_id must match [A-Za-z0-9_.:-]{1,128}");
    }
    if (!Number.isSafeInteger(amount) || amount < 1) {
      return problem(res, 400, "INVALID_REFUND", "amount_satang must be a positive integer");
    }
    if (paidSatang !== undefined && (!Number.isSafeInteger(paidSatang) || paidSatang < 1)) {
      return problem(res, 400, "INVALID_REFUND", "paid_satang must be a positive integer");
    }
    if (paymentEventId !== undefined && (typeof paymentEventId !== "string" || !ID_PATTERN.test(paymentEventId))) {
      return problem(res, 400, "INVALID_REFUND", "payment_event_id must match [A-Za-z0-9_.:-]{1,128}");
    }

    const existing = state.refunds.get(refundId);
    if (existing) {
      if (existing.order_id !== orderId || existing.amount_satang !== amount) {
        return problem(res, 409, "IDEMPOTENCY_KEY_REUSED", "refund_id was already used with different parameters");
      }
      return sendJson(res, 200, refundResponse(refundId, existing));
    }
    if (!state.payments.has(orderId)) {
      if (paidSatang === undefined) return problem(res, 404, "PAYMENT_NOT_FOUND", "no successful payment for this order");
      // Paid by a webhook this provider did not send. Record that payment at the amount the
      // merchant says it received, so the balance check below and the settlement file cover it.
      // paid_satang never changes a payment this provider already knows.
      const now = Date.now();
      commit({
        k: "payment",
        event_id: paymentEventId ?? newEventId(now),
        order_id: orderId,
        amount_satang: paidSatang,
        occurred_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
    }
    const payment = state.payments.get(orderId);
    const remaining = payment.paid - payment.refunded;
    if (amount > remaining) {
      return problem(res, 409, "REFUND_EXCEEDS_PAID", "amount is more than the refundable balance", {
        remaining_satang: remaining,
      });
    }
    recordEvent({ type: "payment.refunded", orderId, amount, refundId });
    return sendJson(res, 201, refundResponse(refundId, state.refunds.get(refundId)));
  };

  const handleSettlements = (res) => {
    const rows = state.settlements.map(
      (event) => `${event.event_id},${event.order_id},${event.type},${event.amount_satang},${event.occurred_at}`,
    );
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
    res.end(`${["event_id,order_id,type,amount_satang,settled_at", ...rows].join("\n")}\n`);
  };

  // Empties the journal and all state, pending webhooks included. Test environments only.
  const handleTestReset = (res) => {
    journal.truncate();
    state.clear();
    return sendJson(res, 200, { status: "reset" });
  };

  const route = async (req, res) => {
    const url = new URL(req.url, "http://mock-pay");
    if (url.pathname === "/_test/reset" && req.method === "POST" && config.testReset) return handleTestReset(res);
    if (url.pathname === "/healthz") return sendJson(res, 200, { status: "ok", service: "mock-pay" });
    if (url.pathname === "/checkout" && req.method === "GET") {
      const parsed = parseCheckoutParams(url.searchParams);
      if (parsed.error) return problem(res, 400, "INVALID_CHECKOUT", parsed.error);
      return sendHtml(res, 200, checkoutPage(parsed));
    }
    if (url.pathname === "/checkout/pay" && req.method === "POST") return handlePay(res, await readBody(req));
    if (url.pathname === "/refunds" && req.method === "POST") return handleRefund(res, await readBody(req));
    if (url.pathname === "/settlements.csv" && req.method === "GET") return handleSettlements(res);
    return problem(res, 404, "NOT_FOUND", "no such route");
  };

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (err.tooLarge) return problem(res, 413, "BODY_TOO_LARGE", `limit is ${MAX_BODY_BYTES} bytes`);
      if (err.code === "ERR_INVALID_URL") return problem(res, 400, "INVALID_URL", "request URL is invalid");
      console.error(err);
      return problem(res, 500, "INTERNAL_ERROR", "unexpected error");
    });
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => process.exit(0));
  }

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`Mock Pay running on port ${server.address().port}`);
    startDeliveryLoop(config, state, commit);
  });
  return server;
}

if (require.main === module) {
  start(loadConfig(process.env));
}

module.exports = { loadConfig, signatureHeader };
