# syntax=docker/dockerfile:1.7
# Multistage build for My Kitchen (SvelteKit + adapter-node).
# Dependency layers are reused as long as package.json / pnpm-lock.yaml do not change.

ARG NODE_IMAGE=node:24.9.0-bookworm-slim

# ---------- deps: full install (dev deps needed for the build) ----------
FROM ${NODE_IMAGE} AS deps
ENV CI=true
RUN npm install -g pnpm@12.3.4 --no-fund --no-audit
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --config.confirmModulesPurge=false

# ---------- build ----------
FROM deps AS build
COPY . .
# No secrets or database are needed at build time; $env/dynamic values are read at runtime.
RUN pnpm build

# ---------- prod-deps: runtime dependencies only ----------
FROM deps AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm prune --prod --config.confirmModulesPurge=false

# ---------- runtime: app server ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app && useradd -r -g app -d /app app \
    && mkdir -p /app/data/uploads && chown -R app:app /app
WORKDIR /app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/build ./build
COPY --chown=app:app package.json ./
COPY --chown=app:app drizzle ./drizzle
COPY --chown=app:app scripts/migrate.mjs scripts/consistency-check.mjs scripts/start.mjs \
     scripts/delete-user.mjs ./scripts/
USER app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 CMD curl -fsS http://127.0.0.1:3000/health?ready=1 || exit 1
CMD ["node", "scripts/start.mjs"]
