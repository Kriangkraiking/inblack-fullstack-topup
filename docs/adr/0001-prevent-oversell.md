# ADR 0001: Preventing oversell and duplicate orders

Status: Draft.

## Context

Two API replicas take orders at the same time, so nothing held in the memory of one process can protect stock, voucher limits or idempotency. Spec 5.4 makes any oversell or over-use of a voucher an immediate failure.

## Decision

All of it is settled in Postgres, in one transaction per request.

| Rule | Mechanism |
|---|---|
| Stock | `UPDATE products SET stock = stock - $n WHERE sku = $s AND stock >= $n`. Zero rows means `OUT_OF_STOCK`. `CHECK (stock >= 0)` is the last line of defence. |
| Voucher total | `UPDATE vouchers SET used_count = used_count + 1 WHERE ... used_count < max_uses`. Zero rows means `VOUCHER_EXHAUSTED`. `CHECK (used_count <= max_uses)` backs it up. |
| Per email | `pg_advisory_xact_lock(727002, hashtext(email))`, then the count, then the write. A SUM over rows other requests are still inserting cannot be protected by a row lock, so the lock covers the whole email. The partial unique index on `voucher_redemptions` backs up the voucher case. |
| Idempotency | See below. |

### Idempotency in a single transaction

The key row is inserted with `ON CONFLICT DO NOTHING` as the first statement, in the same transaction as the reservation and the stored response.

- A parallel request with the same key blocks on the unique index until the first transaction ends, then reads the committed response. No polling is needed.
- A crash rolls back the key as well, so a key cannot stay stuck "in progress", and there is no status for that to represent.
- Business errors such as `OUT_OF_STOCK` roll back to a savepoint, which keeps the key and stores the error, so a retry gets the same answer.
- 5XX errors roll back everything, so a retry runs again and can succeed.
- A body that fails validation is not stored, so a client can fix it and keep the key.
- Requests are compared by a hash of the validated input, not the raw body, so formatting and unknown fields cannot make the same request look different.

The alternative was a separate "reserve key" commit followed by the work, with waiters polling. That needs a recovery path for abandoned keys and gives nothing in return here.

The trade-off is that a waiting request holds a pooled connection while it blocks. The request it waits for already has its own connection and never takes a second one, so this cannot deadlock the pool.

### Lock order

Every writer takes locks in this order, which keeps these paths free of deadlocks:

1. Idempotency key
2. Email advisory lock
3. Existing order row (expiry and webhooks; order creation has none)
4. Products, sorted by SKU
5. Voucher

The late-payment path in ADR 0004 re-acquires stock and vouchers, so it must follow the same order and take the same advisory lock. Expiry handles one order per transaction, because a batch could hold a voucher from its first order while waiting on a product for its second.

### Database role

api and worker connect as `inblack_app`, which is not a superuser and owns nothing. Otherwise a bug or an injected statement could disable the triggers that these guarantees rely on. Only `migrate` and the test-only reset use the owner. Each new table needs its own GRANT, because the role gets no default privileges.

## Consequences

- Flash sale orders run one at a time through the product row. That is the point, and the lock is held for a few short statements.
- `POST /api/v1/_test/reset` needs `TEST_ADMIN_DATABASE_URL` as well as `APP_ENV=test`.
