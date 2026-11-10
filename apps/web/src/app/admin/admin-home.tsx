"use client";

import { ORDER_STATUSES } from "@inblack/domain";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { StatusBadge } from "@/components/order-view";
import { api, ApiError, describeError } from "@/lib/api";
import { formatDateTime, statusLabel } from "@/lib/labels";
import { formatBaht } from "@/lib/money";
import type { AdminIdentity, OrderSummary, Page } from "@/lib/types";
import { useAdminIdentity } from "@/lib/use-admin";

export function AdminHome() {
  const { identity, setIdentity, error, reload } = useAdminIdentity();
  if (identity === undefined) {
    if (error) {
      return (
        <div className="alert alert-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={reload}>
            ลองอีกครั้ง
          </button>
        </div>
      );
    }
    return <p aria-busy="true">กำลังตรวจสอบการเข้าสู่ระบบ…</p>;
  }
  if (identity === null) return <AdminLogin onSignedIn={setIdentity} />;
  return <AdminOrders identity={identity} onSignedOut={() => setIdentity(null)} />;
}

function AdminLogin({ onSignedIn }: { onSignedIn: (identity: AdminIdentity) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("กรอกอีเมลและรหัสผ่าน");
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSignedIn(
        await api<AdminIdentity>("/admin/auth/login", { method: "POST", body: { email: email.trim(), password } }),
      );
    } catch (err) {
      setError(describeError(err));
      emailRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={onSubmit} noValidate>
      <h2>เข้าสู่ระบบผู้ดูแล</h2>
      <div className="field">
        <label htmlFor="admin-email">อีเมล</label>
        <input
          ref={emailRef}
          id="admin-email"
          className="input"
          type="email"
          autoComplete="username"
          value={email}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "admin-login-error" : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="admin-password">รหัสผ่าน</label>
        <input
          id="admin-password"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "admin-login-error" : undefined}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && (
        <p id="admin-login-error" className="error-text" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
        </button>
      </div>
    </form>
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

export async function adminLogout(): Promise<void> {
  await api("/admin/auth/logout", { method: "POST" });
}

function AdminOrders({ identity, onSignedOut }: { identity: AdminIdentity; onSignedOut: () => void }) {
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
    <div className="stack">
      <div className="row spread">
        <p className="muted">
          {identity.email} (สิทธิ์ {identity.role})
        </p>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={async () => {
            try {
              await adminLogout();
              onSignedOut();
            } catch (err) {
              setError(describeError(err));
            }
          }}
        >
          ออกจากระบบ
        </button>
      </div>

      <form className="card" onSubmit={applyFilters} aria-label="ตัวกรองออเดอร์">
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
      {page && page.items.length === 0 && <p className="card">ไม่พบออเดอร์ที่ตรงกับตัวกรอง</p>}
      {page && page.items.length > 0 && (
        <div className="table-wrap card" aria-busy={loading}>
          <table>
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
                  <td>
                    <Link href={`/admin/orders/${encodeURIComponent(o.order_id)}`}>{o.order_id}</Link>
                  </td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td>{o.email}</td>
                  <td>{o.game_uid}</td>
                  <td>{formatBaht(o.total_satang)}</td>
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
    </div>
  );
}
