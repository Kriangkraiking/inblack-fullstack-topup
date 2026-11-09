-- Voucher use, idempotency, webhooks, fulfilment, outbox and dead letters.

CREATE TABLE voucher_redemptions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  voucher_code      text NOT NULL REFERENCES vouchers (code),
  order_id          text NOT NULL REFERENCES orders (id),
  email             text NOT NULL CHECK (email = lower(email)),
  -- Copied from the voucher by the trigger below, because a partial index cannot look it up.
  per_email_limited boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Set when the order expires. Setting it once is what makes the release idempotent.
  released_at       timestamptz
);

CREATE UNIQUE INDEX voucher_redemptions_one_per_order
  ON voucher_redemptions (order_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX voucher_redemptions_one_per_email
  ON voucher_redemptions (voucher_code, email)
  WHERE released_at IS NULL AND per_email_limited;

CREATE FUNCTION voucher_redemptions_set_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT max_uses_per_email IS NOT NULL INTO NEW.per_email_limited
    FROM vouchers WHERE code = NEW.voucher_code;
  RETURN NEW;
END;
$$;

CREATE TRIGGER voucher_redemptions_set_limit BEFORE INSERT ON voucher_redemptions
  FOR EACH ROW EXECUTE FUNCTION voucher_redemptions_set_limit();

-- response_body is text, not jsonb: jsonb reorders keys and replays must match byte for byte.
CREATE TABLE idempotency_keys (
  scope         text NOT NULL,
  key           text NOT NULL CHECK (key <> ''),
  request_hash  text NOT NULL,
  status_code   integer,
  response_body text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (scope, key),
  CONSTRAINT idempotency_keys_kept_24h CHECK (expires_at >= created_at + interval '24 hours'),
  CONSTRAINT idempotency_keys_response_complete CHECK ((status_code IS NULL) = (response_body IS NULL))
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- The primary key is what makes a repeated event_id a no-op, even when copies arrive
-- together. order_id has no foreign key: a webhook for an unknown order is still recorded.
CREATE TABLE webhook_events (
  event_id      text PRIMARY KEY CHECK (event_id <> ''),
  type          text NOT NULL,
  order_id      text,
  amount_satang bigint CHECK (amount_satang >= 0),
  currency      text,
  occurred_at   timestamptz,
  raw_body      text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  outcome       text
);

CREATE INDEX webhook_events_order_idx ON webhook_events (order_id, received_at);

CREATE TABLE fulfillment_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    text NOT NULL REFERENCES orders (id),
  reference   text NOT NULL CHECK (reference <> ''),
  attempt_no  integer NOT NULL CHECK (attempt_no > 0),
  -- UNKNOWN is a timeout: the top-up may have happened, so check GET /topups before retrying.
  status      text NOT NULL DEFAULT 'IN_FLIGHT'
    CHECK (status IN ('IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  http_status integer,
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (order_id, attempt_no)
);

-- At most one success and at most one call in flight per order.
CREATE UNIQUE INDEX fulfillment_attempts_one_success
  ON fulfillment_attempts (order_id) WHERE status = 'SUCCEEDED';
CREATE UNIQUE INDEX fulfillment_attempts_one_in_flight
  ON fulfillment_attempts (order_id) WHERE status = 'IN_FLIGHT';

CREATE TABLE outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic        text NOT NULL CHECK (topic <> ''),
  aggregate_id text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error   text
);

CREATE INDEX outbox_pending_idx ON outbox (available_at, id) WHERE processed_at IS NULL;

CREATE TABLE dead_letters (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_id    bigint UNIQUE REFERENCES outbox (id),
  topic        text NOT NULL,
  aggregate_id text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  text
);

CREATE INDEX dead_letters_open_idx ON dead_letters (created_at) WHERE resolved_at IS NULL;
