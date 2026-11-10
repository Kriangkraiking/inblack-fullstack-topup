"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError, describeError } from "./api";
import type { AdminIdentity, AdminRole } from "./types";

const RANK: Record<AdminRole, number> = { viewer: 0, support: 1, finance: 2, superadmin: 3 };

/** Only hides buttons. The API checks the role on every call regardless. */
export function hasRole(identity: AdminIdentity, needed: AdminRole): boolean {
  return RANK[identity.role] >= RANK[needed];
}

/** undefined while loading, null when signed out. */
export function useAdminIdentity() {
  const [identity, setIdentity] = useState<AdminIdentity | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIdentity(await api<AdminIdentity>("/admin/auth/me"));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setIdentity(null);
      else setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  return { identity, setIdentity, error, reload: load };
}

export interface AdminSession {
  identity: AdminIdentity;
  /** Forget the session in the UI (after logout or a 401); the shell shows the login form. */
  signOut: () => void;
}

/**
 * The admin shell (app/admin/admin-shell.tsx) checks /admin/auth/me once and
 * only renders pages when signed in, so pages read the identity from here
 * instead of each calling /me again.
 */
export const AdminSessionContext = createContext<AdminSession | null>(null);

export function useAdminSession(): AdminSession {
  const session = useContext(AdminSessionContext);
  if (!session) throw new Error("useAdminSession must be used inside the admin shell");
  return session;
}

export async function adminLogout(): Promise<void> {
  await api("/admin/auth/logout", { method: "POST" });
}
