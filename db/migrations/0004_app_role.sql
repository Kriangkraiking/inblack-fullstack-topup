-- The role api and worker connect as. It is not a superuser and owns nothing, so it
-- cannot disable triggers or set session_replication_role, and the guards in 0002 hold.
-- The password is set by db/src/migrate.ts from APP_DB_PASSWORD, so it stays out of this file.
--
-- New tables get no access by default: each one needs its own GRANT in its migration.
-- Update and insert grants are per column where a table has fields that must not change.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'inblack_app') THEN
    CREATE ROLE inblack_app;
  END IF;
END;
$$;

-- Repeated outside the IF so a role that already existed cannot keep extra attributes.
ALTER ROLE inblack_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO inblack_app;

GRANT SELECT ON products, vouchers, admin_users, order_status_transitions TO inblack_app;
GRANT UPDATE (stock, updated_at) ON products TO inblack_app;
GRANT UPDATE (used_count, updated_at) ON vouchers TO inblack_app;

GRANT SELECT, INSERT ON orders, order_items, order_events TO inblack_app;
GRANT UPDATE (status, paid_satang, refunded_satang) ON orders TO inblack_app;

GRANT SELECT, INSERT ON refunds TO inblack_app;
GRANT UPDATE (status, completed_at) ON refunds TO inblack_app;

GRANT SELECT, INSERT ON voucher_redemptions TO inblack_app;
GRANT UPDATE (released_at) ON voucher_redemptions TO inblack_app;

GRANT SELECT, INSERT, DELETE ON idempotency_keys TO inblack_app;
GRANT UPDATE (status_code, response_body) ON idempotency_keys TO inblack_app;

GRANT SELECT, INSERT ON webhook_events TO inblack_app;
GRANT UPDATE (processed_at, outcome) ON webhook_events TO inblack_app;

GRANT SELECT, INSERT ON fulfillment_attempts TO inblack_app;
GRANT UPDATE (status, http_status, error, finished_at) ON fulfillment_attempts TO inblack_app;

GRANT SELECT, INSERT ON outbox TO inblack_app;
GRANT UPDATE (attempts, available_at, processed_at, last_error) ON outbox TO inblack_app;

GRANT SELECT, INSERT ON dead_letters TO inblack_app;
GRANT UPDATE (resolved_at, resolved_by) ON dead_letters TO inblack_app;
