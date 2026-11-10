import type { MetadataRoute } from "next";

const SITE_URL = process.env.SITE_URL ?? "http://localhost:3000";

/** Public pages only: no tracking, my-orders or admin. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "hourly", priority: 1 },
    { url: `${SITE_URL}/checkout`, changeFrequency: "monthly", priority: 0.5 },
  ];
}
