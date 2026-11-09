-- What the webhook, the fulfillment worker and refunds need beyond 0002 and 0003.

-- mock-game takes one sku per POST and counts per reference, so an order with two lines needs
-- one reference per line. "One success" therefore holds per reference, not per order.
DROP INDEX fulfillment_attempts_one_success;
CREATE UNIQUE INDEX fulfillment_attempts_one_success
  ON fulfillment_attempts (order_id, reference) WHERE status = 'SUCCEEDED';

-- Two open jobs for one order could POST the same reference at the same time.
CREATE UNIQUE INDEX outbox_one_open_fulfillment
  ON outbox (aggregate_id)
  WHERE topic = 'fulfillment.requested' AND processed_at IS NULL;

-- refund_ref is what the provider sees as refund_id. It is random, not the identity value,
-- because POST /api/v1/_test/reset restarts identities and mock-pay keeps its journal.
ALTER TABLE refunds
  ADD COLUMN refund_ref text NOT NULL UNIQUE DEFAULT 'rf_' || gen_random_uuid()::text,
  ADD COLUMN provider_event_id text UNIQUE;

GRANT UPDATE (provider_event_id) ON refunds TO inblack_app;

-- Gives back stock and voucher use. Order-row lock first, then products by SKU, then voucher,
-- as in ADR 0001. released_at can only be set once, so a voucher is never returned twice, and
-- the callers change status under the same lock, so stock cannot be returned twice either.
CREATE FUNCTION release_order_holds(p_order_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_item record;
  v_code text;
BEGIN
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

-- Marks one PENDING refund as settled, from a payment.refunded webhook or from the provider's
-- answer to POST /refunds, whichever comes first. The webhook names no refund, so it matches on
-- amount. Refunds of one order with the same amount are interchangeable, and each event settles
-- exactly one of them, so the sum is right whichever pairing happens.
-- Returns settled, already_settled, unmatched or unknown_order.
CREATE FUNCTION settle_refund(
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
    -- FAILED means the top-up was confirmed not delivered, so the item is free to sell again.
    -- EXPIRED has already given it back, and the others may have been delivered.
    IF v_status = 'FAILED' THEN
      PERFORM release_order_holds(p_order_id);
    END IF;
  END IF;

  RETURN 'settled';
END;
$$;
