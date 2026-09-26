# syntax=docker/dockerfile:1
#
# Modern POS backend (NestJS) - multi-stage production image
#   docker build -t top-backend ./top-backend
#   docker run --env-file top-backend/.env -p 3000:3000 top-backend
#
# Migrations (run before starting a new version):
#   docker run --rm --env-file top-backend/.env top-backend npm run migration:run:prod
# First admin user:
#   docker run --rm --env-file top-backend/.env top-backend npm run seed:prod

ARG NODE_VERSION=22

# ---- deps: full dependency tree (dev deps needed for `nest build`) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build: compile TypeScript, then drop dev dependencies -------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---- runtime: compiled app + production node_modules, non-root ---------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP_VERSION=""
ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION} \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000

# Readiness: 200 when the database answers, 503 otherwise
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/'+(process.env.API_PREFIX||'api/v1')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main"]
