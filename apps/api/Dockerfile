# Build context is the repo root.
FROM node:22-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "api..."
RUN pnpm --filter "api..." build
RUN pnpm --filter api deploy --prod --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
# Read by POST /api/v1/_test/reset, so there is one seed file and not a copy to keep in step.
COPY --from=build --chown=node:node /repo/db/seed/seed.sql ./seed/seed.sql
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
