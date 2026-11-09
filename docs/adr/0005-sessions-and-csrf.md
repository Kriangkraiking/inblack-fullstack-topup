# ADR 0005: Customer sessions, CSRF and rate limits

Status: Draft. Built in `apps/api/src/customer-auth/` and `apps/api/src/security/`, proven by `scripts/audit/security.mjs`.

## Context

Spec 8.4 asks for OTP sign-in (6 digits, 5 minutes, 5 wrong codes lock for 15 minutes, single use), httpOnly + Secure + SameSite session cookies, CSRF protection for requests that change data, a rate limit on `/orders/track` (10/min/IP, 5/min/order id, 429 with Retry-After), and the same answer for "no such order" and "wrong email". The API runs as two replicas behind nginx, so nothing can live in one process's memory.

## Decisions

### Sessions

- Customer sessions are server-side rows in `customer_sessions`, separate from `admin_sessions` (migration 0009), so a customer token can never be read as an admin one. Only the SHA-256 of the 32-byte token is stored.
- Cookies `inblack_session` and `inblack_admin_session`: `HttpOnly; SameSite=Strict; Path=/`, `Secure` when `COOKIE_SECURE=true`. It defaults to false because compose serves plain http on localhost (decided by the user). Behind TLS it must be true.

### OTP

- Code from `crypto.randomInt`, stored as HMAC-SHA256(`OTP_HASH_SECRET`, email + code). A plain hash of a 6-digit code can be reversed by trying a million codes.
- The counter and lock live in Postgres (`customer_otps`), not Redis, so the lock holds with Redis down. Verify takes the row with `SELECT ... FOR UPDATE`, decides in a pure function (`decideVerify`), and commits the failure count before answering. The success path also uses a conditional `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()`. Ten verifies at once with the right code give one session (audit `otp/race`).
- A wrong code while the stored one is used or expired counts as a failure. The right code sent again after use does not: only someone who had the code can send it, and a double submit must not lock out the person who just signed in. The first audit run caught this, see AI_LOG.
- Asking for a new code does not reset the failure count, and no code is stored or sent while locked. A lock also drops the code.
- `POST /auth/otp/request` answers 202 with the same body for every valid email, does no order lookup, and sends the email in the background, so neither body nor timing depends on the address. Postgres allows one new code per email per 30 s.

### CSRF

SameSite=Strict already keeps the cookies off cross-site requests. On top of that, `CsrfGuard` (global, before the admin guard) refuses with 403 `CSRF_ORIGIN_MISMATCH` any POST/PUT/PATCH/DELETE that carries a session cookie unless its `Origin` header is exactly in `CSRF_ALLOWED_ORIGINS` (default `http://localhost:8080,http://localhost:3000`). A missing Origin is refused too: browsers send Origin on every POST, so only a non-browser client leaves it out, and such a client can add it.

Why not a double-submit token: it needs a token endpoint, client code on every request and handling for expiry. SameSite=Strict plus an exact Origin allowlist covers the same attacks for the browsers we support, with nothing for the frontend to do except call with `credentials: 'include'`. "Same site" is not enough on its own, because `localhost:3000` and `localhost:8080` are one site; the Origin check tells them apart.

Exempt with `@SkipCsrf()` because they never read a cookie: the payment webhook, `POST /orders`, `POST /orders/track`, `/auth/otp/*`. CORS uses the same origin list with credentials, so an origin that may read answers is exactly one that may send cookie requests.

### Rate limits

- Fixed one-minute windows in Redis: one Lua script does INCR and PEXPIRE together, so both replicas share the counter and no key is left without expiry. Keys hold a SHA-256 of the subject, not the IP or email.
- Client IP: nginx sets `X-Real-IP` and `X-Forwarded-For` to `$remote_addr`, replacing whatever the client sent (it used to append to X-Forwarded-For). The API reads X-Real-IP. The replicas are not published outside the compose network, so only nginx can set it. Audit `track/spoof` shows a client header does not reset the count.
- Track counts the IP before parsing and the order id after, so malformed requests still use up the IP allowance.
- **Redis down: fail open.** The limiter lets the request through, with a command timeout of 300 ms and a warning at most once a minute. Track only reads, the per-order key keeps guessing slow while Redis is up, and refusing all tracking during a Redis outage would take a customer feature down for a defence-in-depth control. Nothing that guards money or the OTP lock depends on Redis. OTP sends are still held to one per email per 30 s by Postgres.

### Enumeration on track

Unknown order and wrong email run the same single query (`WHERE id = $1 AND email = $2`) and throw the same `orderNotFound()`. The audit compares the bodies byte for byte and the medians of 60 requests each (about 9% apart, threshold 20%).

## Consequences

- A client outside the browser that uses a session cookie (scripts, curl) must send an allowed Origin. `scripts/audit/invariants.mjs` does.
- A third-party frontend origin must be added to `CSRF_ALLOWED_ORIGINS`.
- If the web app proxies API calls through its own server instead of calling `:8080` from the browser, nginx sees the web container's address and every user shares one rate limit bucket. The browser should call the API directly.
- During a Redis outage the track limit is not enforced.
