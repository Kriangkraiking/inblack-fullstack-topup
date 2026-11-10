# Runbook

For on-call. Commands assume the compose stack from the repo root (container names `inblack-*`).
Every command below was run against the local stack at `4407e13` unless it is marked
**not run** (those change money or state). Money columns are satang.

Shortcuts used below:

```sh
# SQL as the table owner (test credentials from docker-compose.yml)
alias ibsql='docker compose exec -T postgres psql -U inblack_user -d inblack_topup'
# admin session for curl (finance can refund and reconcile; support can retry)
curl -s -c fin.jar -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"email":"finance@inblackm.test","password":"Finance-Test-2026"}' \
  http://localhost:8080/api/v1/admin/auth/login
# same with support@inblackm.test / Support-Test-2026 into sup.jar for retry-fulfillment
# every cookie request that changes data needs -b fin.jar -H 'Origin: http://localhost:3000'
```

Admin login is limited to 10 attempts/min per IP and 5 per email per 15 minutes (429 `LOGIN_LOCKED`).

## General rules

- **Postgres is the truth.** Never "fix" by editing Redis or by re-sending to mock-game by hand.
- **Never POST to mock-game yourself.** Check `GET http://localhost:4020/topups/<order_id>:<sku>` first; the worker does the same.
- **Status changes go through `transition_order()`**, which writes the `order_events` row and is checked against the allowed edges. A plain `UPDATE orders SET status` is refused by the trigger unless `app.actor`/`app.reason` are set; use the function.
- **`docker kill` does not come back on its own.** `restart: unless-stopped` does not restart a killed container (tested with every restart policy). Bring it back with `docker compose start <service>` or `docker compose up -d`.

## Health and metrics

```sh
docker compose ps                                   # every service should be (healthy)
curl -s http://localhost:8080/healthz               # liveness of whichever replica answers
curl -s http://localhost:8080/readyz                # {"status":"ready","checks":{"postgres":"ok","redis":"ok"}}, 503 NOT_READY otherwise
docker compose exec -T api-1 wget -qO- localhost:3000/metrics    # /metrics is 404 through nginx
docker compose exec -T api-2 wget -qO- localhost:3000/metrics
```

`http_request_duration_seconds` is per replica (sum both). The `inblack_*` gauges come from
Postgres and are the same on both: `inblack_orders{status=...}`, `inblack_queue_depth{topic=...}`,
`inblack_fulfillment_retries`, `inblack_outbox_job_retries`, `inblack_dead_letters{state="open"}`,
`inblack_metrics_db_up`. The worker has no HTTP port; its health is the heartbeat file checked
by compose (`/tmp/worker-heartbeat`, stale after 90 s).

Watch for: `inblack_dead_letters{state="open"} > 0`, `inblack_orders{status="NEEDS_REVIEW"}`
growing, `inblack_queue_depth` growing while the worker is healthy, `/readyz` 503.

## Following one request (logs)

Logs are JSON lines with `request_id`. nginx sets `X-Request-Id` if the client sent none (and
returns it in the response). The webhook stores it in the outbox job, and the worker passes it to
mock-game, so one payment can be followed end to end:

```sh
docker compose logs --no-log-prefix api-1 api-2 worker mock-game | grep <request_id>
# all requests for one route with a given status:
docker compose logs --no-log-prefix api-1 api-2 | grep '"route":"/api/v1/webhooks/payment"' | grep '"status":401'
```

Emails in logs are masked; tokens, cookies and signatures are never logged.

## Orders stuck in NEEDS_REVIEW

**Symptom:** `inblack_orders{status="NEEDS_REVIEW"}` rising; admin list filter `NEEDS_REVIEW`.

```sh
curl -s -b fin.jar 'http://localhost:8080/api/v1/admin/orders?status=NEEDS_REVIEW'
ibsql -c "SELECT o.id, o.total_satang, o.paid_satang, o.refunded_satang, e.reason, e.created_at
          FROM orders o JOIN LATERAL (SELECT reason, created_at FROM order_events
            WHERE order_id = o.id ORDER BY id DESC LIMIT 1) e ON true
          WHERE o.status = 'NEEDS_REVIEW' ORDER BY e.created_at;"
ibsql -c "SELECT reference, attempt_no, status, http_status, error FROM fulfillment_attempts WHERE order_id = '<id>' ORDER BY id;"
curl -s http://localhost:4020/topups/<order_id>:<sku>      # for every line of the order
```

The last event's `reason` says why. Decide per order:

| Finding | Action |
|---|---|
| Every line found at mock-game | Mark delivered: `ibsql -c "SELECT transition_order('<id>','NEEDS_REVIEW','COMPLETED','ops:<your name>','confirmed via GET /topups');"` (returns `t` on success). There is no admin endpoint for this edge yet. Then resolve its dead letter (below). |
| No line found, paid in full, never refunded | Retry: `curl -s -b sup.jar -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' -d '{"reason":"..."}' http://localhost:8080/api/v1/admin/orders/<id>/retry-fulfillment` (support+). It moves NEEDS_REVIEW → PAID → IN_QUEUE, resolves the open dead letter, and the worker GETs before any POST. Refused with 409 if the order has a refund, was not paid in full, or never reached fulfillment. |
| Wrong amount paid (`paid_satang <> total_satang`) or money on a failed/expired order | Refund what was paid (finance), see "Refund" below. |
| Some lines delivered, others not | Refund the undelivered lines only (partial refund). Do not retry the whole order. |

## Dead letters (DLQ)

**Symptom:** `inblack_dead_letters{state="open"} > 0`.

```sh
ibsql -c "SELECT id, topic, aggregate_id, attempts, last_error, created_at FROM dead_letters WHERE resolved_at IS NULL ORDER BY id;"
```

- `fulfillment.requested`: the order is in `NEEDS_REVIEW` or `FAILED`. Handle the order as above.
  `FAILED` orders already got an automatic refund in the same transaction (check `refunds`).
- `refund.requested`: the refund ran out of retries and stays `PENDING` (the provider may have
  done it). See "Refund stuck in PENDING".

After handling an order by hand (not via retry-fulfillment, which does this itself):

```sh
ibsql -c "UPDATE dead_letters SET resolved_at = now(), resolved_by = 'ops:<your name>' WHERE id = <id> AND resolved_at IS NULL;"
```

**Not run** in this check (changes state). Escalate if dead letters keep appearing for new orders
while mock-game and mock-pay are healthy: that is a bug, not an outage.

## Refund

Finance, idempotent by key (the same key returns the same answer byte for byte). Partial amounts
allowed up to `paid_satang − refunded_satang`. **Not run** here:

```sh
curl -s -b fin.jar -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"amount_satang": 26187, "reason": "..."}' \
  http://localhost:8080/api/v1/admin/orders/<id>/refund          # 202, refund PENDING until settled
```

## Refund stuck in PENDING

```sh
ibsql -c "SELECT id, order_id, amount_satang, status, created_at FROM refunds WHERE status = 'PENDING' ORDER BY created_at;"
ibsql -c "SELECT id, attempts, available_at, last_error FROM outbox WHERE topic = 'refund.requested' AND processed_at IS NULL;"
docker compose logs --no-log-prefix worker | grep refund | tail -20
```

- An open outbox job: it is still retrying (backoff up to 60 s). Check mock-pay health. Wait.
- No open job: retries ran out with no answer. The amount stays reserved, so no second refund can
  exceed the paid total. Compare with the provider: `curl -s http://localhost:4010/settlements.csv | grep <order_id>`.
  If the provider shows the refund, a late `payment.refunded` webhook will settle the row; if it
  never arrives, escalate (settling by hand means calling `settle_refund` with the provider event id).
- Do **not** create a new refund for the same money while one is PENDING.

Reconciliation also reports PENDING refunds older than 15 minutes as `STATUS_MISMATCH`.

## Reconciliation mismatch

Run (finance), with the provider's file:

```sh
curl -s http://localhost:4010/settlements.csv -o settlements.csv
curl -s -b fin.jar -H 'Origin: http://localhost:3000' -H 'Content-Type: text/csv' \
  --data-binary @settlements.csv http://localhost:8080/api/v1/admin/reconciliation
# {"rows":1,"counts":{"MISSING_IN_SYSTEM":0,"MISSING_AT_PROVIDER":0,"AMOUNT_MISMATCH":0,"STATUS_MISMATCH":0},"mismatches":[]}
```

Optional `?from=...&to=...` (ISO time) limits the window. Each mismatch names `event_id` and `order_id`.

| Type | Meaning | What to do |
|---|---|---|
| `MISSING_IN_SYSTEM` | The provider took money we have no webhook for (webhook lost, e.g. Postgres down longer than mock-pay's ~4 min of retries). | Find the order; if still PENDING_PAYMENT/EXPIRED, the payment must be applied or refunded. Re-delivering the signed webhook is the safe path (same `event_id` is idempotent). Otherwise escalate to finance for a manual refund. |
| `MISSING_AT_PROVIDER` | We recorded a payment the provider file does not have. | Check the file window first. If real, the order must not be fulfilled further: put it in review and escalate (possible forged webhook means the secret leaked). |
| `AMOUNT_MISMATCH` | Event or order `paid_satang` differs from the provider amount. | The order should already be NEEDS_REVIEW; refund the difference or the whole payment. |
| `STATUS_MISMATCH` | Refund totals differ, a duplicate `payment.succeeded` (`payment.duplicate` event), or a PENDING refund nobody will send / older than 15 min. | Duplicate charge: confirm with the provider, then a partial refund. PENDING: see above. |

Escalate to finance for any mismatch you cannot explain from `webhook_events` and `order_events`.

## mock-game down for a whole day

What the system does by itself: each order's GET cannot answer, so the worker never POSTs; after
5 claims (about a minute) the order goes to `NEEDS_REVIEW` with a dead letter. No money moves and
nothing is delivered twice. If mock-game is up but refuses every POST, orders end `FAILED` with an
automatic full refund once a GET confirms nothing was delivered.

1. **Confirm:** `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4020/healthz`, `docker compose ps mock-game`, worker logs.
2. **Optional, slow the pile-up:** `docker compose stop worker` keeps new jobs in the outbox
   instead of sending them to review. Side effects: expiry, refunds and the SSE signal relay stop too
   (streams fall back to 5 s polling), and customers see IN_QUEUE. Start it again with
   `docker compose start worker`. **Not run** here. With the worker running, orders simply
   collect in NEEDS_REVIEW, which is also safe.
3. **Customers:** status page / banner that top-ups are delayed and paid orders will be delivered
   or refunded; no need to pay again. Do not promise a time until mock-game is back.
4. **When mock-game is back:** retry each NEEDS_REVIEW order (table above). The worker GETs every
   reference first, so a top-up that did land before the outage is not repeated.
5. **If the business decides to refund instead (batch):** only for orders where every line's
   `GET /topups/<order_id>:<sku>` is 404 and `refunded_satang = 0`. Use one fixed
   `Idempotency-Key` per order (e.g. `outage-<date>-<order_id>`) so a re-run of the batch cannot
   refund twice; the DB also refuses any refund above `paid_satang`. Refunding a NEEDS_REVIEW
   order does not return stock (we cannot prove nothing was delivered). **Not run** here.

Escalate after 30 minutes of outage, or immediately if `/stats` shows any reference with a count above 1.

## Many webhooks rejected (401 INVALID_SIGNATURE)

```sh
docker compose logs --no-log-prefix api-1 api-2 | grep '"route":"/api/v1/webhooks/payment"' | grep -c '"status":401'
docker compose exec -T api-1 date -u; date -u                  # clock skew: more than 300 s is refused
docker compose exec -T api-1 printenv PAYMENT_WEBHOOK_SECRET   # compare with mock-pay's (do not paste it anywhere)
docker compose exec -T mock-pay printenv PAYMENT_WEBHOOK_SECRET
```

Causes: secret rotated on one side only, clock skew, a proxy changing the body (the signature is
over the raw bytes, header `X-IBM-Signature: t=<unix>,v1=<hex hmac>`). Rejected webhooks change
nothing and the provider retries, so fix the secret/clock within mock-pay's retry window (about
4 minutes) and the backlog delivers itself; later ones show up as `MISSING_IN_SYSTEM`. Escalate
immediately if signatures fail while the secrets match: someone may be forging webhooks.

## Redis down

Symptoms: `/readyz` 503 (`redis` check), warnings from the rate limiter. Effects: live tracking
falls back to 1 s polling, the worker still polls the outbox every second, track and per-IP admin
login limits are not enforced (OTP lock and per-email admin lock still are). No data is at risk.

```sh
docker compose ps redis
docker compose start redis      # or: docker compose up -d redis
```

Escalate if it does not stay up; meanwhile watch `/orders/track` traffic for abuse.

## Postgres down

Symptoms: API 503 `DATABASE_UNAVAILABLE`, `/readyz` 503, `inblack_metrics_db_up 0`, worker idle.
Nothing is acknowledged without a commit, so orders and webhooks are simply refused and retried.

```sh
docker compose ps postgres
docker compose logs --tail 50 postgres
docker compose start postgres   # or: docker compose up -d postgres
```

After it is back: check `/readyz`, then run reconciliation for the outage window (webhooks that
outlived mock-pay's retries appear as `MISSING_IN_SYSTEM`). Escalate at once if the data volume
is damaged; there is no backup or replica in this setup.
