# AI Log

## AI mistakes caught

- **P0 scaffold, `docker compose` flag:** the agent ran `docker compose up --build -d --progress plain`. Compose rejected it with `unknown flag: --progress` because `--progress` is a global flag, not an `up` flag. The failed run built nothing. The acceptance run used the unmodified `docker compose up --build -d` with `BUILDKIT_PROGRESS=plain`.
- **P1 mock-pay, restart test arithmetic:** the agent's first restart test used a 50 ms backoff base, so the full retry sequence needed about 12.75 s, but the test waited only 8 s and failed with a timeout. The server was correct. The test now uses the suite's 20 ms base (about 5.1 s), and the real default backoff was also checked against the built image.
- **P1 domain, order id random source type:** the agent typed the random callback as a plain `Uint8Array`. All 161 unit tests passed because vitest does not typecheck, but `tsc` rejected it with TS2345 against `getRandomValues`. The type is now `Uint8Array<ArrayBuffer>`. This is why typecheck runs as well as the tests.
- **P1 db, wrong expectation in the 100-pair proof:** the agent's proof script expected 77 of the 100 status pairs to be rejected by the trigger. The real result was 23 allowed, 67 rejected and 10 not rejected. The 10 were same-status updates, which change nothing and write no event, so the trigger has no transition to reject. The trigger was correct and the expectation was wrong. The domain layer still rejects same-status moves in `assertTransition`.
