const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, after } = require("node:test");

const SERVER = path.join(__dirname, "..", "server.js");
const CLIENT_TIMEOUT_MS = 300;
const running = new Set();
const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-game-"));
  tempDirs.push(dir);
  return dir;
}

function startServer(env = {}, dataDir = tempDir()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env.PATH, PORT: "0", DATA_DIR: dataDir, ...env },
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

function postTopup(base, reference, options = {}) {
  return fetch(`${base}/topups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference, game_uid: "uid-1", sku: "DIAMOND-1000", qty: 1 }),
    ...options,
  });
}

function postUntilClientTimeout(base, reference) {
  return assert.rejects(postTopup(base, reference, { signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) }), {
    name: "TimeoutError",
  });
}

async function stats(base) {
  return (await fetch(`${base}/stats`)).json();
}

after(() => {
  for (const child of running) child.kill("SIGKILL");
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("healthz keeps its original response", async () => {
  const { base } = await startServer();
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", service: "mock-game" });
});

test("repeating a reference tops up again, with no idempotency", async () => {
  const { base } = await startServer();
  const first = await postTopup(base, "ref-a");
  assert.equal(first.status, 200);
  assert.equal((await first.json()).count, 1);
  const second = await postTopup(base, "ref-a");
  assert.equal(second.status, 200);
  assert.equal((await second.json()).count, 2);
  await postTopup(base, "ref-b");

  assert.deepEqual(await stats(base), { total_topups: 3, by_reference: { "ref-a": 2, "ref-b": 1 } });
  const detail = await (await fetch(`${base}/topups/ref-a`)).json();
  assert.equal(detail.status, "SUCCESS");
  assert.equal(detail.count, 2);
  assert.notEqual(detail.topups[0].topup_id, detail.topups[1].topup_id);
});

test("concurrent POSTs for one reference are all counted", async () => {
  const { base } = await startServer();
  await Promise.all(Array.from({ length: 50 }, () => postTopup(base, "ref-c")));
  assert.equal((await stats(base)).by_reference["ref-c"], 50);
});

test("GET for an unknown reference is 404 Problem Details", async () => {
  const { base } = await startServer();
  const res = await fetch(`${base}/topups/nope`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  assert.equal((await res.json()).code, "TOPUP_NOT_FOUND");
});

test("invalid bodies are rejected and not counted", async () => {
  const { base } = await startServer();
  const bad = [
    "not json",
    "null",
    JSON.stringify({ game_uid: "u", sku: "s", qty: 1 }),
    JSON.stringify({ reference: "r", sku: "s", qty: 1 }),
    JSON.stringify({ reference: "r", game_uid: "u", qty: 1 }),
    JSON.stringify({ reference: "r", game_uid: "u", sku: "s", qty: 0 }),
    JSON.stringify({ reference: "r", game_uid: "u", sku: "s", qty: 1.5 }),
    JSON.stringify({ reference: "r", game_uid: "u", sku: "s", qty: "1" }),
  ];
  for (const body of bad) {
    const res = await fetch(`${base}/topups`, { method: "POST", body });
    assert.equal(res.status, 400, body);
  }
  assert.equal((await stats(base)).total_topups, 0);
});

test("a __proto__ reference is an ordinary key in stats and survives JSON", async () => {
  const { base } = await startServer();
  await postTopup(base, "__proto__");
  const text = await (await fetch(`${base}/stats`)).text();
  assert.match(text, /"__proto__":1/);
  assert.equal((await (await fetch(`${base}/topups/__proto__`)).json()).count, 1);
});

test("FAIL_RATE=1 answers 5xx and does not top up", async () => {
  const { base } = await startServer({ FAIL_RATE: "1" });
  const res = await postTopup(base, "ref-fail");
  assert.equal(res.status, 500);
  assert.equal((await stats(base)).total_topups, 0);
  assert.equal((await fetch(`${base}/topups/ref-fail`)).status, 404);
});

test("TIMEOUT_RATE=1 hangs until client timeout and does not top up", async () => {
  const { base } = await startServer({ TIMEOUT_RATE: "1" });
  await postUntilClientTimeout(base, "ref-timeout");
  assert.equal((await stats(base)).total_topups, 0);
  assert.equal((await fetch(`${base}/topups/ref-timeout`)).status, 404);
});

test("SUCCESS_BUT_TIMEOUT_RATE=1 tops up, then hangs until client timeout", async () => {
  const { base } = await startServer({ SUCCESS_BUT_TIMEOUT_RATE: "1" });
  await postUntilClientTimeout(base, "ref-sbt");
  assert.equal((await stats(base)).by_reference["ref-sbt"], 1);
  assert.equal((await (await fetch(`${base}/topups/ref-sbt`)).json()).status, "SUCCESS");
});

test("fractional FAIL_RATE only counts the requests that succeeded", async () => {
  const { base } = await startServer({ FAIL_RATE: "0.5" });
  const results = await Promise.all(Array.from({ length: 100 }, () => postTopup(base, "ref-mix")));
  const ok = results.filter((res) => res.status === 200).length;
  assert.ok(ok > 0 && ok < 100, `expected a mix, got ${ok} successes`);
  assert.equal(results.filter((res) => res.status === 500).length, 100 - ok);
  assert.equal((await stats(base)).total_topups, ok);
});

test("LATENCY_MS delays requests but not healthz", async () => {
  const { base } = await startServer({ LATENCY_MS: "400" });
  const health = Date.now();
  await fetch(`${base}/healthz`);
  assert.ok(Date.now() - health < 300);

  for (const call of [() => postTopup(base, "ref-slow"), () => fetch(`${base}/topups/ref-slow`), () => stats(base)]) {
    const started = Date.now();
    await call();
    assert.ok(Date.now() - started >= 395);
  }
});

test("invalid rate configuration stops the server at startup", async () => {
  await assert.rejects(startServer({ FAIL_RATE: "abc" }), /FAIL_RATE must be a number/);
  await assert.rejects(startServer({ TIMEOUT_RATE: "1.5" }), /TIMEOUT_RATE must be a number/);
  await assert.rejects(startServer({ LATENCY_MS: "-1" }), /LATENCY_MS must be/);
});

test("counts survive SIGKILL and new top-ups add to them", async () => {
  const first = await startServer();
  await postTopup(first.base, "ref-k");
  await postTopup(first.base, "ref-k");
  await sigkill(first.child);

  const second = await startServer({}, first.dataDir);
  assert.equal((await stats(second.base)).by_reference["ref-k"], 2);
  await postTopup(second.base, "ref-k");
  assert.equal((await stats(second.base)).by_reference["ref-k"], 3);
});

test("a top-up committed before the hang survives SIGKILL during the hang", async () => {
  const first = await startServer({ SUCCESS_BUT_TIMEOUT_RATE: "1" });
  const pending = postTopup(first.base, "ref-hang").catch(() => {});
  // Poll the journal, not the API, to prove it is on disk while the POST hangs.
  const journal = path.join(first.dataDir, "mock-game.jsonl");
  while (!fs.existsSync(journal) || fs.statSync(journal).size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await sigkill(first.child);
  await pending;

  const second = await startServer({}, first.dataDir);
  assert.equal((await stats(second.base)).by_reference["ref-hang"], 1);
});

test("a torn journal tail is dropped and later appends stay readable", async () => {
  const first = await startServer();
  await postTopup(first.base, "ref-torn");
  await sigkill(first.child);
  const journal = path.join(first.dataDir, "mock-game.jsonl");
  fs.appendFileSync(journal, '{"topup_id":"top_x","reference":"ref-torn","ga');

  const second = await startServer({}, first.dataDir);
  assert.equal((await stats(second.base)).by_reference["ref-torn"], 1);
  await postTopup(second.base, "ref-torn");
  await sigkill(second.child);

  const third = await startServer({}, first.dataDir);
  assert.equal((await stats(third.base)).by_reference["ref-torn"], 2);
});
