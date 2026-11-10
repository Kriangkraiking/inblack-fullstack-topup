# SEO

Short and honest: the basics for crawl control are in place; the richer SEO items of spec 9.2/9.3
are not.

## Done

- **`robots.txt`** (`apps/web/src/app/robots.ts`): `Allow: /` plus the sitemap URL. Private paths
  are **not** listed as `Disallow`, because a Disallow list advertises exactly the paths we do not
  want found (`/admin`, order pages). They are kept out of indexes with `noindex` instead.
- **`sitemap.xml`** (`apps/web/src/app/sitemap.ts`): only `/` and `/checkout`. No `/track`,
  `/my-orders` or `/admin`.
- **`noindex` twice on private pages:** `robots: { index: false, follow: false }` in the page
  metadata (track, my-orders, my-orders/[id], admin layout, admin/products) and the response
  header `X-Robots-Tag: noindex, nofollow` from `apps/web/next.config.ts` for `/track`,
  `/my-orders/*` and `/admin/*`. Checked on the running stack with `curl -I`. The header also
  covers non-HTML responses and pages whose metadata could be lost in a refactor.

## Why tracking, my-orders and admin must not be indexed

- **Personal data:** these pages show order contents, game UID and (masked) email. A search
  result is a copy we cannot take back.
- **No search value:** nobody searches for someone else's order; they only add thin, duplicate pages.
- **Crawl budget:** endless order-specific URLs would take crawl time from the catalog.
- **Order-id guessing:** listing or indexing order URLs would hand out valid ids, and the API is
  built so that a wrong id or a wrong email both answer the same 404 (rate limited, ADR 0005).
  Admin pages need a login anyway; indexing their shell only tells attackers where to try.

## Not done

| Item | Status |
|---|---|
| SSG/ISR for the catalog | Not used, by choice. Every page carries a per-request nonce in its CSP (`apps/web/src/proxy.ts`), and a statically generated page cannot have a fresh nonce, so pages render per request (`Cache-Control: private, no-cache`). The trade-off is speed for a CSP without `unsafe-inline`. |
| Product pages `/products/[slug]` | Not built (the API has `GET /api/v1/products/{slug}`). |
| JSON-LD Product/Offer | Not done (no product page). |
| Dynamic OG image | Not done. |
| i18n `/th` + `/en` with hreflang | Not done; the site is Thai only. |
| Lighthouse (mobile) | Not measured, so no scores are claimed. |
