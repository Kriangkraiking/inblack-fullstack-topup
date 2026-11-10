# Seed credentials

Test accounts for local and review environments only. `db/seed/seed.sql` stores only their hashes.

| Role | Email | Password |
|---|---|---|
| viewer | `viewer@inblackm.test` | `Viewer-Test-2026` |
| support | `support@inblackm.test` | `Support-Test-2026` |
| finance | `finance@inblackm.test` | `Finance-Test-2026` |
| superadmin | `superadmin@inblackm.test` | `Superadmin-Test-2026` |
| superadmin | username `Admin` (any case; email `admin@inblackm.test`) | `Admin3324` |

The `Admin` account is a test value too (migration 0011 and the seed). Sign in with `{"login":"Admin","password":"Admin3324"}`; the other accounts sign in with their email in `login` or in the original `email` field.

## Hash format

`scrypt$N$r$p$<salt base64>$<hash base64>`, produced by Node's `crypto.scryptSync(password, salt, 32, { N, r, p })`. The seeded accounts use N=16384, r=8, p=1. Compare with `crypto.timingSafeEqual`.

## Customers

Customers have no seeded password. Sign in with any email: `POST /api/v1/auth/otp/request`, read the 6-digit code at http://localhost:8025 (mailpit), then `POST /api/v1/auth/otp/verify`. The code is stored only as an HMAC keyed with `OTP_HASH_SECRET`, whose compose default is a local test value.
