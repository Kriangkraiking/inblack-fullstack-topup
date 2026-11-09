# AI Log

## AI mistakes caught

- **P0 scaffold, `docker compose` flag:** the agent ran `docker compose up --build -d --progress plain`. Compose rejected it with `unknown flag: --progress` because `--progress` is a global flag, not an `up` flag. The failed run built nothing. The acceptance run used the unmodified `docker compose up --build -d` with `BUILDKIT_PROGRESS=plain`.
