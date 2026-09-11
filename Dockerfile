# syntax=docker/dockerfile:1.7
# Multistage build for My Kitchen (SvelteKit + adapter-node).
# Dependency layers are reused as long as package.json / pnpm-lock.yaml do not change.

ARG NODE_IMAGE=node:24.9.0-bookworm-slim

# ---------- base: pnpm + the manifests every dependency stage needs ----------
# `deps` and `prod-deps` both start here, so the pnpm install and the manifest
# COPY happen once and the two installs then run in parallel.
FROM ${NODE_IMAGE} AS base
ENV CI=true
RUN --mount=type=cache,id=npm-global,target=/root/.npm \
    npm install -g pnpm@12.3.4 --no-fund --no-audit
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# ---------- deps: full install (dev deps needed for the build) ----------
# --store-dir must match the cache mount. pnpm ignores PNPM_STORE_DIR and
# npm_config_store_dir, so without the flag the store lands in
# /root/.local/share/pnpm/store and every build re-downloads all 377 packages.
FROM base AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store \
    --config.confirmModulesPurge=false

# ---------- build ----------
FROM deps AS build
COPY . .
# No secrets or database are needed at build time; $env/dynamic values are read at runtime.
RUN pnpm build

# ---------- prod-deps: runtime dependencies only ----------
# `prune` off `deps` rather than a second full install: it reuses the linked
# tree instead of re-linking all 377 packages, and it reuses the supply-chain
# verification `deps` just did instead of repeating it. --ignore-scripts skips
# the `prepare` script, which cannot work once svelte-kit has been pruned away.
FROM deps AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm prune --prod --ignore-scripts --store-dir=/pnpm/store \
    --config.confirmModulesPurge=false

# ---------- runtime: app server ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
RUN groupadd -r app && useradd -r -g app -d /app app \
    && mkdir -p /app/data/uploads && chown -R app:app /app
WORKDIR /app
# No --chown on the two large trees: the app only reads them, and rewriting the
# ownership of ~200 MB of node_modules forces a full copy of every file.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./
COPY drizzle ./drizzle
COPY scripts/migrate.mjs scripts/consistency-check.mjs scripts/start.mjs \
     scripts/delete-user.mjs scripts/db-ssl.mjs ./scripts/
USER app
EXPOSE 3000
# node's global fetch replaces curl, which is the only thing the apt-get layer
# was installing.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 CMD \
    node -e "fetch('http://127.0.0.1:3000/health?ready=1').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "scripts/start.mjs"]
