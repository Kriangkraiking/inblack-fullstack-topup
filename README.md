# InBlack Top-Up

## Running the tests

```sh
make test                       # lint, typecheck, unit, integration, e2e; stops at the first failure
node scripts/ci/test-all.mjs    # the same without make (Windows); also: pnpm test:all
```

Single steps: `make lint | typecheck | unit | integration | e2e` (or
`node scripts/ci/test-all.mjs <step> ...`); `make up` / `make down` for the main stack.
Needs Docker (Compose v2) and Node. With Node < 22.12 the pnpm steps run in the `node:22` image
on a copy of the working tree (pnpm store cached in the volume `inblack-ci-pnpm-store`).

- **integration**: `*.int.spec.ts` against a real, empty Postgres 16 + Redis 7: locally from
  `scripts/ci/integration.compose.yml` (project `inblack-ci-int`, ports 55432/56379, removed
  afterwards), in CI from service containers via `TEST_DATABASE_URL`. The tests apply the
  migrations and seed themselves. The step fails if any test skipped or none passed.
- **e2e**: `docker compose up --build -d --wait` of the working tree (project `inblack-e2e`), then
  `scripts/audit/sse.mjs`, `scripts/audit/invariants.mjs --reuse` against that stack, and
  `scripts/audit/security.mjs` when present; `down -v` afterwards (`--keep` leaves it up). It
  refuses to start while another project's `inblack-*` containers exist (fixed container names).

CI (`.github/workflows/ci.yml`) runs the same steps: lint → typecheck → unit → integration → e2e →
`docker compose build`. Its e2e runs only `--invariants s1a,s2b,s3,s4`, one scenario per money or
goods invariant (s1a oversell burst, s2b duplicate/replayed webhooks, s3 concurrent refunds plus
reconciliation, s4 voucher limits). The others (s1b-s1d, s2a, s7, s8) repeat those invariants
through expiry, worker kills and api-1/Redis outages and take most of the run time, so `make e2e`
runs them all locally (`INVARIANTS=s7,s8 make e2e` for a subset).
