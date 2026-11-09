# AI Log

## AI mistakes caught

- **P0 scaffold, `docker compose` flag:** the agent ran `docker compose up --build -d --progress plain`. Compose rejected it with `unknown flag: --progress` because `--progress` is a global flag, not an `up` flag. The failed run built nothing. The acceptance run used the unmodified `docker compose up --build -d` with `BUILDKIT_PROGRESS=plain`.
- **P1 mock-pay, restart test arithmetic:** the agent's first restart test used a 50 ms backoff base, so the full retry sequence needed about 12.75 s, but the test waited only 8 s and failed with a timeout. The server was correct. The test now uses the suite's 20 ms base (about 5.1 s), and the real default backoff was also checked against the built image.
