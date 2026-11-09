# Seed credentials

Test accounts for local and review environments only. `db/seed/seed.sql` stores only their hashes.

| Role | Email | Password |
|---|---|---|
| viewer | `viewer@inblackm.test` | `Viewer-Test-2026` |
| support | `support@inblackm.test` | `Support-Test-2026` |
| finance | `finance@inblackm.test` | `Finance-Test-2026` |
| superadmin | `superadmin@inblackm.test` | `Superadmin-Test-2026` |

## Hash format

`scrypt$N$r$p$<salt base64>$<hash base64>`, produced by Node's `crypto.scryptSync(password, salt, 32, { N, r, p })`. The seeded accounts use N=16384, r=8, p=1. Compare with `crypto.timingSafeEqual`.
