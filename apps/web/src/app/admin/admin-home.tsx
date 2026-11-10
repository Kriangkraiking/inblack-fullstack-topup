"use client";

import { ORDER_STATUSES } from "@inblack/domain";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { StatusBadge } from "@/components/order-view";
import { api, ApiError, describeError } from "@/lib/api";
import { formatDateTime, statusLabel } from "@/lib/labels";
import { formatBaht } from "@/lib/money";
import type { AdminStats, OrderSummary, Page } from "@/lib/types";
import { useAdminSession } from "@/lib/use-admin";

/** Dashboard: summary cards on top, the filterable order table below. */
export function AdminHome() {
  return (
    <>
      <StatsPanel />
      <AdminOrders />
    </>
  );
}

const STATS_REFRESH_MS = 10_000;

type StatsState =
  | { kind: "loading" }
  | { kind: "ready"; stats: AdminStats }
  | { kind: "unavailable" } // 404: an API without /admin/stats
  | { kind: "error"; message: string };

function StatsPanel() {
  const { signOut } = useAdminSession();
  const [state, setState] = useState<StatsState>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const stats = await api<AdminStats>("/admin/stats");
      setState({ kind: "ready", stats });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) signOut();
      else if (err instanceof ApiError && err.status === 404) setState({ kind: "unavailable" });
      // Keep the last good numbers on a passing failure; show the error only before any data.
      else setState((prev) => (prev.kind === "ready" ? prev : { kind: "error", message: describeError(err) }));
    }
  }, [signOut]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, STATS_REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  return (
    <section className="stack" aria-labelledby="stats-heading">
      <div className="row spread">
        <h1 id="stats-heading" className="page-title">
          แดชบอร์ด
        </h1>
        {state.kind === "ready" && (
          <p className="small muted">
            อัปเดตทุก 10 วินาที · ล่าสุด {formatDateTime(state.stats.generated_at)}
          </p>
        )}
      </div>
      {state.kind === "loading" && (
        <div className="stat-grid" aria-busy="true" aria-label="กำลังโหลดข้อมูลสรุป">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="stat-card">
              <div className="stat-card__icon skeleton" />
              <div className="skeleton" />
            </div>
          ))}
        </div>
      )}
      {state.kind === "unavailable" && <p className="card empty">ยังไม่มีข้อมูลสรุป</p>}
      {state.kind === "error" && (
        <div className="alert alert-error" role="alert">
          <p>โหลดข้อมูลสรุปไม่สำเร็จ: {state.message}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={load}>
            ลองอีกครั้ง
          </button>
        </div>
      )}
      {state.kind === "ready" && (
        <>
          <ul className="stat-grid list-unstyled">
            <StatCard label="ออเดอร์วันนี้" value={state.stats.orders_today.toLocaleString("th-TH")} icon="M4 5h16M4 12h16M4 19h10" />
            <StatCard label="ยอดขายวันนี้" value={formatBaht(state.stats.revenue_today_satang)} icon="M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6" />
            <StatCard
              label="ออเดอร์ / นาที"
              value={state.stats.orders_last_minute.toLocaleString("th-TH")}
              note={`ชั่วโมงล่าสุด ${state.stats.orders_last_hour.toLocaleString("th-TH")}`}
              icon="M12 7v5l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"
            />
            <StatCard label="คิวเติมเกม" value={state.stats.queue_depth.toLocaleString("th-TH")} icon="M4 7h16M4 12h12M4 17h8" />
            <StatCard
              label="Dead letter ที่ค้าง"
              value={state.stats.dead_letters_open.toLocaleString("th-TH")}
              icon="M12 8v5M12 16.5v.5M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0"
              alert={state.stats.dead_letters_open > 0}
            />
          </ul>
          {Object.keys(state.stats.by_status ?? {}).length > 0 && (
            <div className="card">
              <h2 className="small">ออเดอร์ตามสถานะ</h2>
              <ul className="status-strip">
                {Object.entries(state.stats.by_status).map(([status, count]) => (
                  <li key={status} className="row">
                    <StatusBadge status={status} />
                    <span className="small">{count.toLocaleString("th-TH")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function StatCard({
  label,
  value,
  note,
  icon,
  alert = false,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  icon: string;
  alert?: boolean;
}) {
  return (
    <li className={`stat-card${alert ? " stat-card--alert" : ""}`}>
      <span className="stat-card__icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d={icon} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div>
        <p className="stat-card__label">{label}</p>
        <p className="stat-card__value">{value}</p>
        {note && <p className="small muted">{note}</p>}
      </div>
    </li>
  );
}

interface Filters {
  status: string;
  from: string;
  to: string;
  q: string;
}

const EMPTY_FILTERS: Filters = { status: "", from: "", to: "", q: "" };
const DAY_MS = 86_400_000;

/** A date picked in the form is a day in Bangkok time. */
function bangkokDayStart(date: string): string | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00+07:00`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function buildQuery(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams({ limit: "20" });
  if (filters.status) params.set("status", filters.status);
  const from = bangkokDayStart(filters.from);
  if (from) params.set("from", from);
  const toStart = bangkokDayStart(filters.to);
  if (toStart) params.set("to", new Date(Date.parse(toStart) + DAY_MS).toISOString());
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function AdminOrders() {
  const { signOut: onSignedOut } = useAdminSession();
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // Keyset pages: the cursor of each page seen so far, so "previous" works too.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<Page<OrderSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const current = cursors[cursors.length - 1];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await api<Page<OrderSummary>>(`/admin/orders?${buildQuery(filters, current)}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [filters, current, onSignedOut]);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters(draft);
    setCursors([null]);
  }

  return (
    <section className="stack" aria-labelledby="orders-heading">
      <h2 id="orders-heading">ออเดอร์</h2>

      <form className="card stack" onSubmit={applyFilters} aria-label="ตัวกรองออเดอร์">
        <div className="grid">
          <div className="field">
            <label htmlFor="f-status">สถานะ</label>
            <select
              id="f-status"
              className="input"
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
            >
              <option value="">ทั้งหมด</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)} ({s})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-from">ตั้งแต่วันที่</label>
            <input
              id="f-from"
              className="input"
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="f-to">ถึงวันที่</label>
            <input
              id="f-to"
              className="input"
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="f-q">เลขออเดอร์หรืออีเมล (ตรงตัว)</label>
            <input
              id="f-q"
              className="input"
              type="search"
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </div>
        </div>
        <div className="row">
          <button type="submit" className="btn">
            ค้นหา
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setFilters(EMPTY_FILTERS);
              setCursors([null]);
            }}
          >
            ล้างตัวกรอง
          </button>
        </div>
      </form>

      {error && (
        <div className="alert alert-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={load}>
            ลองอีกครั้ง
          </button>
        </div>
      )}

      {!page && loading && <p aria-busy="true">กำลังโหลดออเดอร์…</p>}
      {page && page.items.length === 0 && <p className="card empty">ไม่พบออเดอร์ที่ตรงกับตัวกรอง</p>}
      {page && page.items.length > 0 && (
        <div className="table-wrap card" aria-busy={loading}>
          <table className="admin-table">
            <caption className="sr-only">รายการออเดอร์ ใหม่สุดก่อน</caption>
            <thead>
              <tr>
                <th scope="col">เลขออเดอร์</th>
                <th scope="col">สถานะ</th>
                <th scope="col">อีเมล</th>
                <th scope="col">Game UID</th>
                <th scope="col">ยอด</th>
                <th scope="col">ชำระ/คืน</th>
                <th scope="col">สร้างเมื่อ</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((o) => (
                <tr key={o.order_id}>
                  <td className="nowrap">
                    <Link href={`/admin/orders/${encodeURIComponent(o.order_id)}`}>{o.order_id}</Link>
                  </td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td>{o.email}</td>
                  <td>{o.game_uid}</td>
                  <td className="nowrap">{formatBaht(o.total_satang)}</td>
                  <td className="small">
                    {formatBaht(o.paid_satang)} / {formatBaht(o.refunded_satang)}
                  </td>
                  <td className="small">{formatDateTime(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={cursors.length <= 1 || loading}
          onClick={() => setCursors((prev) => prev.slice(0, -1))}
        >
          หน้าก่อน
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!page?.next_cursor || loading}
          onClick={() => {
            const next = page?.next_cursor;
            if (next) setCursors((prev) => [...prev, next]);
          }}
        >
          หน้าถัดไป
        </button>
      </div>
    </section>
  );
}
