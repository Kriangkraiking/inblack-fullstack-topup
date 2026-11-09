// Mock game top-up provider (SPEC section 7). Node built-ins only.
//
// Deliberately NOT idempotent: every committed POST /topups counts as another
// top-up, even for a reference it has already seen. /stats is how duplicates
// are detected, so the count must survive SIGKILL: each top-up is appended and
// fsynced to a journal before it is counted or acknowledged.
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELD_LENGTH = 256;

function parseRate(name, value) {
  if (value === undefined || value === "") return 0;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`${name} must be a number between 0 and 1, got "${value}"`);
  }
  return rate;
}

function parseLatency(value) {
  if (value === undefined || value === "") return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error(`LATENCY_MS must be a non-negative integer, got "${value}"`);
  }
  return Number(value);
}

function loadConfig(env) {
  const config = {
    port: env.PORT === undefined || env.PORT === "" ? 4020 : Number(env.PORT),
    dataDir: env.DATA_DIR || "/data",
    failRate: parseRate("FAIL_RATE", env.FAIL_RATE),
    timeoutRate: parseRate("TIMEOUT_RATE", env.TIMEOUT_RATE),
    successButTimeoutRate: parseRate("SUCCESS_BUT_TIMEOUT_RATE", env.SUCCESS_BUT_TIMEOUT_RATE),
    latencyMs: parseLatency(env.LATENCY_MS),
  };
  if (config.failRate + config.timeoutRate + config.successButTimeoutRate > 1) {
    console.warn("rates sum to more than 1; precedence is FAIL, TIMEOUT, SUCCESS_BUT_TIMEOUT");
  }
  return config;
}

// Replays the journal into `apply` and returns an fsyncing append function.
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
  return (record) => {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } catch (err) {
      // The journal may now end in a partial line. Restarting repairs it.
      console.error("journal write failed, exiting", err);
      process.exit(1);
    }
  };
}

function send(res, status, body, contentType = "application/json") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(JSON.stringify(body));
}

function problem(res, status, code, detail) {
  send(res, status, { type: "about:blank", title: http.STATUS_CODES[status], status, code, detail }, "application/problem+json");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { tooLarge: true }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function validString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function validateTopup(body) {
  if (body === null || typeof body !== "object") return "body must be a JSON object";
  if (!validString(body.reference)) return "reference must be a non-empty string";
  if (!validString(body.game_uid)) return "game_uid must be a non-empty string";
  if (!validString(body.sku)) return "sku must be a non-empty string";
  if (!Number.isSafeInteger(body.qty) || body.qty < 1) return "qty must be a positive integer";
  return null;
}

function start(config) {
  // reference -> committed top-ups, oldest first. A Map keeps hostile references
  // such as "__proto__" from touching an object prototype.
  const topups = new Map();
  const applyTopup = (record) => {
    if (!topups.has(record.reference)) topups.set(record.reference, []);
    topups.get(record.reference).push(record);
  };
  const append = openJournal(path.join(config.dataDir, "mock-game.jsonl"), applyTopup);

  const commitTopup = ({ reference, game_uid, sku, qty }) => {
    const record = {
      topup_id: `top_${crypto.randomUUID()}`,
      reference,
      game_uid,
      sku,
      qty,
      topped_up_at: new Date().toISOString(),
    };
    append(record);
    applyTopup(record);
    return record;
  };

  const handlePostTopup = (res, raw) => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return problem(res, 400, "INVALID_JSON", "body is not valid JSON");
    }
    const invalid = validateTopup(body);
    if (invalid) return problem(res, 400, "INVALID_TOPUP", invalid);

    // One roll, so the rates are mutually exclusive shares of all requests.
    const roll = Math.random();
    if (roll < config.failRate) {
      return problem(res, 500, "SIMULATED_FAILURE", "simulated failure, nothing was topped up");
    }
    if (roll < config.failRate + config.timeoutRate) return undefined; // Hang, not topped up.
    const record = commitTopup(body);
    if (roll < config.failRate + config.timeoutRate + config.successButTimeoutRate) return undefined; // Topped up, hang.
    return send(res, 200, { ...record, status: "SUCCESS", count: topups.get(body.reference).length });
  };

  const handleGetTopup = (res, encoded) => {
    let reference;
    try {
      reference = decodeURIComponent(encoded);
    } catch {
      return problem(res, 400, "INVALID_REFERENCE", "reference is not valid percent-encoding");
    }
    const records = topups.get(reference);
    if (!records) return problem(res, 404, "TOPUP_NOT_FOUND", "no successful top-up for this reference");
    return send(res, 200, { reference, status: "SUCCESS", count: records.length, topups: records });
  };

  const handleStats = (res) => {
    const counts = [...topups].map(([reference, records]) => [reference, records.length]);
    const total = counts.reduce((sum, [, count]) => sum + count, 0);
    // fromEntries defines own properties, so "__proto__" is safe here too.
    send(res, 200, { total_topups: total, by_reference: Object.fromEntries(counts) });
  };

  const route = async (req, res) => {
    const pathname = req.url.split("?")[0];
    // Exempt from LATENCY_MS: the compose healthcheck has a 3 second timeout.
    if (pathname === "/healthz") return send(res, 200, { status: "ok", service: "mock-game" });

    const raw = req.method === "POST" ? await readBody(req) : "";
    // State is read after the delay, so a GET sent after a POST sees its commit.
    if (config.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, config.latencyMs));

    if (pathname === "/topups" && req.method === "POST") return handlePostTopup(res, raw);
    if (pathname === "/stats" && req.method === "GET") return handleStats(res);
    const match = /^\/topups\/([^/]+)$/.exec(pathname);
    if (match && req.method === "GET") return handleGetTopup(res, match[1]);
    return problem(res, 404, "NOT_FOUND", "no such route");
  };

  const server = http.createServer((req, res) => {
    // One JSON line per call, with the worker's X-Request-Id so a top-up can be traced to its webhook.
    const started = Date.now();
    res.on("finish", () => {
      const pathname = req.url.split("?")[0];
      if (pathname === "/healthz") return;
      const requestId = /^[A-Za-z0-9._-]{1,128}$/.test(req.headers["x-request-id"] ?? "") ? req.headers["x-request-id"] : undefined;
      process.stdout.write(`${JSON.stringify({ level: "info", time: new Date().toISOString(), service: "mock-game", msg: "request", request_id: requestId, method: req.method, path: pathname, status: res.statusCode, duration_ms: Date.now() - started })}\n`);
    });
    route(req, res).catch((err) => {
      if (err.tooLarge) return problem(res, 413, "BODY_TOO_LARGE", `limit is ${MAX_BODY_BYTES} bytes`);
      console.error(err);
      return problem(res, 500, "INTERNAL_ERROR", "unexpected error");
    });
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => process.exit(0));
  }

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`Mock Game running on port ${server.address().port}`);
  });
  return server;
}

if (require.main === module) {
  start(loadConfig(process.env));
}

module.exports = { loadConfig };
