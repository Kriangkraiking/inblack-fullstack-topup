"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl, ApiError } from "./api";
import { eventLabel } from "./labels";
import type { TimelineEvent } from "./types";

export type Connection = "connecting" | "live" | "reconnecting" | "lost";

function byEventId(a: TimelineEvent, b: TimelineEvent): number {
  const x = BigInt(a.event_id);
  const y = BigInt(b.event_id);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Live order timeline over Server-Sent Events.
 *
 * EventSource reconnects by itself after a dropped connection and sends
 * Last-Event-ID, so the API replays only what was missed. Events are still
 * de-duplicated by id, because the first connect replays the whole history.
 * When the token expires the API answers 404 and EventSource gives up
 * (readyState CLOSED); then `renewToken` gets a fresh token and a new stream
 * resumes from the last id seen through `?last_event_id=`.
 *
 * Use with `key={orderId}` so a different order starts from a clean state.
 */
export function useOrderEvents(options: {
  orderId: string;
  token: string;
  initialEvents?: TimelineEvent[];
  renewToken: () => Promise<string>;
}) {
  const { orderId, token: initialToken } = options;
  const [events, setEvents] = useState<TimelineEvent[]>(() =>
    [...(options.initialEvents ?? [])].sort(byEventId),
  );
  const [connection, setConnection] = useState<Connection>("connecting");
  const [announcement, setAnnouncement] = useState("");
  const renewRef = useRef(options.renewToken);
  const seen = useRef(new Set((options.initialEvents ?? []).map((e) => e.event_id)));

  useEffect(() => {
    renewRef.current = options.renewToken;
  });

  useEffect(() => {
    let stopped = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let token = initialToken;
    let lastId: string | null = null;

    const open = () => {
      const url = new URL(apiUrl(`/orders/${encodeURIComponent(orderId)}/events`));
      url.searchParams.set("token", token);
      if (lastId) url.searchParams.set("last_event_id", lastId);
      const es = new EventSource(url);
      source = es;
      es.onopen = () => setConnection("live");
      es.onmessage = (message) => {
        let data: TimelineEvent;
        try {
          data = JSON.parse(message.data) as TimelineEvent;
        } catch {
          return;
        }
        if (typeof data.event_id !== "string" || !/^[0-9]+$/.test(data.event_id)) return;
        if (!lastId || BigInt(data.event_id) > BigInt(lastId)) lastId = data.event_id;
        if (seen.current.has(data.event_id)) return;
        seen.current.add(data.event_id);
        setEvents((prev) => [...prev, data].sort(byEventId));
        setAnnouncement(`อัปเดตสถานะ: ${eventLabel(data.event_type, data.status)}`);
      };
      es.onerror = () => {
        if (stopped) return;
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          setConnection("reconnecting");
          renew(0);
        } else {
          setConnection("reconnecting");
        }
      };
    };

    const renew = (attempt: number) => {
      renewRef.current().then(
        (fresh) => {
          if (stopped) return;
          token = fresh;
          open();
        },
        (error: unknown) => {
          if (stopped) return;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
            setConnection("lost");
            return;
          }
          const wait =
            error instanceof ApiError && error.retryAfter !== null
              ? error.retryAfter * 1000
              : Math.min(30_000, 2000 * 2 ** attempt);
          timer = setTimeout(() => renew(attempt + 1), wait);
        },
      );
    };

    open();
    return () => {
      stopped = true;
      source?.close();
      if (timer) clearTimeout(timer);
    };
  }, [orderId, initialToken]);

  const latest = [...events].reverse().find((e) => e.event_type !== "refund.settled") ?? null;
  return { events, connection, announcement, currentStatus: latest?.status ?? null };
}
