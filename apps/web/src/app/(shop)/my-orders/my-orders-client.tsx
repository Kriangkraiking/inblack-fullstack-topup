"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { StatusBadge } from "@/components/order-view";
import { api, ApiError, describeError } from "@/lib/api";
import { formatDateTime } from "@/lib/labels";
import { formatBaht } from "@/lib/money";
import type { OrderSummary, Page } from "@/lib/types";

type Me = { email: string } | null;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function MyOrdersClient() {
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api<{ email: string }>("/auth/me"));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(loadMe, 0);
    return () => clearTimeout(timer);
  }, [loadMe]);

  if (error && me === undefined) {
    return (
      <div className="alert alert-error" role="alert">
        <p>{error}</p>
        <button type="button" className="btn btn-secondary" onClick={loadMe}>
          ลองอีกครั้ง
        </button>
      </div>
    );
  }
  if (me === undefined) return <p aria-busy="true">กำลังตรวจสอบการเข้าสู่ระบบ…</p>;
  if (me === null) return <OtpLogin onSignedIn={(email) => setMe({ email })} />;
  return <OrderTabs email={me.email} onSignedOut={() => setMe(null)} />;
}

function OtpLogin({ onSignedIn }: { onSignedIn: (email: string) => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mail = email.trim();
    if (!EMAIL_PATTERN.test(mail)) {
      setFieldError("กรอกอีเมลให้ถูกต้อง");
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    setFieldError(null);
    try {
      await api("/auth/otp/request", { method: "POST", body: { email: mail } });
      setStep("code");
      setNotice(`ส่งรหัส 6 หลักไปที่ ${mail} แล้ว รหัสใช้ได้ 5 นาที (ระบบทดสอบ: เปิดอ่านได้ที่ http://localhost:8025)`);
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch (err) {
      setFieldError(describeError(err));
      emailRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[0-9]{6}$/.test(code.trim())) {
      setFieldError("รหัสต้องเป็นตัวเลข 6 หลัก");
      codeRef.current?.focus();
      return;
    }
    setBusy(true);
    setFieldError(null);
    try {
      const res = await api<{ email: string }>("/auth/otp/verify", {
        method: "POST",
        body: { email: email.trim(), code: code.trim() },
      });
      onSignedIn(res.email);
    } catch (err) {
      setFieldError(describeError(err));
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  if (step === "email") {
    return (
      <form className="card stack" onSubmit={requestCode} noValidate>
        <p>เข้าสู่ระบบด้วยรหัสที่ส่งไปทางอีเมล ใช้อีเมลเดียวกับตอนสั่งซื้อ</p>
        <div className="field">
          <label htmlFor="otp-email">อีเมล</label>
          <input
            ref={emailRef}
            id="otp-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "otp-error" : undefined}
            onChange={(e) => setEmail(e.target.value)}
          />
          {fieldError && (
            <p id="otp-error" className="error-text" role="alert">
              {fieldError}
            </p>
          )}
        </div>
        <div>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "กำลังส่ง…" : "ส่งรหัสเข้าสู่ระบบ"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="card stack" onSubmit={verify} noValidate>
      {notice && (
        <p className="alert alert-info" role="status">
          {notice}
        </p>
      )}
      <div className="field">
        <label htmlFor="otp-code">รหัส 6 หลัก</label>
        <input
          ref={codeRef}
          id="otp-code"
          className="input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? "otp-error" : undefined}
          onChange={(e) => setCode(e.target.value)}
        />
        {fieldError && (
          <p id="otp-error" className="error-text" role="alert">
            {fieldError}
          </p>
        )}
      </div>
      <div className="row">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setStep("email");
            setCode("");
            setFieldError(null);
          }}
        >
          เปลี่ยนอีเมล
        </button>
      </div>
    </form>
  );
}

const TABS = [
  { id: "current", label: "ปัจจุบัน" },
  { id: "past", label: "ที่ผ่านมา" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function OrderTabs({ email, onSignedOut }: { email: string; onSignedOut: () => void }) {
  const [tab, setTab] = useState<Tab>("current");
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
      onSignedOut();
    } catch (err) {
      setLogoutError(describeError(err));
    }
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="stack">
      <div className="row spread">
        <p className="muted">เข้าสู่ระบบเป็น {email}</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={logout}>
          ออกจากระบบ
        </button>
      </div>
      {logoutError && (
        <p className="alert alert-error" role="alert">
          {logoutError}
        </p>
      )}
      <div className="tabs" role="tablist" aria-label="ประเภทออเดอร์">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
        <OrderList key={tab} tab={tab} onUnauthorized={onSignedOut} />
      </div>
    </div>
  );
}

function OrderList({ tab, onUnauthorized }: { tab: Tab; onUnauthorized: () => void }) {
  const [items, setItems] = useState<OrderSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (after: string | null) => {
      const params = new URLSearchParams({ tab, limit: "20" });
      if (after) params.set("cursor", after);
      try {
        const page = await api<Page<OrderSummary>>(`/me/orders?${params}`);
        setItems((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else setError(describeError(err));
      }
    },
    [tab, onUnauthorized],
  );

  useEffect(() => {
    const timer = setTimeout(() => load(null), 0);
    return () => clearTimeout(timer);
  }, [load]);

  if (items === null) {
    if (error) {
      return (
        <div className="alert alert-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={() => load(null)}>
            ลองอีกครั้ง
          </button>
        </div>
      );
    }
    return <p aria-busy="true">กำลังโหลดออเดอร์…</p>;
  }
  if (items.length === 0) {
    return (
      <div className="card">
        <p>{tab === "current" ? "ไม่มีออเดอร์ที่กำลังดำเนินการ" : "ยังไม่มีออเดอร์ที่จบแล้ว"}</p>
        <Link className="btn" href="/">
          เลือกสินค้า
        </Link>
      </div>
    );
  }
  return (
    <div className="stack">
      <ul className="list-unstyled stack">
        {items.map((order) => (
          <li key={order.order_id} className="card">
            <div className="row spread">
              <Link href={`/my-orders/${encodeURIComponent(order.order_id)}`}>{order.order_id}</Link>
              <StatusBadge status={order.status} />
            </div>
            <p className="small muted">
              {formatDateTime(order.created_at)} · {formatBaht(order.total_satang)}
            </p>
            {order.items && (
              <p className="small">{order.items.map((item) => `${item.name} × ${item.qty}`).join(", ")}</p>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {cursor && (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={loadingMore}
          onClick={async () => {
            setLoadingMore(true);
            await load(cursor);
            setLoadingMore(false);
          }}
        >
          {loadingMore ? "กำลังโหลด…" : "ดูเพิ่ม"}
        </button>
      )}
    </div>
  );
}
