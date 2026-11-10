import type { Product } from "./types";

/**
 * Server-side reads use the compose-internal address (nginx), never the
 * browser's localhost:8080. A failure returns null so the page still renders
 * and the client island loads the data itself. Nothing here runs at build
 * time: every page is rendered per request (see layout.tsx).
 */
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:8080";

export async function fetchProductsOnServer(): Promise<Product[] | null> {
  try {
    const response = await fetch(`${API_INTERNAL_URL}/api/v1/products`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { items?: Product[] };
    return Array.isArray(body.items) ? body.items : null;
  } catch {
    return null;
  }
}
