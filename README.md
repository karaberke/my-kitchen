# Pantry & Plate

Recipes, grocery planning and pantry tracking for a household. One SvelteKit app,
one PostgreSQL database, Docker Compose deployment behind a Cloudflare Tunnel.

- **Recipes** – manual entry with drafts, groups, sections, fractions, tags, photos,
  scaling, sharing with households, favorites, duplicate, print, JSON export.
- **Grocery lists** – plan recipe batches, aggregate demand, subtract pantry once,
  review, then shop: purchases enter the pantry in full and credit the list.
- **Pantry** – stock lots with locations and use-by dates, corrections, waste,
  append-only history, undo, and a consistency check.
- **Households** – multiple memberships, owner/member roles, single-use invite links.

Stack: SvelteKit 2 / Svelte 5 / TypeScript / Tailwind 4 / PostgreSQL 17 / Drizzle ORM /
Postgres.js / Better Auth / Zod / sharp. Node 24 LTS, pnpm.

## Development

```sh
pnpm install
pnpm db:dev            # PostgreSQL 17 on 127.0.0.1:5433 (docker compose -f compose.dev.yaml)
cp .env.example .env   # defaults already point at the dev database
pnpm db:migrate        # applies drizzle/*.sql (schema + read-only ingredient catalog)
pnpm dev               # http://localhost:5173
```

Create an account at `/register`; a personal household is created automatically.

Useful scripts:

| Command                                        | Purpose                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm check` / `pnpm lint`                     | type check, prettier + eslint                                        |
| `pnpm test:unit`                               | pure quantity/units/planning tests                                   |
| `pnpm test:integration`                        | transaction tests against `recipe_test` (real PostgreSQL)            |
| `pnpm build && pnpm test:e2e`                  | Playwright browser flows against the built app                       |
| `pnpm db:generate`                             | generate a migration after editing `src/lib/server/db/schema.ts`     |
| `pnpm db:check`                                | pantry consistency check (balances vs movement log)                  |
| `pnpm seed:perf`                               | development-only performance dataset (10 households × 200 recipes …) |
| `pnpm measure -- --base http://localhost:3000` | warm p50/p95 of key reads against a running server                   |
| `node --env-file=.env scripts/explain.mjs`     | EXPLAIN (ANALYZE, BUFFERS) for representative queries                |

The test database is created once: `docker compose -f compose.dev.yaml -p recipe-saver-dev exec db psql -U recipe -d recipe_dev -c 'create database recipe_test'`, then `pnpm db:migrate:test`.

## Production

See [docs/deployment.md](docs/deployment.md). Short version:

```sh
cp .env.example .env   # set POSTGRES_PASSWORD, ORIGIN, BETTER_AUTH_SECRET, CLOUDFLARE_TUNNEL_TOKEN
docker compose up -d --build
```

Services: `db` (persistent volume), `migrate` (one-shot, serialized), `app`
(Node on 0.0.0.0:3000, no host port), `cloudflared`. A cloud-PostgreSQL variant is
`compose.cloud-db.yaml`; a local production-like variant with a published port is
`compose.local-prod.yaml`.

## Layout

```
src/lib/shared/     pure quantity logic shared by browser and server (decimal, units, parsing, planning)
src/lib/server/     business logic, access checks, database, storage adapters
src/lib/components/ UI components
src/routes/         pages, form actions, API and media endpoints
drizzle/            committed migrations
scripts/            migrate, seed, measure, explain, consistency check
tests/              unit (src/**/*.test.ts), integration, e2e
docs/               design decisions, deployment, measurements
```

## Documentation

- [Design decisions](docs/design-decisions.md) – ownership, snapshots, transaction invariants, cache rules, deferred features
- [Deployment](docs/deployment.md) – Compose, tunnel, cache rules, backup/restore, troubleshooting
- [Measurements](docs/measurements.md) – dataset, query counts, payload sizes, latencies
