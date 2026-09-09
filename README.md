# My Kitchen

Self-hosted recipes, grocery lists and pantry tracking for your household.
Plan meals from your recipes, see what is missing from the pantry, shop, cook, and keep stock in sync across everyone's phones.

## Self-host in one command

You need Docker (Engine or Desktop) with Compose v2.

```sh
git clone https://github.com/YOUR-GITHUB-USER/my-kitchen.git my-kitchen && cd my-kitchen && ./deploy.sh
```

That's it: `deploy.sh` writes a `.env` with generated secrets, builds the image, starts PostgreSQL, runs migrations and the app, and prints the URL (default `http://localhost:3000`). Open it, create the first account, done.

Pick your own port and how the app is reachable:

| I want…                                       | Command                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| a different port                              | `./deploy.sh --port 8080`                                                  |
| access from other devices on my network       | `./deploy.sh --port 8080 --bind 0.0.0.0 --origin http://192.168.1.20:8080` |
| a public URL right now, no domain, no account | `./deploy.sh --quick-tunnel`                                               |
| my own domain through Cloudflare              | `./deploy.sh --tunnel-token <token> --origin https://pantry.example.com`   |
| a managed PostgreSQL (Neon, Supabase, RDS…)   | `./deploy.sh --cloud-db 'postgres://user:pass@host/db'`                    |
| to close sign-ups after the first accounts    | `./deploy.sh --registration closed`                                        |

`--origin` is the exact URL people type (scheme, host, port); it is set automatically for local installs.
Run `./deploy.sh` again after `git pull` to update; it keeps your `.env` and data.
Everything is in `.env` if you prefer editing by hand, then `docker compose up -d --build`.

### Cloudflare in two minutes

- **Try it out:** `./deploy.sh --quick-tunnel` prints a `https://<random>.trycloudflare.com` URL. No account needed. The URL changes on every restart, so use it for testing only.
- **Your domain:** in the Cloudflare dashboard go to _Zero Trust → Networks → Tunnels → Create a tunnel_, copy the token, and add a public hostname (for example `pantry.example.com`) pointing to `http://app:3000`. Then run
  `./deploy.sh --tunnel-token <token> --origin https://pantry.example.com`.
  Nothing is exposed on the host except `127.0.0.1:<port>`.

Recommended Cloudflare cache rules and everything about backups, updates and troubleshooting are in [docs/deployment.md](docs/deployment.md).

## What you get

- **Recipes** – manual entry with drafts, ingredient groups, fractions, tags, photos, scaling, sharing with your household, favorites, print and JSON export.
- **Grocery lists** – plan recipe batches, see the combined demand minus what the pantry already has, then shop; purchases go straight into the pantry.
- **Pantry** – stock with locations and use-by dates, corrections, waste, full history with undo.
- **Households** – invite links, owner/member roles, several households per account, changes visible on other devices within seconds.

Stack: SvelteKit 2, Svelte 5, TypeScript, Tailwind 4, PostgreSQL 17, Drizzle ORM, Better Auth. Node 24, pnpm.

## Development

```sh
pnpm install
pnpm db:dev            # PostgreSQL 17 on 127.0.0.1:5433 (compose.dev.yaml)
cp .env.example .env   # defaults point at the dev database
pnpm db:migrate
pnpm dev               # http://localhost:5173
```

| Command                                                          | Purpose                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm check`, `pnpm lint`                                        | types, formatting, eslint                                 |
| `pnpm test:unit`, `pnpm test:integration`                        | pure logic; transactions against `recipe_test`            |
| `pnpm build && pnpm test:e2e`                                    | Playwright flows against the built app                    |
| `pnpm db:generate`                                               | new migration after editing `src/lib/server/db/schema.ts` |
| `pnpm seed:perf`, `pnpm measure -- --base http://localhost:3000` | performance dataset and timings                           |

Create the test database once: `docker compose -f compose.dev.yaml -p my-kitchen-dev exec db psql -U recipe -d recipe_dev -c 'create database recipe_test'`, then `pnpm db:migrate:test`.

## Documentation

- [Deployment](docs/deployment.md) – all `deploy.sh` and `.env` options, Cloudflare setup and cache rules, updates, backup/restore, troubleshooting
- [Design decisions](docs/design-decisions.md) – ownership, grocery snapshots, transaction invariants, cache policy, deferred features
- [Measurements](docs/measurements.md) – dataset, query counts, payload sizes, latencies, verification runs
