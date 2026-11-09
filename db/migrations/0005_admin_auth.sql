-- Admin sessions and the audit log.

-- Only the SHA-256 of the cookie token is stored, so reading this table gives no usable session.
CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  admin_id   bigint NOT NULL REFERENCES admin_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX admin_sessions_expiry_idx ON admin_sessions (expires_at);

CREATE TABLE admin_audit_logs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id   bigint NOT NULL REFERENCES admin_users (id),
  action     text NOT NULL CHECK (action <> ''),
  target     text,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER admin_audit_logs_no_change BEFORE UPDATE OR DELETE ON admin_audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER admin_audit_logs_no_truncate BEFORE TRUNCATE ON admin_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT, DELETE ON admin_sessions TO inblack_app;
GRANT SELECT, INSERT ON admin_audit_logs TO inblack_app;
