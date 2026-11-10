"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BrandMark } from "@/components/brand";
import { api, describeError } from "@/lib/api";
import type { AdminIdentity } from "@/lib/types";
import { AdminSessionContext, adminLogout, hasRole, useAdminIdentity } from "@/lib/use-admin";

const ROLE_LABEL: Record<AdminIdentity["role"], string> = {
  viewer: "Viewer (ดูอย่างเดียว)",
  support: "Support",
  finance: "Finance",
  superadmin: "Superadmin",
};

/**
 * Signed out: full-page login. Signed in: sidebar + top bar around the page,
 * with the identity shared through AdminSessionContext.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const { identity, setIdentity, error, reload } = useAdminIdentity();
  const signOut = useMemo(() => () => setIdentity(null), [setIdentity]);
  const session = useMemo(() => (identity ? { identity, signOut } : null), [identity, signOut]);

  if (identity === undefined) {
    return (
      <main id="main" tabIndex={-1} className="admin-login">
        <div className="admin-login__card stack">
          {error ? (
            <div className="alert alert-error" role="alert">
              <p>{error}</p>
              <button type="button" className="btn btn-secondary" onClick={reload}>
                ลองอีกครั้ง
              </button>
            </div>
          ) : (
            <p aria-busy="true">กำลังตรวจสอบการเข้าสู่ระบบ…</p>
          )}
        </div>
      </main>
    );
  }
  if (identity === null || !session) return <AdminLogin onSignedIn={setIdentity} />;

  return (
    <AdminSessionContext.Provider value={session}>
      <AdminFrame identity={identity} onSignedOut={signOut}>
        {children}
      </AdminFrame>
    </AdminSessionContext.Provider>
  );
}

function AdminFrame({
  identity,
  onSignedOut,
  children,
}: {
  identity: AdminIdentity;
  onSignedOut: () => void;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMenuOpen(false);
  }

  const ordersActive = pathname === "/admin" || pathname.startsWith("/admin/orders");
  const displayName = identity.username || identity.email;

  async function logout() {
    setLogoutError(null);
    try {
      await adminLogout();
      onSignedOut();
    } catch (err) {
      setLogoutError(describeError(err));
    }
  }

  return (
    <div className="admin">
      <aside className="admin-sidebar" data-open={menuOpen ? "true" : "false"}>
        <div className="admin-sidebar__head">
          <Link className="admin-brand" href="/admin">
            <BrandMark size={30} />
            <span>InBlack Admin</span>
          </Link>
          <button
            type="button"
            className="icon-btn admin-menu-btn"
            aria-expanded={menuOpen}
            aria-controls="admin-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
            <span className="sr-only">เมนูผู้ดูแล</span>
          </button>
        </div>
        <nav id="admin-nav" className="admin-nav" aria-label="เมนูผู้ดูแล">
          <p className="admin-nav__label">จัดการ</p>
          <ul>
            <li>
              <Link href="/admin" aria-current={ordersActive ? "page" : undefined}>
                <NavIcon d="M4 5h16M4 12h16M4 19h10" />
                ออเดอร์ / แดชบอร์ด
              </Link>
            </li>
            {hasRole(identity, "superadmin") && (
              <li>
                <Link href="/admin/products" aria-current={pathname.startsWith("/admin/products") ? "page" : undefined}>
                  <NavIcon d="M4 8l8-4 8 4-8 4zM4 8v8l8 4 8-4V8" />
                  สินค้า
                </Link>
              </li>
            )}
            <li>
              <button type="button" onClick={logout}>
                <NavIcon d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />
                ออกจากระบบ
              </button>
            </li>
          </ul>
        </nav>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <p className="admin-topbar__title">แผงควบคุมออเดอร์</p>
          <div className="admin-user">
            <span className="admin-user__avatar" aria-hidden="true">
              {displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="admin-user__name">
              <span className="sr-only">เข้าสู่ระบบเป็น </span>
              {displayName}
              <span className="admin-user__role">สิทธิ์ {ROLE_LABEL[identity.role] ?? identity.role}</span>
            </span>
          </div>
        </header>
        <div className="admin-content">
          {logoutError && (
            <p className="alert alert-error" role="alert">
              ออกจากระบบไม่สำเร็จ: {logoutError}
            </p>
          )}
          <main id="main" tabIndex={-1} className="stack">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

function NavIcon({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AdminLogin({ onSignedIn }: { onSignedIn: (identity: AdminIdentity) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loginRef = useRef<HTMLInputElement>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = login.trim();
    if (!value || !password) {
      setError("กรอกชื่อผู้ใช้หรืออีเมล และรหัสผ่าน");
      loginRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // `login` is the new field (username or email). `email` carries the same
      // value for an API that only knows the old field.
      onSignedIn(
        await api<AdminIdentity>("/admin/auth/login", {
          method: "POST",
          body: { login: value, email: value, password },
        }),
      );
    } catch (err) {
      setError(describeError(err));
      loginRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" tabIndex={-1} className="admin-login">
      <form className="admin-login__card stack" onSubmit={onSubmit} noValidate>
        <div className="admin-login__brand">
          <BrandMark size={36} />
          <span>InBlack Admin</span>
        </div>
        <h1>เข้าสู่ระบบผู้ดูแล</h1>
        <div className="field">
          <label htmlFor="admin-login">ชื่อผู้ใช้หรืออีเมล</label>
          <input
            ref={loginRef}
            id="admin-login"
            className="input"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={login}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "admin-login-error" : undefined}
            onChange={(e) => setLogin(e.target.value)}
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
        <button type="submit" className="btn btn-block" disabled={busy}>
          {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
        </button>
      </form>
    </main>
  );
}
