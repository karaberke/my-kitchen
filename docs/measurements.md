# Measurements

All numbers below were produced on the development machine and are starting
points to compare against, not guarantees for other hardware.

## Machine and dataset

- Apple Silicon Mac (arm64), macOS, Node v26.8.1 for the local measurement,
  Node 24 in the Docker image. PostgreSQL 17.6 in Docker on the same machine.
- Dataset from `pnpm seed:perf` (reproducible, seeded PRNG):
  10 households × 200 recipes (4–10 ingredients, 3–7 steps each), 200 pantry
  lots per household (2,000 lots, one movement each), one shopping list with
  300 lines in household 1. 144 catalog ingredients.
- Server: `pnpm build` output (`node build/index.js`), warm, measured with
  `scripts/measure.mjs` (30 runs each, after one warm-up request), same host,
  no Cloudflare, no image transfer.

## Warm server response times (30 runs, ms)

| Read                                 | Status | p50 | p95  | max  | Payload       |
| ------------------------------------ | ------ | --- | ---- | ---- | ------------- |
| Recipes page 1, HTML                 | 200    | 7.0 | 8.7  | 11.0 | 55,021 bytes  |
| Recipes page 1, data (`__data.json`) | 200    | 5.8 | 6.9  | 7.0  | 7,572 bytes   |
| Recipes search `q=chicken`           | 200    | 6.4 | 7.8  | 8.7  | 5,962 bytes   |
| Pantry, data (200 lots)              | 200    | 7.3 | 11.4 | 12.6 | 64,664 bytes  |
| Shopping list, data (300 lines)      | 200    | 9.9 | 14.6 | 14.7 | 113,554 bytes |
| Revision poll `/api/revisions`       | 200    | 5.4 | 6.7  | 6.9  | 75 bytes      |

Target was warm p95 < 500 ms; every read is well below that locally. The
unchanged revision poll is 75 bytes and does not fetch any list data.

## Query counts per page

Counted from the server code paths (each bullet is one round trip):

- Recipes page: session lookup (Better Auth), memberships, active-household
  preference, recipe page (one query with joins for owner, favorite, image),
  total count, tag list = 6 queries regardless of card count (24 or 100).
- Recipe detail: session, memberships, preference, recipe, ingredients, steps,
  favorite, share rows (owner only), ingredient meta, stock lots for the
  ingredient set, current list lookup = 11 queries, independent of ingredient count.
- Pantry: session, memberships, preference, lots+ingredients, distinct locations,
  active count, household revisions = 7 queries for 200 lots.
- Shopping list: session, memberships, preference, list+household, batches,
  lines, requirements, line sources, household revisions = 9 queries for 300 lines.
- Revision poll: session, membership check, household row = 3 small indexed queries.

## Query plans (EXPLAIN ANALYZE, BUFFERS on the seeded database)

`node --env-file=.env scripts/explain.mjs`:

- Membership lookup: index scan on the composite primary key, 0.03 ms.
- Recipe list (readable, ordered, limit 24): 0.99 ms. At 2,000 recipes the
  planner prefers a sequential scan over `recipe_owner_updated_idx`; the share
  subquery uses the membership primary key with memoization. Worth re-checking
  once a database has tens of thousands of recipes.
- Pantry overview: bitmap index scan on `stock_lot_household_active_idx`
  (partial index on quantity > 0), 0.41 ms for 200 lots.
- Shopping list lines: 0.26 ms for 300 lines.
- History page: backward index scan on `inventory_event_household_time_idx`, 0.03 ms.
- Ingredient autocomplete: 0.05 ms; with 144 catalog rows the planner uses a
  sequential scan, the `text_pattern_ops` index takes over as the table grows.

No trigram or full-text indexes were added: title `ILIKE` over a user's readable
recipes and prefix lookup over ingredient names stayed far below the budget.

## Docker build behaviour

- First build (no cache): downloads the Node base image and installs all
  dependencies (~1–3 minutes depending on network), then builds the app.
- Repeated build with only source changes: dependency layers (`package.json`,
  `pnpm-lock.yaml`, `pnpm install` with a BuildKit cache mount) are reused; only
  the `COPY . .`, `pnpm build` and `pnpm prune` layers rerun. Measured:
  `docker compose -f compose.local-prod.yaml up -d --build` after a source-only
  change completed in 11 s on the development machine (image build + start).
- Build requires no secrets and no database: `serverEnv()` returns placeholders
  while `building` is true; real values are validated at container start.

## Payload notes

- Recipe cards ship only card fields (title, short description, times, tags,
  favorite flag, thumb dimensions), 24 per page, capped at 100.
- The shopping list payload (113 KB for 300 lines) includes sources per line;
  that list is deliberately larger than a normal trip. History and recipes are
  paginated; pantry loads active lots only (capped at 5,000 rows).

## Verification runs recorded for this build

| Suite                                                                                                              | Result                                    |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `pnpm check` (svelte-check)                                                                                        | 0 errors                                  |
| `pnpm lint` (prettier + eslint)                                                                                    | clean                                     |
| `pnpm test:unit`                                                                                                   | 9 files, 57 tests passed                  |
| `pnpm test:integration` (real PostgreSQL)                                                                          | 5 files, 17 tests passed                  |
| `pnpm build`                                                                                                       | adapter-node output, precompressed assets |
| `pnpm test:e2e` (Playwright, built app)                                                                            | 5 flows passed                            |
| Docker: fresh `db` start → `migrate` → `app` healthy                                                               | passed (`compose.local-prod.yaml`)        |
| Docker: `down`/`up` keeps users and sessions; migrate reruns idempotently                                          | passed                                    |
| Docker: migration failure (bad password) exits 1, app does not start                                               | passed                                    |
| Docker: cloud-db variant against an external Postgres (no db service)                                              | passed                                    |
| Backup with `pg_dump -Fc`, restore into a disposable database                                                      | passed                                    |
| Response headers on the container: dynamic `private, no-store`, hashed assets immutable + brotli, robots short TTL | passed                                    |
