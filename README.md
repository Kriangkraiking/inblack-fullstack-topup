# InBlack Top-Up

Game top-up shop: catalog, checkout with fees and vouchers, a mock payment provider, a worker that
tops up through a mock game API, live order tracking, customer OTP sign-in and an admin back office
with refunds and reconciliation. The goal of the design is "never lose money, never lose goods"
while any service can die at any moment. Money is integer satang everywhere.

More: [ARCHITECTURE.md](ARCHITECTURE.md) · [RUNBOOK.md](RUNBOOK.md) · [SEO.md](SEO.md) ·
[AI_LOG.md](AI_LOG.md) · [docs/adr/](docs/adr/) · [openapi.yaml](openapi.yaml) · spec: [docs/SPEC.md](docs/SPEC.md)

## Quick start (วิธีรัน)

Needs Docker with Compose v2. No `.env` file is needed: every variable in `docker-compose.yml`
has a local test default.

```sh
docker compose up --build -d --wait     # or without -d --wait to watch the logs
```

From a fresh clone without `.env` this exits 0 with every service healthy (checked several times,
last at `4407e13`). All published ports bind to `127.0.0.1` only.

| Service | URL | Notes |
|---|---|---|
| Web (Next.js) | http://localhost:3000 | catalog, `/checkout`, `/track`, `/my-orders`, `/admin`, `/admin/products` |
| API (nginx round-robin over `api-1`, `api-2`) | http://localhost:8080 | `/api/v1/...`, `/healthz`, `/readyz`. `/metrics` is 404 here on purpose, see [RUNBOOK](RUNBOOK.md#health-and-metrics) |
| mock-pay | http://localhost:4010 | hosted checkout page with scenario buttons, `GET /settlements.csv` |
| mock-game | http://localhost:4020 | `GET /stats`, `GET /topups/{reference}` |
| Mailpit | http://localhost:8025 | OTP and receipt mail (SMTP on 127.0.0.1:1025) |
| Postgres 16 | `127.0.0.1:5433` | db `inblack_topup`, owner `inblack_user` / `change_this_local_password` (test value) |

Redis, the worker and the API replicas are not published. Stop with `docker compose down`
(`down -v` also deletes the data volumes).

## Test credentials (ค่าทดสอบเท่านั้น)

Seeded by `db/seed/seed.sql` (hashes only); source: [docs/SEED_CREDENTIALS.md](docs/SEED_CREDENTIALS.md).
These are test values for local and review use, not real accounts.

| Role | Email | Password | Can do |
|---|---|---|---|
| viewer | `viewer@inblackm.test` | `Viewer-Test-2026` | read orders (emails masked; search by order id only) |
| support | `support@inblackm.test` | `Support-Test-2026` | + retry fulfillment |
| finance | `finance@inblackm.test` | `Finance-Test-2026` | + refunds, reconciliation, audit log |
| superadmin | `superadmin@inblackm.test` | `Superadmin-Test-2026` | + edit products (name, price, stock) |

Roles are ordered: each one includes the ones above it (`RequireRole` in `apps/api/src/admin/admin-roles.ts`).

**Customers** have no password. Enter any email at http://localhost:3000/my-orders, open
http://localhost:8025 and copy the 6-digit code (valid 5 minutes, single use, 5 wrong codes lock
the email for 15 minutes).

## Try it (flow ทดลอง)

1. **Buy:** http://localhost:3000 → pick items → checkout (fee and VAT update as you change the
   payment method or voucher). Example from a real browser run: MONTHLY-PASS + FLASH-SKIN-01,
   `FLAT20`, TrueMoney shows ฿261.87 total, fee ฿3.87, VAT ฿17.13, and mock-pay receives 26187.
2. **Pay:** you are sent to mock-pay. Each button is a scenario from spec section 6 (success,
   failure, duplicate webhook ×5, slow webhook, wrong amount, ...).
3. **Track live:** you come back to the order page; the timeline updates over SSE until the top-up
   completes. `/track` finds any order by order id + email. http://localhost:4020/stats shows one
   top-up per `<order_id>:<sku>`.
4. **Admin refund:** sign in at http://localhost:3000/admin as `finance`, open an order, refund →
   enter amount → confirm in a second step. Partial refunds are allowed up to the paid amount.
5. **Product edit:** sign in as `superadmin` → http://localhost:3000/admin/products. A stock edit
   must match the stock you saw, otherwise 409 `STOCK_CHANGED`.

## Running the tests

```sh
make test                       # lint, typecheck, unit, integration, e2e; stops at the first failure
node scripts/ci/test-all.mjs    # the same without make (Windows); also: pnpm test:all
```

Single steps: `make lint | typecheck | unit | integration | e2e` (or
`node scripts/ci/test-all.mjs <step> ...`); `make up` / `make down` for the main stack.
Needs Docker (Compose v2) and Node. With Node < 22.12 the pnpm steps run in the `node:22` image
on a copy of the working tree (pnpm store cached in the volume `inblack-ci-pnpm-store`).

- **integration**: `*.int.spec.ts` against a real, empty Postgres 16 + Redis 7: locally from
  `scripts/ci/integration.compose.yml` (project `inblack-ci-int`, ports 55432/56379, removed
  afterwards), in CI from service containers via `TEST_DATABASE_URL`. The tests apply the
  migrations and seed themselves. The step fails if any test skipped or none passed.
- **e2e**: `docker compose up --build -d --wait` of the working tree (project `inblack-e2e`), then
  `scripts/audit/sse.mjs`, `scripts/audit/invariants.mjs --reuse` against that stack, and
  `scripts/audit/security.mjs` when present; `down -v` afterwards (`--keep` leaves it up). It
  refuses to start while another project's `inblack-*` containers exist (fixed container names).
  This is the end-to-end layer; there is no Playwright browser suite.

CI (`.github/workflows/ci.yml`) runs the same steps: lint → typecheck → unit → integration → e2e →
`docker compose build`. Its e2e runs only `--invariants s1a,s2b,s3,s4`, one scenario per money or
goods invariant (s1a oversell burst, s2b duplicate/replayed webhooks, s3 concurrent refunds plus
reconciliation, s4 voucher limits). The others (s1b-s1d, s2a, s7, s8) repeat those invariants
through expiry, worker kills and api-1/Redis outages and take most of the run time, so `make e2e`
runs them all locally (`INVARIANTS=s7,s8 make e2e` for a subset).

### Latest results

| Check | Result | At |
|---|---|---|
| `scripts/audit/invariants.mjs` (all scenarios, fresh clone) | 76 passed, 0 failed | `75ea4df` (orchestrator, final run) |
| `scripts/audit/security.mjs` | 44/44 | `4407e13` and `6a7d274` (orchestrator) |
| `scripts/audit/sse.mjs` | 10/10 | `4407e13` and `6a7d274` (orchestrator) |
| GitHub Actions, all 6 jobs | green | `fd91f78`, `7cb51ba`, `4407e13` |

Run the full audit on a machine that will not sleep: it takes about 10 minutes, and a host that
suspends mid-run freezes every container past the 15-minute order TTL (see AI_LOG).

What the invariant audit shows: 600 concurrent orders for FLASH-SKIN-01 sell exactly 100; 100
paid orders with the worker killed 3 times give no reference above 1 top-up; concurrent refunds
from 2 admin sessions never exceed the paid amount and DB totals equal the provider's; SAVE10 is
used exactly 10 times out of 150 emails.

## Status (สถานะตามจริง)

Spec section numbers in brackets. ✅ done and tested · ⚠️ partial · ❌ not done.

| Area | Item | Status |
|---|---|---|
| Domain & money | Pricing with the 3 spec examples, integer satang end to end, order id checksum (CSPRNG + mod 997, also a DB `CHECK`), state machine in domain + DB trigger | ✅ |
| | Idempotency-Key on `POST /orders` (byte-identical replay, `IDEMPOTENCY_KEY_REUSED`), order expiry | ✅ |
| Concurrency [5.4] | No oversell, per-email limit, voucher limits, no double top-up, no over-refund — all under real concurrency | ✅ |
| Payments [6] | Signed webhook (HMAC, 300 s skew), duplicates, out of order, after EXPIRED (re-reserve or auto refund), wrong amount → NEEDS_REVIEW | ✅ |
| Fulfillment [7] | Transactional outbox, worker with lease + backoff + dead letter, recovery after kill, `SUCCESS_BUT_TIMEOUT` handled by GET-before-POST | ✅ |
| | mock-pay and mock-game written to spec | ✅ |
| | Refunds: partial, concurrent, idempotent; reconciliation API (CSV upload, 4 mismatch types) | ✅ |
| Real-time [8.3] | SSE across replicas via Postgres NOTIFY → worker → Redis pub/sub, `Last-Event-ID` resume, polling fallback without Redis | ✅ |
| Observability | `/healthz`, `/readyz`, Prometheus `/metrics` (latency histogram, orders by status, queue depth, retries, dead letters), JSON logs with `request_id` across api → worker → mock-game | ✅ |
| | OpenTelemetry / Jaeger | ❌ |
| Security [8.4] | OTP sign-in, server-side sessions, CSRF (SameSite=Strict + Origin allowlist), rate limits on track / OTP / admin login, IDOR → 404, PII masking, security headers + nonce CSP, admin RBAC | ✅ |
| Admin | Orders table with filters, detail + timeline, 2-step refund dialog, retry fulfillment (API), superadmin product edit | ✅ |
| | Live dashboard | ❌ |
| | Reconciliation UI page | ❌ (API only: `POST /api/v1/admin/reconciliation`) |
| Frontend [9.2] | Catalog, checkout (live fee, voucher, Game UID check), tracking with SSE + `aria-live`, My Orders (OTP), dark mode, `prefers-reduced-motion` | ✅ |
| | WCAG 2.2 AA / 320 px / keyboard-only checkout | ⚠️ built with these in mind, not formally audited |
| | Product page `/products/[slug]` with JSON-LD and dynamic OG image | ❌ |
| | i18n `/th` `/en` + hreflang | ❌ (Thai only) |
| | SSG/ISR | ❌ by choice: the nonce CSP needs per-request rendering, see [SEO.md](SEO.md) |
| | Lighthouse | ❌ not measured |
| Design [9.1] | Claude Design export in `design/` (HTML + PDF) | ❌ folder does not exist |
| SEO | robots.txt, sitemap.xml without private pages, `noindex` meta + `X-Robots-Tag` on track / my-orders / admin | ✅ |
| Testing & CI | Unit, integration (real Postgres/Redis), e2e via audit scripts, `make test`, GitHub Actions 6 jobs | ✅ |
| | Playwright browser E2E, contract tests | ❌ |
| | 100k-order seed + p95 measurement | ❌ |
| Bonus | Mobile app, deploy | ❌ |

## Configuration that matters

Copy `.env.example` to `.env` only to override defaults.

| Variable | Default | Why it matters |
|---|---|---|
| `COOKIE_SECURE` | `true` | Session cookies are `Secure`. Browsers keep them on `http://localhost`. **If you open the site by IP or another hostname over plain http, set `false`** or sign-in will not stick. |
| `APP_ENV` | `development` | `test` enables `POST /api/v1/_test/reset` (and mock-pay's reset). Any other value removes the reset function from the DB. |
| `CSRF_ALLOWED_ORIGINS` | `http://localhost:8080,http://localhost:3000` | Origins allowed to send cookie requests. Scripts using an admin cookie must send one of them as `Origin`. |
| `ORDER_TTL_SECONDS` | `900` | Payment window before EXPIRED. |
| `FAIL_RATE`, `TIMEOUT_RATE`, `SUCCESS_BUT_TIMEOUT_RATE`, `LATENCY_MS` | `0` | mock-game fault injection. |

**Every secret in `docker-compose.yml` / `.env.example` is a test value and must be replaced
before any real deployment:** `PAYMENT_WEBHOOK_SECRET`, `ORDER_EVENTS_TOKEN_SECRET`,
`OTP_HASH_SECRET`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, and the seeded admin passwords. No
`.env` is committed.

## Known limitations and accepted trade-offs

- **One worker.** Compose runs a single worker. Jobs are claimed with `FOR UPDATE SKIP LOCKED` and
  fenced by `(id, attempts)`, but running 2 workers has not been tested. ADR 0002 "What remains"
  describes the stall window that only a provider with real idempotency could close.
- **mock-pay trusts `paid_satang` for payments it never saw.** Reviewers sign their own webhooks,
  so the worker sends the paid amount with each refund and mock-pay records it if it has no
  payment for that order. Acceptable only because it is a mock (ADR 0002).
- **Rate limits fail open when Redis is down** (track, per-IP admin login). The OTP lock and the
  per-email admin login lock live in Postgres and still hold (ADR 0005).
- **Admin search is exact match** (order id or full email), no partial search.
- **`/metrics` latency is per instance**; scrape `api-1` and `api-2` separately. DB-derived gauges
  are the same on both.
- **Long Postgres outage loses provider webhooks after their retries.** mock-pay retries 8 times
  with exponential backoff (about 4 minutes in total); after that, reconciliation reports the
  payment as `MISSING_IN_SYSTEM` and it is handled by hand ([RUNBOOK](RUNBOOK.md#reconciliation-mismatch)).
- **NEEDS_REVIEW → COMPLETED has no admin endpoint.** The transition exists in the state machine;
  today an operator does it in SQL ([RUNBOOK](RUNBOOK.md#orders-stuck-in-needs_review)).
- **Low-severity security findings not fixed:** open redirect through mock-pay's `return_url`
  (mock only); the webhook parses JSON before verifying the signature (body limited to 100 kb).
- **`docker kill` is not restarted** by `restart: unless-stopped`; use `docker compose start <service>`.
- `apps/api/README.md`, `apps/worker/README.md` and `apps/web/README.md` are still mostly the
  framework starter text; the root documents are the reference.
