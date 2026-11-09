# ADR 0004: Payment that arrives after an order expired

Status: Draft. Built in the webhook and worker, see ADR 0002.

## Context

Spec section 6 says `payment.succeeded` on an EXPIRED order must re-reserve and continue, or refund automatically when there is no stock. The diagram in section 5.3 has no edge out of EXPIRED, and also no edge out of NEEDS_REVIEW. Section 5.3 also says any transition outside the diagram must be rejected, so the two sections conflict.

## Decision

Section 6 is the more specific rule, so we add the fewest edges that make it work. `ORDER_TRANSITIONS` in `packages/domain/src/order-state.ts` and `order_status_transitions` in `db/migrations/0002_orders.sql` hold the same list, and a test fails if they drift.

| Added edge | When |
|---|---|
| EXPIRED → PAID | Payment matches the total, and stock, per-email allowance and voucher were all re-acquired |
| EXPIRED → REFUNDED | Payment matches the total but something could not be re-acquired, once the automatic refund has settled |
| NEEDS_REVIEW → PAID | A person confirms the payment is good; fulfilment continues from PAID |
| NEEDS_REVIEW → COMPLETED | A person confirms the top-up was delivered, for example from `GET /topups/{reference}` |
| NEEDS_REVIEW → REFUNDED | A person refunds the order in full |

EXPIRED → NEEDS_REVIEW already follows from the last line of the diagram, and it is the path for a late payment with the wrong amount.

### Handling a late payment

`decideLatePayment` in the domain package makes the decision. In one transaction, the webhook handler:

1. Sets `paid_satang`. A wrong amount goes to NEEDS_REVIEW and stops here.
2. Re-acquires stock with the conditional UPDATE, re-checks the per-email limit, and re-acquires the voucher with a new `voucher_redemptions` row and the conditional UPDATE on `used_count`.
3. On success, moves EXPIRED → PAID. Otherwise it rolls back step 2 only, inserts a PENDING refund for the full amount, and writes an outbox job. The order stays EXPIRED until the refund settles, then moves to REFUNDED.

The voucher and the per-email limit are re-checked as well as stock. Without that, an expired order could take SAVE10 past 10 uses or FLASH-SKIN-01 past 2 per email, after the slot had gone to someone else, which breaks invariant 4.

### Partial refunds

A partial refund never changes the status. The order keeps its status and `refunded_satang` grows. The trigger on `orders` only allows REFUNDED when SUCCEEDED refunds add up to exactly `paid_satang`.

## Other cases

- `payment.failed` after `payment.succeeded`: there is no edge from a paid status to PAYMENT_FAILED, so the event is recorded and ignored.
- `payment.succeeded` on PAYMENT_FAILED: goes to NEEDS_REVIEW. The spec does not cover it, and a person should look at money received on an order we already told the customer had failed.
- Admin retry of a FAILED order: FAILED → NEEDS_REVIEW → PAID → IN_QUEUE, which reuses the edges above instead of adding FAILED → IN_QUEUE.

## Decisions made while building it

- **Late payment that cannot be fulfilled:** the order stays EXPIRED while the refund is PENDING, with a `payment.late_refund` event giving the reason, then moves to REFUNDED when it settles. If the provider refuses the refund, it goes to NEEDS_REVIEW.
- **`payment.succeeded` while in NEEDS_REVIEW:** recorded, and `paid_satang` set if it was 0. A person decides from there.
- **A second `payment.succeeded` with a new `event_id` on a paid order:** the status does not change, a `payment.duplicate` event is written, and reconciliation reports it as STATUS_MISMATCH. It is not refunded automatically, because the provider's duplicate delivery and a real second charge look the same from here.
- **Refunding NEEDS_REVIEW:** allowed up to `paid_satang`, including on an amount mismatch. A full refund moves it to REFUNDED.
- **Stock on refund:** FAILED to REFUNDED gives back stock and voucher, because GET confirmed nothing was delivered. COMPLETED to REFUNDED does not, because the player has the item. NEEDS_REVIEW to REFUNDED does not, because we do not know. This errs on selling less, never on overselling.
- **Admin retry:** FAILED or NEEDS_REVIEW only, and only if the order is paid in full, reached IN_QUEUE before (so it still holds its stock and voucher), and has no refund. In practice a FAILED order nearly always has its automatic refund already, so retry is mainly for NEEDS_REVIEW.

## Consequences

- The state machine is larger than the spec's diagram, and a reviewer has to read this ADR to see why.
- PAYMENT_FAILED and EXPIRED are not fully terminal.
- Changing the edges needs a new migration plus a domain change, and the drift test enforces both.
