# Build context is the repo root. No dependencies or build step, so one stage is enough.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY apps/mock-pay/package.json apps/mock-pay/server.js ./
# An empty named volume mounted here inherits this ownership, so USER node can write.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4010
CMD ["node", "server.js"]
