# AI Log

## How AI was used

The whole project was built with Claude Code: one orchestrator session that split the work and
eight sub agents defined in `.claude/agents/`, all briefed by `CLAUDE.md` (project rules, exact
numbers, failure conditions) and `docs/SPEC.md`.

| Agent | Used for |
|---|---|
| `domain-engineer` | pricing, order id checksum, state machine, schema and migrations, order creation |
| `payments-fulfillment-engineer` | webhook, mock-pay, mock-game, worker, outbox, retry/DLQ, refunds, reconciliation |
| `platform-engineer` | docker compose, nginx, real-time across replicas, health/metrics/logs |
| `frontend-engineer` | Next.js pages, SSE UI, a11y, SEO basics |
| `test-engineer` | unit, integration, e2e runner, CI |
| `invariant-auditor` | independent attempts to break the money/goods invariants with real concurrency (`scripts/audit/invariants.mjs`); not allowed to change production code |
| `security-reviewer` | independent review of IDOR, enumeration, OTP, sessions/CSRF, headers, PII (`scripts/audit/security.mjs`); not allowed to change production code |
| `docs-writer` | README, ARCHITECTURE, ADR, RUNBOOK, SEO.md, this file |

How the output was checked:

- **No agent's "it passes" was accepted on its word.** The orchestrator re-ran every agent's
  tests, the compose build and the audit scripts itself before a stage was accepted, several
  times from a fresh clone without `.env`. Several entries below were found exactly that way.
- **The auditor and the security reviewer worked independently** of the agents that wrote the
  code and wrote their own scripts; their failures went back to the owning agent as bugs.
- **Key prompts** were the agent briefs in `.claude/agents/*.md` and `CLAUDE.md`: "Postgres is
  the truth, Redis may vanish", "concurrency is solved in the DB, not in process memory",
  "anything external can repeat, reorder or disappear", "never a float for money", "report only
  results you actually ran". Each stage brief ended with explicit done criteria (commands that
  must pass) instead of a description of the code.

## Claude Design handoff vs. code

No Claude Design export or handoff bundle is in the repo (`design/` does not exist), so there is
no design to compare against. The UI tokens live in `apps/web/src/app/globals.css` (light and
dark via `prefers-color-scheme`). This is listed as not done in the README.

## AI mistakes caught

What the AI proposed, why it was wrong, how it was caught, how it was fixed. Grouped by stage in
build order; every original entry is kept unchanged (one later-fix note added).

### P0 scaffold

- **P0 scaffold, `docker compose` flag:** the agent ran `docker compose up --build -d --progress plain`. Compose rejected it with `unknown flag: --progress` because `--progress` is a global flag, not an `up` flag. The failed run built nothing. The acceptance run used the unmodified `docker compose up --build -d` with `BUILDKIT_PROGRESS=plain`.

### P1 domain, database and orders

- **P1 domain, order id random source type:** the agent typed the random callback as a plain `Uint8Array`. All 161 unit tests passed because vitest does not typecheck, but `tsc` rejected it with TS2345 against `getRandomValues`. The type is now `Uint8Array<ArrayBuffer>`. This is why typecheck runs as well as the tests.
- **P1 db, wrong expectation in the 100-pair proof:** the agent's proof script expected 77 of the 100 status pairs to be rejected by the trigger. The real result was 23 allowed, 67 rejected and 10 not rejected. The 10 were same-status updates, which change nothing and write no event, so the trigger has no transition to reject. The trigger was correct and the expectation was wrong. The domain layer still rejects same-status moves in `assertTransition`.
- **P1 orders, nginx connection limit:** the scaffold left `events {}` in `nginx.conf`, so nginx had its default 512 connections per worker. The first 400-request oversell run died with `ECONNRESET`, and a repeat run counted 138 of 400 requests reset by the proxy. A burst inside the compose network reset as well, which ruled out the Docker Desktop port forward. Stock stayed correct throughout, with exactly 100 sold, so no test on order data could have caught this. `worker_connections` is now 8192, and 1000 parallel requests all get an answer.
- **P1 orders, test written through a script:** the agent added a domain test by rewriting the file from a Python script, and an escaped `
` came out as a real line break inside a string literal. `tsc`, `oxlint` and vitest all rejected the file with a parse error on the next check, before anything was committed. The value is now built with `String.fromCharCode(10)`.
- **P1 orders, error format at the proxy:** the first run of 58 malformed requests had 3 failures. A `%00` or a broken percent sequence in the path never reached the API, because nginx rejected it with its own HTML 400 page, so the "one error format" rule did not hold at the proxy. Testing the API alone would have missed this. `nginx.conf` now answers problem+json for the errors it produces itself.
- **P1 orders, first fix for the proxy errors:** the agent's first fix used `error_page 400` with a named location. The next full run showed it had made things worse: the same 3 requests went from an HTML 400 to an HTML 500, while a 503 for a stopped API worked. A named location cannot serve a request whose URI nginx already rejected. The config now redirects to a real URI, which was tried in a throwaway container before another full run.

### P1 payments, worker, refunds and reconciliation

- **P1 mock-pay, restart test arithmetic:** the agent's first restart test used a 50 ms backoff base, so the full retry sequence needed about 12.75 s, but the test waited only 8 s and failed with a timeout. The server was correct. The test now uses the suite's 20 ms base (about 5.1 s), and the real default backoff was also checked against the built image.
- **P1 worker, one reference per order:** the earlier schema and plan had one `reference` and one success per order, but `POST /topups` takes one sku. Sending each line of a two-line order under the same reference would have made `/stats` show 2, which reads as a double top-up. The agent caught this reading `mock-game` before writing the worker. The reference is now `<order_id>:<sku>`, and migration 0006 changes the unique index to match.
- **P1 worker, PL/pgSQL variable named like a column:** the first draft of `release_order_holds` had `WHERE code = code` with a variable called `code`. The agent noticed on a re-read before the migration ever ran. The variable is now `v_code`.
- **P1 refund, build failure hidden by `tail`:** a scripted edit to `refunds.service.ts` applied only partly, so the API image no longer compiled. The agent piped `docker compose up --build` through `tail -1`, which hid the failure, and the old containers kept running. A whole test run passed against the old code. A response saying `at most 0 satang`, text the agent had just removed, gave it away. The helper script now reports the compose exit code, and every result was taken again after the rebuild.
- **P1 reconciliation, oversized upload:** the malformed input run gave an HTML 413 about one time in three. The API answered as soon as a file passed 10 MB, which closed the connection mid-upload. nginx then treated that as a broken upstream and went to its error location, where the default 1 MB body limit raised a 413 of its own. A single run could have passed by luck. The API now reads to the end before answering, and the limit is set for the whole server block. Four repeat runs were clean.
- **P1 refund, acceptance only paid through mock-pay:** the agent's refund tests all paid at mock-pay and passed, so the report said 6 of 24 parallel refunds were accepted. The spec says the review team fires webhooks itself. The orchestrator's separate script paid with a signed webhook instead: mock-pay answered `PAYMENT_NOT_FOUND`, each refund became `FAILED` and gave its quota back, and 24 of 24 got 202 while the order moved to `NEEDS_REVIEW`. No money moved, so this was not an over-refund, but the refund flow does not work for orders paid that way. On first reading the 120000 satang of rows looked like an over-refund. The refund status column settled that, so the check now counts only rows that are not `FAILED`.
- **P1 refund, same-amount matching:** the agent's 43 refund checks and its worker crash checks all passed, but the audit found refunds stuck in `PENDING` after `docker kill worker`. A `payment.refunded` webhook names no refund, so `settle_refund` matched by amount and could settle a row that had never been sent. The row really sent then got `already_settled` and its job closed. The money stayed under the paid total, so the over-refund checks passed and the customer was short. Reconciliation also reported 0 mismatches. The orchestrator reproduced it from a fresh clone with `--only s3`: 14 passed, 3 failed. Not fixed yet at the time of this note. **Later fixed:** every refund job now sends its own `refund_id` unless its row is FAILED (ADR 0002, "Refunds"); `--only s3` and the full invariant audit pass since.
- **P1 refund fix, test module not updated:** the agent added `MockPayResetClient` to the reset controller and to `AppModule`, but not to the small module in `http-contract.spec.ts`. Lint and typecheck passed. Vitest crashed the worker with a Nest initialization error, so 9 tests in that file never ran, and the summary still read "99 passed". The spec now provides the client as a mock and checks that nothing is wiped when mock-pay cannot be reset.
- **P1 mock-pay, test that assumed delivery order:** a test written in an earlier stage read `calls[2]` as the payment webhook, but the refund webhook from the step before is delivered at the same time. It passed alone and failed in about 1 of 2 full `pnpm -r test` runs. The test now finds the webhook by `order_id`.
- **P1 refund fix, first SQL integration test:** the first draft inserted orders without `app.actor`/`app.reason`, which the status trigger requires, and reused one email for every SAVE10 redemption, which the per-email unique index refuses. 4 of 5 tests failed for setup reasons before any refund logic ran. Both are fixed in the test, not in the schema.

### Clean clone and audit scripts

- **Clean clone, typecheck before build:** `pnpm -r typecheck` failed with TS2307 on a fresh clone, because the apps read `@inblack/domain` from `dist` and nothing had built it yet. Every earlier check ran in a container that had already built it, so only the clean clone showed this. The domain package's `typecheck` now emits its output too, and pnpm runs it before the apps.
- **Audit script, weak first version:** the auditor's first script had 3 passes that proved too little: all requests landed on one replica, the kill arrived after the work had ended, and no order ever reached `FAILED`. The auditor reworked all three, and the final run reports how requests split between replicas and how many orders were in `IN_PROGRESS` at each kill.

### Web UI stage

- **Web UI stage, timeline order assumed from the API:** the agent's `Timeline` rendered events in the order received. The customer views were right because the SSE hook sorts by event id, but the first browser check of the admin detail showed `COMPLETED` above `order.created`: `GET /admin/orders/{id}` does not promise an order. `Timeline` now sorts by the bigint event id itself.
- **Web UI stage, commit with only deletions:** the agent's first `git add` named a file it had already removed with `git rm`, so git refused the whole list and the commit took only the staged deletions. `git show --stat` caught it before anything else was committed, and the commit (local, not pushed) was amended with the intended files.

### Security stage

- **Security stage, OTP race that locked out the winner:** the agent's first `decideVerify` counted every refused code as a wrong guess, including the right code sent again after it was used. Its unit tests passed, because they verified one request at a time. The first run of `scripts/audit/security.mjs` sent 10 verifies at once with the right code: one session row as required, but the answers were `[200, 401×4, 429×5]`, so the losers had locked the email for 15 minutes right after it signed in. A double-clicked button would do the same. The right code after use or expiry is now refused without counting (only someone who had the code can send it), a unit test sends it 9 more times and checks the counter stays 0, and the audit shows `[200, 401×9]`.
- **Security stage, track rate limit vs. an existing audit:** the new 10/min/IP limit on `/orders/track` would have failed `scripts/audit/sse.mjs`, which calls track once per order (about 11 times a minute) from one IP. The agent counted the calls before running it. The SSE audit now waits out a 429 using `Retry-After`, as a real client would; none of its stream checks were weakened.
- **P2 security, case-sensitive routing that did nothing:** the agent's first fix for `/METRICS` set Express's `case sensitive routing` after `NestFactory.create`. Express builds its router on first use, which had already happened, so the setting was ignored. The new unit test (`metrics-path.spec.ts`) got 200 for `/METRICS`, `/Metrics` and `/metricS`. `configureHttp` now also sets `caseSensitive` on the router itself before `init()` adds the routes. nginx refuses every spelling either way.
- **P2 security, line endings from a Windows script:** a Python edit run on Windows wrote CRLF into four LF source files. `git diff` warned before anything was committed and the files were converted back.

### P2 real-time and platform

- **P2 SSE, events ordered as text:** the agent's event query selected `id::text AS id` and ended with `ORDER BY id`, which Postgres resolves to the text alias, so event 10 sorted before event 9. The stream's guard against repeats then dropped 9. The new unit tests all passed, because they use an in-memory source, and the first SSE audit scenario passed too, because its order had ids 1 to 5. The reconnect scenario of `scripts/audit/sse.mjs` failed: a resume from Last-Event-ID 8 returned only event 10. The query now orders by `e.id`, the bigint column, and the same audit passes 10 of 10.
- **P2 readiness, Redis clients that retried every second:** all P2 checks and `sse.mjs` passed, but the full invariant audit failed 2 of 76 in `s7`: every refund got `503 DATABASE_UNAVAILABLE` while Redis was killed, after 10 s of `timeout exceeded when trying to connect` on both replicas at the same moment, with nothing in the Postgres log. The agent had added two Redis clients per API (stream signals and `/readyz`) that reconnected every second. With the Redis container gone, a lookup of `redis` took 5011 ms (`EAI_AGAIN`, measured inside api-1), and lookups run in libuv's 4-thread pool, so the Postgres connects queued behind them. `/readyz` now pings on the signal connection, reconnects back off to 3 s (5 s in the worker relay), and compose sets `UV_THREADPOOL_SIZE=16` for api and worker.
- **P2 platform, edits through shell one-liners:** the agent edited `nginx.conf` and two TypeScript files with inline `node -e` scripts inside bash. Bash expanded `$host`, `$request_id` and a template literal before node saw them, which left `proxy_set_header Host ;` lines and a `const requestId = ... : ;` in the files. The agent saw the damage in the diff output before any build or commit and redid the edits with the editor tool.

- **Final audit, host sleep read as a bug:** the final full audit failed `s7/refund-redis-down` with 20 refusals (`409 ORDER_NOT_REFUNDABLE`). The orchestrator first suspected the expiry worker, because one order looked expired 37 s before its `expires_at`. That order was the wrong example: the audit script itself had rewritten its `expires_at` with `expireNow()`. The auditor then found the real cause in the Windows System log: the laptop entered Modern Standby from 12:45:59 to 13:09:05 and froze every container for 23 minutes, past the 900 s TTL. The refund targets expired, their late payments were refunded automatically once each (ADR 0004), and the 409s were correct. The script now picks refund targets from orders that are really `COMPLETED` in the database and fails if there are none. The rerun on a fresh clone at `75ea4df` gave 76 passed, 0 failed.
