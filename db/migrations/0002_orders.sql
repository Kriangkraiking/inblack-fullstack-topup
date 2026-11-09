-- Orders, locked line items, the status state machine, the event log and refunds.
--
-- Custom SQLSTATE codes, for the API to map to Problem Details:
--   IB001 invalid status transition      IB004 actor or reason missing
--   IB002 append-only row changed        IB005 precondition of PAID or REFUNDED not met
--   IB003 locked order field changed     IB006 invalid refund status change

CREATE TABLE orders (
  id              text PRIMARY KEY,
  email           text NOT NULL CHECK (email = lower(email) AND email <> ''),
  game_uid        text NOT NULL CHECK (game_uid <> ''),
  status          text NOT NULL DEFAULT 'PENDING_PAYMENT',
  payment_method  text NOT NULL CHECK (payment_method IN ('PROMPTPAY', 'TRUEMONEY', 'CARD')),
  voucher_code    text REFERENCES vouchers (code),
  subtotal_satang bigint NOT NULL CHECK (subtotal_satang >= 0),
  discount_satang bigint NOT NULL CHECK (discount_satang >= 0),
  net_satang      bigint NOT NULL CHECK (net_satang >= 0),
  fee_satang      bigint NOT NULL CHECK (fee_satang >= 0),
  total_satang    bigint NOT NULL CHECK (total_satang >= 0),
  vat_satang      bigint NOT NULL CHECK (vat_satang >= 0),
  -- What the provider actually took. It differs from total on a mismatched payment.
  paid_satang     bigint NOT NULL DEFAULT 0 CHECK (paid_satang >= 0),
  -- PENDING and SUCCEEDED refunds. Maintained by the trigger on refunds.
  refunded_satang bigint NOT NULL DEFAULT 0 CHECK (refunded_satang >= 0),
  currency        text NOT NULL DEFAULT 'THB' CHECK (currency = 'THB'),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_id_checksum CHECK (
    CASE WHEN id ~ '^ORD-[0-9]{13}-[0-9]{3}$'
      THEN substr(id, 5, 13)::bigint % 997 = substr(id, 19, 3)::integer
      ELSE false
    END
  ),
  CONSTRAINT orders_net_adds_up CHECK (net_satang = subtotal_satang - discount_satang),
  CONSTRAINT orders_total_adds_up CHECK (total_satang = net_satang + fee_satang),
  CONSTRAINT orders_vat_within_total CHECK (vat_satang <= total_satang),
  CONSTRAINT orders_refund_within_paid CHECK (refunded_satang <= paid_satang)
);

CREATE INDEX orders_created_idx ON orders (created_at DESC, id DESC);
CREATE INDEX orders_status_created_idx ON orders (status, created_at DESC, id DESC);
CREATE INDEX orders_email_created_idx ON orders (email, created_at DESC, id DESC);
CREATE INDEX orders_pending_expiry_idx ON orders (expires_at) WHERE status = 'PENDING_PAYMENT';

CREATE TABLE order_items (
  order_id          text NOT NULL REFERENCES orders (id),
  sku               text NOT NULL REFERENCES products (sku),
  name_snapshot     text NOT NULL,
  unit_price_satang bigint NOT NULL CHECK (unit_price_satang >= 0),
  qty               integer NOT NULL CHECK (qty > 0),
  line_total_satang bigint NOT NULL CHECK (line_total_satang >= 0),
  PRIMARY KEY (order_id, sku),
  CONSTRAINT order_items_line_adds_up CHECK (line_total_satang = unit_price_satang * qty)
);

CREATE INDEX order_items_sku_idx ON order_items (sku);

-- Must hold the same pairs as ORDER_TRANSITIONS in packages/domain/src/order-state.ts.
-- db/src/transitions.spec.ts reads the block between the two markers below.
CREATE TABLE order_status_transitions (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

-- transitions:begin
INSERT INTO order_status_transitions (from_status, to_status) VALUES
  ('PENDING_PAYMENT', 'PAID'),
  ('PENDING_PAYMENT', 'EXPIRED'),
  ('PENDING_PAYMENT', 'PAYMENT_FAILED'),
  ('PENDING_PAYMENT', 'NEEDS_REVIEW'),
  ('PAID', 'IN_QUEUE'),
  ('PAID', 'NEEDS_REVIEW'),
  ('IN_QUEUE', 'IN_PROGRESS'),
  ('IN_QUEUE', 'NEEDS_REVIEW'),
  ('IN_PROGRESS', 'COMPLETED'),
  ('IN_PROGRESS', 'FAILED'),
  ('IN_PROGRESS', 'NEEDS_REVIEW'),
  ('COMPLETED', 'REFUNDED'),
  ('COMPLETED', 'NEEDS_REVIEW'),
  ('FAILED', 'REFUNDED'),
  ('FAILED', 'NEEDS_REVIEW'),
  ('REFUNDED', 'NEEDS_REVIEW'),
  ('EXPIRED', 'PAID'),
  ('EXPIRED', 'REFUNDED'),
  ('EXPIRED', 'NEEDS_REVIEW'),
  ('PAYMENT_FAILED', 'NEEDS_REVIEW'),
  ('NEEDS_REVIEW', 'PAID'),
  ('NEEDS_REVIEW', 'COMPLETED'),
  ('NEEDS_REVIEW', 'REFUNDED');
-- transitions:end

-- id doubles as the SSE event id. Writers hold the order's row lock (status changes
-- do so implicitly), so ids of one order always commit in order and Last-Event-ID
-- cannot skip an event.
CREATE TABLE order_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    text NOT NULL REFERENCES orders (id),
  event_type  text NOT NULL CHECK (event_type <> ''),
  from_status text,
  to_status   text NOT NULL,
  actor       text NOT NULL CHECK (actor <> ''),
  reason      text NOT NULL CHECK (reason <> ''),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX order_events_order_idx ON order_events (order_id, id);

CREATE TABLE refunds (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        text NOT NULL REFERENCES orders (id),
  amount_satang   bigint NOT NULL CHECK (amount_satang > 0),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  actor           text NOT NULL CHECK (actor <> ''),
  reason          text NOT NULL CHECK (reason <> ''),
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  UNIQUE (order_id, idempotency_key)
);

-- ---------- Append-only rows ----------

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: rows are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'IB002';
END;
$$;

CREATE TRIGGER order_events_no_change BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_events_no_truncate BEFORE TRUNCATE ON order_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Locked prices: an item never changes after the order is created.
CREATE TRIGGER order_items_no_change BEFORE UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_items_no_truncate BEFORE TRUNCATE ON order_items
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER refunds_no_truncate BEFORE TRUNCATE ON refunds
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------- Order guards ----------

CREATE FUNCTION orders_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'PENDING_PAYMENT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a new order must start as PENDING_PAYMENT, got %', NEW.status
      USING ERRCODE = 'IB001';
  END IF;
  IF NEW.paid_satang <> 0 OR NEW.refunded_satang <> 0 THEN
    RAISE EXCEPTION 'a new order cannot start with paid or refunded money'
      USING ERRCODE = 'IB005';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION orders_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  settled bigint;
BEGIN
  IF (NEW.id, NEW.email, NEW.game_uid, NEW.payment_method, NEW.voucher_code,
      NEW.subtotal_satang, NEW.discount_satang, NEW.net_satang, NEW.fee_satang,
      NEW.total_satang, NEW.vat_satang, NEW.currency, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.email, OLD.game_uid, OLD.payment_method, OLD.voucher_code,
      OLD.subtotal_satang, OLD.discount_satang, OLD.net_satang, OLD.fee_satang,
      OLD.total_satang, OLD.vat_satang, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'order % is locked: identity and price fields cannot change', OLD.id
      USING ERRCODE = 'IB003';
  END IF;

  IF NEW.paid_satang < OLD.paid_satang THEN
    RAISE EXCEPTION 'order %: paid amount cannot decrease', OLD.id USING ERRCODE = 'IB003';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM order_status_transitions
      WHERE from_status = OLD.status AND to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'IB001';
    END IF;

    IF NEW.status = 'PAID' AND NEW.paid_satang < NEW.total_satang THEN
      RAISE EXCEPTION 'order %: PAID needs % satang paid, has %',
        OLD.id, NEW.total_satang, NEW.paid_satang
        USING ERRCODE = 'IB005';
    END IF;

    -- A partial refund leaves the status alone. Only a settled, complete refund gets here.
    IF NEW.status = 'REFUNDED' THEN
      SELECT coalesce(sum(amount_satang), 0) INTO settled
        FROM refunds WHERE order_id = OLD.id AND status = 'SUCCEEDED';
      IF NEW.paid_satang = 0 OR settled <> NEW.paid_satang THEN
        RAISE EXCEPTION 'order %: REFUNDED needs % satang refunded, has %',
          OLD.id, NEW.paid_satang, settled
          USING ERRCODE = 'IB005';
      END IF;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Writes the event in the same transaction as the change, so it cannot be forgotten.
-- The caller supplies who and why with set_config('app.actor', ..., true) and
-- set_config('app.reason', ..., true), or through transition_order().
CREATE FUNCTION orders_log_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_actor  text := nullif(current_setting('app.actor', true), '');
  v_reason text := nullif(current_setting('app.reason', true), '');
BEGIN
  IF v_actor IS NULL OR v_reason IS NULL THEN
    RAISE EXCEPTION 'order %: set app.actor and app.reason before changing status', NEW.id
      USING ERRCODE = 'IB004';
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_events (order_id, event_type, from_status, to_status, actor, reason)
    VALUES (NEW.id, 'order.created', NULL, NEW.status, v_actor, v_reason);
  ELSE
    INSERT INTO order_events (order_id, event_type, from_status, to_status, actor, reason)
    VALUES (NEW.id, 'status.changed', OLD.status, NEW.status, v_actor, v_reason);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER orders_guard_insert BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard_insert();
CREATE TRIGGER orders_guard_update BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard_update();
CREATE TRIGGER orders_log_insert AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_log_status();
CREATE TRIGGER orders_log_status AFTER UPDATE ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION orders_log_status();

-- The conditional UPDATE. Returns false when another transaction already moved the
-- order (lost race), and raises IB001 when the move is not allowed at all.
CREATE FUNCTION transition_order(
  p_order_id text, p_from text, p_to text, p_actor text, p_reason text
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  changed integer;
BEGIN
  PERFORM set_config('app.actor', p_actor, true), set_config('app.reason', p_reason, true);
  UPDATE orders SET status = p_to WHERE id = p_order_id AND status = p_from;
  GET DIAGNOSTICS changed = ROW_COUNT;
  PERFORM set_config('app.actor', '', true), set_config('app.reason', '', true);
  RETURN changed = 1;
END;
$$;

-- ---------- Refund accounting ----------

-- Adding to refunded_satang takes the order's row lock, so concurrent refunds run one
-- at a time and the second one that would exceed paid_satang fails
-- orders_refund_within_paid, whatever the application checked before.
CREATE FUNCTION refunds_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'a refund must start as PENDING' USING ERRCODE = 'IB006';
    END IF;
    UPDATE orders SET refunded_satang = refunded_satang + NEW.amount_satang
      WHERE id = NEW.order_id;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.order_id, NEW.amount_satang, NEW.idempotency_key)
     IS DISTINCT FROM (OLD.id, OLD.order_id, OLD.amount_satang, OLD.idempotency_key) THEN
    RAISE EXCEPTION 'refund % cannot be rewritten', OLD.id USING ERRCODE = 'IB006';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'refund % is already %', OLD.id, OLD.status USING ERRCODE = 'IB006';
    END IF;
    NEW.completed_at := now();
    -- A failed refund gives the amount back to what can still be refunded.
    IF NEW.status = 'FAILED' THEN
      UPDATE orders SET refunded_satang = refunded_satang - OLD.amount_satang
        WHERE id = OLD.order_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER refunds_apply BEFORE INSERT OR UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_apply();
