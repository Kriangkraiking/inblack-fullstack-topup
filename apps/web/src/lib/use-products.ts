"use client";

import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "./api";
import type { Product } from "./types";

const REFRESH_MS = 15_000;

/**
 * Product list with stock refreshed from the browser every 15 seconds.
 * Shared by the catalog and checkout (moved out of app/catalog.tsx when the
 * customer pages went into the (shop) route group).
 */
export function useProducts(initial: Product[] | null) {
  const [products, setProducts] = useState<Product[] | null>(initial);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await api<{ items: Product[] }>("/products");
      setProducts(body.items);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  return { products, error, reload: load };
}
