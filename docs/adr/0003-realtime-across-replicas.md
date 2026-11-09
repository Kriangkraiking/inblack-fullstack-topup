# ADR 0003: Real-time order status across replicas

Status: draft (P2)

## Context

Spec 8.3: a customer whose tracking page holds an SSE connection on api-1 must see a status
change within 2 seconds, even when the webhook landed on api-2 or the worker made the change.
After a dropped connection, `Last-Event-ID` must return the missed events with none repeated and
none skipped. Postgres is the source of truth and Redis may disappear at any time.

## Decision

1. **Events come only from `order_events`.** The row id is the SSE `id`. A stream keeps the last
   id it sent and every read is `WHERE order_id = $1 AND id > $last ORDER BY id`. Ids of one
   order commit in id order because each insert holds the order row's lock (0002_orders.sql),
   so "greater than the last one sent" cannot skip a row that commits later.
2. **Signals are hints, never data.** A trigger on `order_events` sends `NOTIFY order_events`,
   which Postgres delivers only on commit. The worker LISTENs and publishes `order:{id}` to Redis.
   Each API replica subscribes to `order:{id}` while it holds a stream of that order and
   unsubscribes when the last one closes. A message just makes the stream read Postgres again.
   NOTIFY fires for every writer (API, worker, SQL functions, manual fixes), so no code path can
   forget to publish, and a crash after commit cannot lose the signal the way a publish in
   application code could.
3. **Polling covers lost signals.** While the replica's Redis subscriber is not `ready`, each
   stream reads Postgres every second. With Redis up it still reads every 5 seconds, which
   covers a worker restart or a message lost in transit. When Redis comes back every stream
   reads once at once.
4. **Subscribe, then read.** A new stream subscribes before its first read, so an event that
   commits in between is either in that read or announced after it. Reads never overlap per
   stream; a signal during a read makes it read once more.
5. **Access without the email in a URL.** `POST /orders/track` returns `events_token`, an
   HMAC-SHA256 over order id and expiry (1 hour) with `ORDER_EVENTS_TOKEN_SECRET`, compared with
   `timingSafeEqual`. Any failure, a bad checksum and an unknown order give the same 404.

## Consequences

- Latency on the normal path is commit, NOTIFY, worker, Redis, API: tens of milliseconds in
  `scripts/audit/sse.mjs`. With Redis stopped it is bounded by the 1 second poll (981 ms worst).
- If the worker is down, signals stop and streams fall back to the 5 second safety poll. The
  worker being down also stops fulfilment, so only the PAID step is affected in practice.
- Every open stream costs one indexed query per 5 seconds (per second during a Redis outage).
  At a few thousand concurrent streams this is still small; beyond that, raise the safety
  interval or move to one poll per replica for all its orders.
- The token cannot be revoked before it expires. It reveals only status changes of one order,
  which the holder already proved access to.

## Alternatives considered

- **Publish to Redis from application code after commit.** Needs a hook on every writer and
  loses the signal if the process dies between commit and publish.
- **Each API replica LISTENs on Postgres directly.** Would work without Redis, but the spec asks
  for Redis pub/sub, and it holds one extra Postgres connection per replica.
- **Email in the query string.** Ends up in proxy and browser logs, so rejected.
