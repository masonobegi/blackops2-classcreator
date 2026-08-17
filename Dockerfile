# Node 22.18+ is required: this project runs TypeScript natively (type
# stripping) and uses the built-in node:sqlite module. There is no build step
# and there are no runtime dependencies, so there is nothing to compile or
# install here.
FROM node:22-alpine

WORKDIR /app

# Persistent volume mount point. DATABASE_PATH should point inside it.
RUN mkdir -p /data && chown node:node /data

COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/driftwatch.db

USER node
EXPOSE 8080

# Container-level healthcheck hits the same endpoint a load balancer would.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
