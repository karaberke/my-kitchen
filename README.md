# My Kitchen

Self-hosted recipes, grocery lists and pantry tracking for your household.
Plan meals from your recipes, see what is missing from the pantry, shop, cook, and keep stock in sync across everyone's phones.

## Self-host

You need Docker (Engine or Desktop) with Compose v2.

```sh
git clone https://github.com/YOUR-GITHUB-USER/my-kitchen.git && cd my-kitchen
cp .env.example .env
openssl rand -base64 32      # paste the output as BETTER_AUTH_SECRET
```

Open `.env` and set at least:

| Variable                                      | What to put                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POSTGRES_PASSWORD`                           | Any password for the database (letters, digits, `- _ .`). Only used inside Docker.                     |
| `BETTER_AUTH_SECRET`                          | The random string from `openssl rand -base64 32`.                                                      |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | Your own account. It is created on the first start; afterwards these lines are ignored.                |
| `APP_PORT`                                    | The port to serve on (default 3003).                                                                   |
| `ORIGIN`                                      | The URL people will type, default `http://localhost:3003`. Change it when you change the port or host. |

`docker compose` refuses to start while `POSTGRES_PASSWORD` or `BETTER_AUTH_SECRET` is missing.

**Shortcut:** `./deploy.sh` does all of the above for you (generates the secrets, asks for your account, starts everything and prints the URL). `./deploy.sh --port 8080`, `--quick-tunnel`, `--tunnel-token`, `--admin-email` and the other flags are listed in [docs/deployment.md](docs/deployment.md).

### Start it

```sh
docker compose up -d --build
```

The first run builds the image (a few minutes), starts PostgreSQL, applies the database migrations and creates your account. Data lives in the Docker volumes `my-kitchen_pgdata` (database) and `my-kitchen_uploads` (photos) and survives restarts, updates and `docker compose down`.

To update later: `git pull && docker compose up -d --build`.

### Open it

- On the same machine: `http://localhost:<APP_PORT>`.
- At home from other devices: set `APP_BIND=0.0.0.0` and `ORIGIN=http://<LAN IP>:<APP_PORT>` in `.env` (find the IP with `hostname -I` on Linux or `ipconfig getifaddr en0` on macOS), then `docker compose up -d`.
- Away from home: use a Cloudflare Tunnel, see below.

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Under _Household_ create an invitation link for everyone who shares your pantry; members share the pantry and grocery lists while recipes stay personal unless shared. Anyone with a valid invitation link can create an account even when sign-ups are closed, so set `REGISTRATION_OPEN=false` for a private install. Each person can change their own name and password under _Settings_.

### Reach it from anywhere with Cloudflare

Cloudflare Tunnel makes the app reachable over HTTPS without opening any port on your router. The `cloudflared` container runs next to the app and connects outbound to Cloudflare; nothing on the host is exposed except `127.0.0.1:<APP_PORT>`.

**Option A: try it in one minute (no account, no domain)**

1. In `.env` set `COMPOSE_PROFILES=quicktunnel` and `ORIGIN=` (empty).
2. `docker compose up -d`
3. `docker compose logs quicktunnel | grep trycloudflare` prints a `https://<random>.trycloudflare.com` URL. Open it.

The URL changes every time the tunnel restarts and Cloudflare gives no uptime promise for it, so use this for testing only. (`./deploy.sh --quick-tunnel` does the same and prints the URL.)

**Option B: your own domain (permanent)**

You need a free Cloudflare account with your domain added to it.

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → connector type _Cloudflared_. Give it a name (for example `my-kitchen`).
2. On the _Install connector_ step, copy the long token from the command Cloudflare shows (the part after `--token`). Skip the install instructions; Compose runs the connector for you.
3. Open the tunnel's **Public Hostname** tab → **Add a public hostname**:
   - Subdomain `kitchen`, domain `example.com` (whatever you like)
   - Service type **HTTP**, URL **`app:3000`** (this is the app container's name and internal port; it never changes, whatever `APP_PORT` is)
4. In `.env` set:
   ```sh
   COMPOSE_PROFILES=tunnel
   CLOUDFLARE_TUNNEL_TOKEN=<the token from step 2>
   ORIGIN=https://kitchen.example.com
   ```
5. `docker compose up -d`, then open `https://kitchen.example.com`. Cloudflare provides the certificate and DNS record automatically; the tunnel shows as _Healthy_ in the dashboard within a minute.

Equivalent one-liner: `./deploy.sh --tunnel-token <token> --origin https://kitchen.example.com`.

Optional hardening: in Zero Trust → **Access** → **Applications** you can put a Cloudflare login in front of the hostname so only your family's emails reach the sign-in page. Recommended cache rules and troubleshooting are in [docs/deployment.md](docs/deployment.md).

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
| `pnpm seed:perf`, `pnpm measure -- --base http://localhost:3003` | performance dataset and timings                           |

Create the test database once: `docker compose -f compose.dev.yaml -p my-kitchen-dev exec db psql -U recipe -d recipe_dev -c 'create database recipe_test'`, then `pnpm db:migrate:test`.

## Documentation

- [Deployment](docs/deployment.md) – all `deploy.sh` and `.env` options, Cloudflare setup and cache rules, updates, backup/restore, troubleshooting
- [Design decisions](docs/design-decisions.md) – ownership, grocery snapshots, transaction invariants, cache policy, deferred features
- [Measurements](docs/measurements.md) – dataset, query counts, payload sizes, latencies, verification runs
