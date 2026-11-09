-- Tells listeners that an order has a new event. NOTIFY is delivered only when the transaction
-- commits, and never for one that rolls back, so a listener cannot see an event that does not
-- exist. The worker relays it to Redis (order:{id}); see docs/adr/0003-realtime-across-replicas.md.
-- The payload is only a hint: readers always load the rows from order_events.
CREATE FUNCTION order_events_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('order_events', NEW.order_id || ':' || NEW.id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER order_events_notify AFTER INSERT ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_events_notify();
