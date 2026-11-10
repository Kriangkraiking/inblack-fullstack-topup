-- 1. Admin login attempts per email, kept in Postgres so the limit holds with Redis down (ADR 0005).
-- 2. superadmin may edit a product's name and price (spec 3). Stock was already writable.

-- One row per email that tried to sign in, known or not, so a 429 says nothing about whether an
-- admin has that address. Only the SHA-256 of the normalised email is stored.
CREATE TABLE admin_login_attempts (
  email_hash        text PRIMARY KEY CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  attempts          integer NOT NULL CHECK (attempts > 0),
  window_started_at timestamptz NOT NULL
);

CREATE INDEX admin_login_attempts_window_idx ON admin_login_attempts (window_started_at);

GRANT SELECT, INSERT, DELETE ON admin_login_attempts TO inblack_app;
GRANT UPDATE (attempts, window_started_at) ON admin_login_attempts TO inblack_app;

-- Counts one attempt before the password is checked and returns the count in the current fixed
-- window and the seconds left in it. The upsert takes the row lock, so two replicas cannot both
-- read "4" and let a sixth guess through. A successful login deletes the row.
CREATE FUNCTION admin_login_attempt(p_email_hash text, p_window_seconds integer)
RETURNS TABLE (attempts integer, retry_after_seconds integer) LANGUAGE plpgsql AS $$
DECLARE
  v_window interval := make_interval(secs => p_window_seconds);
BEGIN
  -- Old windows of every email, so rows for made-up addresses do not pile up.
  DELETE FROM admin_login_attempts a
    WHERE a.window_started_at <= now() - v_window AND a.email_hash <> p_email_hash;

  RETURN QUERY
  INSERT INTO admin_login_attempts AS a (email_hash, attempts, window_started_at)
  VALUES (p_email_hash, 1, now())
  ON CONFLICT (email_hash) DO UPDATE SET
    attempts = CASE WHEN a.window_started_at <= now() - v_window THEN 1 ELSE a.attempts + 1 END,
    window_started_at = CASE WHEN a.window_started_at <= now() - v_window THEN now() ELSE a.window_started_at END
  RETURNING a.attempts,
    GREATEST(1, ceil(extract(epoch FROM a.window_started_at + v_window - now())))::integer;
END;
$$;

-- Prices already sold are in order_items (unit_price_satang, name_snapshot), which no one may
-- update, so a new price applies to new orders only (spec 5.2).
GRANT UPDATE (name, price_satang) ON products TO inblack_app;
