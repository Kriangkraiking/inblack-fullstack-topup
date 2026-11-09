# ADR 0002: Idempotency of webhooks and fulfillment

Status: Draft.

## Context

Spec 5.4 makes a double top-up an immediate failure, and every message can arrive twice, out of order or not at all. Any process can die between two lines. mock-game does not protect us: every POST it commits counts as another top-up, and `SUCCESS_BUT_TIMEOUT_RATE` makes it commit and then never answer.

## Webhook

`POST /api/v1/webhooks/payment`, in this order:

1. Verify `X-IBM-Signature` over `req.rawBody` with `timingSafeEqual`. The header format is checked first, so both sides are always 32 bytes. `t` more than 300 seconds away is refused. All of these are 401 `INVALID_SIGNATURE`.
2. Validate the body with Zod. 422 on failure.
3. In one transaction: `INSERT INTO webhook_events ... ON CONFLICT (event_id) DO NOTHING`, the status change, its `order_events`, the outbox job, then commit and answer 200.

The primary key does the deduplication. A copy arriving during the first one blocks on the index until it commits, then sees the row and answers 200 with outcome `duplicate`. If the first one crashed, the row rolled back with it, so the provider's retry starts clean. No `processing` state exists that could get stuck. The same reasoning as ADR 0001.

Lock order is the one in ADR 0001: event row, email advisory lock, order row, products by SKU, voucher. The email is read before the order lock, which is safe because it never changes. `payment.succeeded` always takes the email lock, because a late payment re-checks the per-email limit.

| Event | Order status | Result |
|---|---|---|
| `payment.succeeded`, amount matches | PENDING_PAYMENT | PAID, IN_QUEUE and the job, in one transaction |
| `payment.succeeded`, wrong amount or not THB | PENDING_PAYMENT, EXPIRED | Records `paid_satang`, NEEDS_REVIEW. No top-up |
| `payment.succeeded` | EXPIRED | ADR 0004: re-acquire, otherwise refund |
| `payment.succeeded` | PAYMENT_FAILED | NEEDS_REVIEW, ADR 0004 |
| `payment.succeeded`, new `event_id` | Already paid | Status unchanged, `payment.duplicate` event. Reconciliation reports it |
| `payment.failed` | PENDING_PAYMENT | PAYMENT_FAILED, gives back stock and voucher in the same transaction |
| `payment.failed` | Anything else | Status unchanged, `payment.failed_ignored` event |
| `payment.refunded` | Has a matching PENDING refund | Settled |
| `payment.refunded` | No match | NEEDS_REVIEW, because money moved that we did not ask for |
| Any | Unknown order | Recorded, answers 200, so the provider stops retrying |

## Outbox and leases

A job is a row written in the transaction that changes the status, so "status changed but no job" cannot happen. Workers claim with `FOR UPDATE SKIP LOCKED` and push `available_at` forward by the lease. The claim commits at once, so no connection or lock is held during HTTP.

A worker that dies needs no special handling: `available_at` passes and the next poll takes the job. `attempts` goes up on each claim, and `(id, attempts)` works as a fencing token, so a worker that stalled past its lease cannot change anything once another one has claimed the job. Started jobs go ahead of new ones, because their orders are on the 2 minute clock. `requeueOrphans` is only a safety net and should find nothing.

Redis only wakes the worker sooner. Polling runs every second regardless, and publishing never fails a request.

## Never topping up twice

**The rule:** POST only straight after a GET answered 404, and only when nothing else could still land. A timeout, a 5XX on GET, a network error or a 200 with no count all mean "we do not know", and not knowing never leads to a POST.

An order can have several lines and mock-game takes one sku per POST, so the reference is `<order_id>:<sku>`. It never changes across retries.

Each claim, for each line:

1. `GET /topups/{reference}`. Found: this line is done. Unknown: retry later.
2. Stop if this is the last claim or the POST limit was reached. The line is not delivered.
3. Insert `fulfillment_attempts` as IN_FLIGHT and renew the lease, then commit. Insert is refused if this claim is no longer ours or another attempt is in flight (a partial unique index).
4. POST. Record the result as SUCCEEDED, FAILED or UNKNOWN.

### The timing trap

The trap: the client times out while mock-game is still inside `LATENCY_MS`, before it commits. A GET at that moment could answer 404, a second POST goes out, and the first one then commits as well.

In `apps/mock-game/server.js` the delay runs before routing for both methods, and the state is read after it. So a GET sent after a POST reads the state after that POST's commit, whatever the latency. Our reading of 404 is therefore correct with this mock. We do not want to depend on that alone, so:

- After a timeout there is a settle wait before the next GET (`FULFILLMENT_SETTLE_MS`, 5 s). A POST that was already on its way has had POST timeout + settle = 13 s to land, on top of the GET's own delay in this mock.
- The GET has its own timeout. With `LATENCY_MS` above it the GET cannot answer, the state stays unknown, and no POST goes out. The order ends in NEEDS_REVIEW.
- After a crash, an IN_FLIGHT attempt is only taken over when the lease has ended. The worker refuses to start unless the lease is longer than POST timeout + settle + GET timeout, so whoever sent that POST has timed out and it has had the settle time.

Two runs tested this directly. A 3 s POST timeout against 6 s of `LATENCY_MS`: every POST timed out first and committed afterwards, the next GET found it, and all 12 orders completed with a count of 1. `LATENCY_MS` of 12 s, above the 8 s GET timeout: no POST went out at all, and all 4 orders went to NEEDS_REVIEW.

### When it stops

Five claims at most: up to three rounds of GET and POST, and a last claim that only reads. A last read means the decision always rests on a fresh GET after the settle wait.

| Last known state | Result |
|---|---|
| All lines found | COMPLETED |
| A GET still cannot answer | NEEDS_REVIEW and dead letter. No guessing |
| Some lines found, others confirmed not delivered | NEEDS_REVIEW and dead letter. A full refund would be wrong |
| No line delivered, confirmed by GET | FAILED, dead letter and automatic refund, in one transaction |

Defaults: 3 x (8 s POST + 5 s settle + up to 4 s backoff) is about 51 s, and after a crash up to 25 s of lease on top. So an order leaves IN_PROGRESS inside the 2 minutes of spec section 7 once the system is back. The first defaults (10 s, 10 s and a 35 s lease) reached 119 s by the raw clock in a run with two kills, too close to the limit. The cost of the shorter timeouts: with `LATENCY_MS` of 8 s or more, every order ends in NEEDS_REVIEW. That is safe, and the timeouts can be raised through env.

### What remains

A worker could stall between committing the attempt and sending the bytes, for longer than the lease, while a second worker takes over. We shrink that window by checking the elapsed time right before the POST, but only a provider with real idempotency could close it. Compose runs one worker, which cannot race itself.

## Refunds

Same single-transaction idempotency as orders (ADR 0001), scoped per order. The order row lock runs concurrent refunds one at a time, `planRefund` checks the remainder, and the database backs it up with `orders_refund_within_paid`.

The API only writes the PENDING row and the job, and the worker calls `POST /refunds`. `refund_id` is `refunds.refund_ref`, random rather than the identity value, because `_test/reset` restarts identities and mock-pay keeps its journal. Resending it is always safe.

Settling is one SQL function, `settle_refund`, used by both the webhook and the answer to `POST /refunds`, whichever comes first. The webhook names no refund, so it matches on amount, and the worker's answer prefers its own row. Each event settles exactly one PENDING row, and an event already used is a no-op. `provider_event_id` is unique, which backs this up.

Matching on amount alone was not enough (audit, `s3/same-amount-order`). With two PENDING rows A and B of 5000, a worker that sent B and died left B's webhook to settle A, the lowest id. The restarted job for A then saw a row that was not PENDING and closed without sending, and B's job got `already_settled`. The provider had one refund, the database one settled and one stuck PENDING, and nothing would ever send A. The fix, chosen as the simplest one that can be argued for every interleaving: **every refund job sends its own `refund_id` unless its row is FAILED**, even when a webhook already settled that row. Why the totals then match:

- `refund_id` is idempotent at the provider, so each row produces at most one provider refund, and every row that is not refused produces exactly one once its job gets an answer.
- Each provider event settles exactly one PENDING row of the same order and amount, and never twice.
- So per order and amount, settled rows = provider refunds, whichever row an event lands on. A row settled by another row's event still sends its own `refund_id`, and the refund that creates settles the row that is still PENDING.
- What is left PENDING is only a row whose job ran out of retries with no answer, which is real uncertainty. Reconciliation reports it.

An alternative was a `sent_at` column, matching webhooks only to rows already sent. It does not remove the ambiguity between two sent rows, so the job still has to keep sending, and it adds a write before every POST.

**Payments the provider never saw.** The review team signs its own `payment.succeeded` webhooks, so mock-pay can be asked to refund an order it has no payment for. The worker sends `paid_satang` and the `event_id` of the webhook that paid the order with every `POST /refunds`. mock-pay uses them only when it has no payment for that order: it records the payment under that `event_id` (in its journal and settlement file, without sending a webhook), then checks the balance as usual. A payment it already knows is never changed by `paid_satang`. Reconciliation then sees the same `event_id` and amount on both sides.

**Reconciliation** also reports, as `STATUS_MISMATCH`, every PENDING refund that no open job will send, and every PENDING refund older than 15 minutes.

**Stock and voucher use on a refund.** A full refund returns the holds when the order was FAILED, or when it never reached `IN_QUEUE` (for example NEEDS_REVIEW after an amount mismatch), because nothing went to the game. Such an order may have returned them already on its way through EXPIRED or PAYMENT_FAILED, so migration 0007 adds `order_hold_releases`: `release_order_holds` gives stock and voucher use back only when it changes that row from held to released. A late payment that re-acquires (ADR 0004) marks it held again. The expiry worker uses the same function.

A refund the provider refuses goes to FAILED, gives its amount back, and the order goes to NEEDS_REVIEW. A refund that runs out of retries stays PENDING, because the provider may have done it, so the amount stays reserved and a late webhook can still settle it.

## Consequences

- A hanging provider costs an order about 13 s per try, in exchange for not having to trust a timeout.
- Under load, a refund reports PENDING first and settles later. The API answers 202.
- `/stats` shows `<order_id>:<sku>`, not the order id alone.
