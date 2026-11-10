import type { MetadataRoute } from "next";

const SITE_URL = process.env.SITE_URL ?? "http://localhost:3000";

/**
 * Private pages are not listed here at all (listing them would advertise the
 * paths). They send noindex in both the meta tag and X-Robots-Tag instead.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
