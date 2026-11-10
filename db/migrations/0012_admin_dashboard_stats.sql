-- admin_dashboard_stats(): the numbers behind GET /api/v1/admin/stats, kept in SQL so the
-- integration test runs exactly what the API runs. Read only.

-- "Paid today" reads today's PAID events, and refunds settled today; both get an index.
CREATE INDEX order_events_to_status_created_idx ON order_events (to_status, created_at);
CREATE INDEX refunds_settled_idx ON refunds (completed_at) WHERE status = 'SUCCEEDED';

-- Day boundaries are Asia/Bangkok. Revenue today = paid_satang of the orders whose first PAID
-- event is today, minus the refunds that settled (SUCCEEDED) today. Integer satang throughout;
-- it can be negative on a day with more refunds than payments.
CREATE FUNCTION admin_dashboard_stats(p_now timestamptz DEFAULT now())
RETURNS TABLE (
  orders_today         bigint,
  revenue_today_satang bigint,
  orders_last_minute   bigint,
  orders_last_hour     bigint,
  queue_depth          bigint,
  dead_letters_open    bigint
) LANGUAGE sql STABLE AS $$
  WITH day AS (
    SELECT (date_trunc('day', p_now AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok') AS start
  )
  SELECT
    (SELECT count(*) FROM orders o, day WHERE o.created_at >= day.start AND o.created_at <= p_now),
    (SELECT coalesce(sum(o.paid_satang), 0) FROM orders o
       WHERE o.id IN (
         SELECT e.order_id FROM order_events e, day
         WHERE e.to_status = 'PAID' AND e.created_at >= day.start AND e.created_at <= p_now
           AND NOT EXISTS (
             SELECT 1 FROM order_events p
             WHERE p.order_id = e.order_id AND p.to_status = 'PAID' AND p.created_at < day.start
           )
       ))::bigint
      - (SELECT coalesce(sum(r.amount_satang), 0) FROM refunds r, day
         WHERE r.status = 'SUCCEEDED' AND r.completed_at >= day.start AND r.completed_at <= p_now)::bigint,
    (SELECT count(*) FROM orders o WHERE o.created_at > p_now - interval '1 minute' AND o.created_at <= p_now),
    (SELECT count(*) FROM orders o WHERE o.created_at > p_now - interval '1 hour' AND o.created_at <= p_now),
    (SELECT count(*) FROM outbox WHERE processed_at IS NULL),
    (SELECT count(*) FROM dead_letters WHERE resolved_at IS NULL)
$$;
