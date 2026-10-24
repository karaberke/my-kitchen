# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runner
ENV CI=true
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12.3.4 --no-fund --no-audit
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=egress-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store \
    --config.confirmModulesPurge=false
COPY svelte.config.js vite.config.ts tsconfig.json vitest.egress.config.ts ./
COPY src ./src
COPY static ./static
COPY tests/egress ./tests/egress
COPY deploy/smokescreen/config.yaml ./deploy/smokescreen/config.yaml
RUN pnpm exec svelte-kit sync \
    && node tests/egress/config.mjs deploy/smokescreen/config.yaml /tmp/egress-proxy.yaml
CMD ["node", "tests/egress/start.mjs"]

FROM my-kitchen-smokescreen:0.1.0 AS test-proxy
# The binary and production policy stay unchanged; only exact fixture endpoints are allowed.
COPY --from=runner /tmp/egress-proxy.yaml /etc/smokescreen/config.yaml
