"use client";

import { useCallback, useEffect, useState } from "react";
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
