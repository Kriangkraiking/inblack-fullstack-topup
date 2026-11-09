-- Customer sign-in by email code (spec 8.4) and customer sessions, kept apart from admin_sessions
-- so a customer token can never be read as an admin one.

-- One row per email: the current code and the guess counter. Only an HMAC of the code is stored
-- (apps/api/src/customer-auth/otp.ts). The lock lives here, not in Redis, so it holds with Redis down.
CREATE TABLE customer_otps (
  email           text PRIMARY KEY CHECK (email = lower(email) AND email <> ''),
  code_hash       text CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0 AND failed_attempts < 5),
  locked_until    timestamptz,
  last_sent_at    timestamptz NOT NULL DEFAULT now()
);

-- Only the SHA-256 of the cookie token, as for admin_sessions.
CREATE TABLE customer_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  email      text NOT NULL CHECK (email = lower(email) AND email <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX customer_sessions_expiry_idx ON customer_sessions (expires_at);

GRANT SELECT, INSERT ON customer_otps TO inblack_app;
GRANT UPDATE (code_hash, expires_at, consumed_at, failed_attempts, locked_until, last_sent_at)
  ON customer_otps TO inblack_app;
GRANT SELECT, INSERT, DELETE ON customer_sessions TO inblack_app;
