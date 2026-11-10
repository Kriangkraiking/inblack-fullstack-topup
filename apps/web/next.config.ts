import path from "node:path";
import type { NextConfig } from "next";

const NOINDEX = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];

const nextConfig: NextConfig = {
  // cacheComponents / partial prerendering are off: the nonce CSP in src/proxy.ts
  // needs every page rendered per request, and a static shell has no nonce.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      { source: "/track", headers: NOINDEX },
      { source: "/my-orders", headers: NOINDEX },
      { source: "/my-orders/:path*", headers: NOINDEX },
      { source: "/admin", headers: NOINDEX },
      { source: "/admin/:path*", headers: NOINDEX },
    ];
  },
};

export default nextConfig;
