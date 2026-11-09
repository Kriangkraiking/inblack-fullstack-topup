-- Two fixes from the invariant audit, see ADR 0002.
--
-- 1. Stock had no guard against being returned twice. Each caller changed status under the
--    order lock first, which was enough while only EXPIRED, PAYMENT_FAILED and FAILED -> REFUNDED
--    returned holds. A full refund of an order that never reached the queue must return them as
--    well, and that order may already have returned them on its way through EXPIRED or
--    PAYMENT_FAILED. order_hold_releases records whether the holds are currently given back, so
--    release_order_holds can run any number of times and returns stock and voucher use once.
--
-- 2. A full refund of an order that never reached the queue (for example NEEDS_REVIEW after an
--    amount mismatch) now returns its holds: nothing was delivered.

CREATE TABLE order_hold_releases (
  order_id   text PRIMARY KEY REFERENCES orders (id),
  -- true: stock and voucher use are back with the shop. false: the order took them again after
  -- a late payment (ADR 0004), so a later release is due.
  released   boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON order_hold_releases TO inblack_app;
GRANT UPDATE (released, updated_at) ON order_hold_releases TO inblack_app;

-- Orders that already gave their holds back before this migration, so the guard starts right.
-- Released means: a move to EXPIRED or PAYMENT_FAILED, or FAILED -> REFUNDED, with no late
-- payment that took the holds again afterwards.
INSERT INTO order_hold_releases (order_id, released)
SELECT DISTINCT e.order_id, true
FROM order_events e
WHERE e.event_type = 'status.changed'
  AND (e.to_status IN ('EXPIRED', 'PAYMENT_FAILED') OR (e.from_status = 'FAILED' AND e.to_status = 'REFUNDED'))
  AND NOT EXISTS (
    SELECT 1 FROM order_events later
    WHERE later.order_id = e.order_id AND later.id > e.id
      AND later.event_type = 'status.changed'
      AND later.from_status IN ('EXPIRED', 'PAYMENT_FAILED') AND later.to_status = 'PAID'
  )
ON CONFLICT (order_id) DO NOTHING;

-- Same lock order as before: the caller holds the order row, then products by SKU, then voucher.
-- The guard row is written first, and only a change from "held" to "released" goes on.
CREATE OR REPLACE FUNCTION release_order_holds(p_order_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_item record;
  v_code text;
  v_rows integer;
BEGIN
  INSERT INTO order_hold_releases (order_id, released) VALUES (p_order_id, true)
  ON CONFLICT (order_id) DO UPDATE SET released = true, updated_at = now()
    WHERE order_hold_releases.released = false;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN; -- Already given back.
  END IF;

  FOR v_item IN SELECT sku, qty FROM order_items WHERE order_id = p_order_id ORDER BY sku LOOP
    UPDATE products SET stock = stock + v_item.qty, updated_at = now()
      WHERE sku = v_item.sku AND stock IS NOT NULL;
  END LOOP;
  FOR v_code IN
    UPDATE voucher_redemptions SET released_at = now()
      WHERE order_id = p_order_id AND released_at IS NULL
      RETURNING voucher_code
  LOOP
    UPDATE vouchers SET used_count = used_count - 1, updated_at = now() WHERE code = v_code;
  END LOOP;
END;
$$;

-- A late payment took stock and voucher use again (ADR 0004), so the next release is real.
CREATE FUNCTION mark_order_holds_taken(p_order_id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE order_hold_releases SET released = false, updated_at = now()
    WHERE order_id = p_order_id AND released = true;
END;
$$;

-- Unchanged from 0006 except the release rule at the end. The pairing by amount stays: the
-- webhook names no refund. The worker now sends every refund row's own refund_id to the
-- provider, even when a webhook already settled that row with another row's event, so the
-- provider ends up with one refund per row and every event settles exactly one row.
CREATE OR REPLACE FUNCTION settle_refund(
  p_order_id text, p_amount bigint, p_event_id text, p_preferred_refund bigint, p_actor text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_status  text;
  v_paid    bigint;
  v_refund  bigint;
  v_settled bigint;
BEGIN
  SELECT status, paid_satang INTO v_status, v_paid FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unknown_order';
  END IF;

  IF EXISTS (SELECT 1 FROM refunds WHERE provider_event_id = p_event_id) THEN
    RETURN 'already_settled';
  END IF;

  SELECT id INTO v_refund FROM refunds
    WHERE order_id = p_order_id AND status = 'PENDING' AND amount_satang = p_amount
    ORDER BY (id IS NOT DISTINCT FROM p_preferred_refund) DESC, id
    LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unmatched';
  END IF;

  UPDATE refunds SET status = 'SUCCEEDED', provider_event_id = p_event_id WHERE id = v_refund;

  INSERT INTO order_events (order_id, event_type, from_status, to_status, actor, reason)
    VALUES (p_order_id, 'refund.settled', v_status, v_status, p_actor,
            format('refund of %s satang settled', p_amount));

  SELECT coalesce(sum(amount_satang), 0) INTO v_settled
    FROM refunds WHERE order_id = p_order_id AND status = 'SUCCEEDED';

  IF v_paid > 0 AND v_settled = v_paid
     AND v_status IN ('COMPLETED', 'FAILED', 'EXPIRED', 'NEEDS_REVIEW') THEN
    PERFORM transition_order(p_order_id, v_status, 'REFUNDED', p_actor, 'paid amount fully refunded');
    -- FAILED: the top-up was confirmed not delivered. Never queued: nothing was ever sent to
    -- the game. Either way the item is free to sell again. release_order_holds does nothing if
    -- EXPIRED or PAYMENT_FAILED already gave the holds back.
    IF v_status = 'FAILED' OR NOT EXISTS (
      SELECT 1 FROM order_events WHERE order_id = p_order_id AND to_status = 'IN_QUEUE'
    ) THEN
      PERFORM release_order_holds(p_order_id);
    END IF;
  END IF;

  RETURN 'settled';
END;
$$;
