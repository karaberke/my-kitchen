# Deployment guide

## The short version

```sh
git clone <repo> my-kitchen && cd my-kitchen && ./deploy.sh [options]
```

`deploy.sh` needs Docker with Compose v2 (and `git` for the remote bootstrap). It:

1. creates `.env` from `.env.example` with a generated `BETTER_AUTH_SECRET` and `POSTGRES_PASSWORD` (existing `.env` files are kept; only the flags you pass are changed),
2. writes your choices (`APP_PORT`, `APP_BIND`, `ORIGIN`, `COMPOSE_PROFILES`, `CLOUDFLARE_TUNNEL_TOKEN`, `DATABASE_URL`, `REGISTRATION_OPEN`),
3. runs `docker compose up -d --build`, waits for the health check and prints the URL.

| Option                                | Effect                                                    | `.env` key                                           |
| ------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `--port 8080`                         | host port the app is published on                         | `APP_PORT`                                           |
| `--bind 0.0.0.0`                      | publish on all interfaces instead of `127.0.0.1`          | `APP_BIND`                                           |
| `--origin https://pantry.example.com` | exact public URL users type                               | `ORIGIN`                                             |
| `--quick-tunnel`                      | Cloudflare quick tunnel, random `*.trycloudflare.com` URL | `COMPOSE_PROFILES=quicktunnel`, `ORIGIN=`            |
| `--tunnel-token TOKEN`                | named Cloudflare tunnel for your domain                   | `COMPOSE_PROFILES=tunnel`, `CLOUDFLARE_TUNNEL_TOKEN` |
| `--no-tunnel`                         | remove a tunnel profile                                   | `COMPOSE_PROFILES=`                                  |
| `--cloud-db URL`                      | managed PostgreSQL, uses `compose.cloud-db.yaml`          | `DATABASE_URL`                                       |
| `--registration open\|closed`         | allow self sign-up                                        | `REGISTRATION_OPEN`                                  |
| `--no-start` / `--no-build`           | only write `.env` / skip the image rebuild                | –                                                    |

Without `deploy.sh`: copy `.env.example` to `.env`, fill in the same keys, then `docker compose up -d --build`
(or `docker compose -f compose.cloud-db.yaml up -d --build`). Compose interpolates `${...}` values
from `.env` and activates the Cloudflare service from `COMPOSE_PROFILES`.

Services: `db` (persistent volume), `migrate` (one-shot, advisory-locked), `app` (Node on
`0.0.0.0:3000` inside the container, published on `APP_BIND:APP_PORT`), and one of
`cloudflared` (profile `tunnel`) or `quicktunnel` (profile `quicktunnel`). The launch command
starts these services only; it never creates Cloudflare, S3 or cloud-database resources.

## ORIGIN and how the app knows its URL

Form posts are protected by an origin check, so `ORIGIN` must be exactly what people type,
scheme and port included: `http://localhost:3000`, `http://192.168.1.20:8080`,
`https://pantry.example.com`. A mismatch shows up as 403 on sign-in.

`ORIGIN` may be empty **only** for the quick tunnel: the container entrypoint
(`scripts/start.mjs`) drops the empty variable and the app then trusts the origin of each
request as forwarded by cloudflared (`X-Forwarded-Proto` + `Host`). In that mode the app is
meant to be used through the tunnel URL, not via `http://localhost` (which would be treated
as https and fail the origin check).

Session cookies are marked `Secure` when `ORIGIN` starts with `https://`. Plain-http LAN installs
therefore work, but anyone on the network path can read the traffic; prefer a tunnel or TLS proxy
for anything beyond your own LAN.

## Cloudflare Tunnel

**Quick tunnel (try-out):** `./deploy.sh --quick-tunnel`. cloudflared prints a
`https://<random>.trycloudflare.com` hostname, which `deploy.sh` shows. No account, no DNS.
The hostname changes on every restart and Cloudflare offers no uptime guarantee for it.

**Named tunnel (your domain):**

1. Cloudflare dashboard → _Zero Trust → Networks → Tunnels → Create a tunnel_ (Cloudflared connector). Copy the token.
2. On the tunnel's _Public Hostname_ tab add your hostname (e.g. `pantry.example.com`) with service type **HTTP** and URL **`app:3000`**. The container joins the compose network and resolves `app` by name.
3. `./deploy.sh --tunnel-token <token> --origin https://pantry.example.com`

The app stays on `127.0.0.1:<port>` on the host; only the tunnel reaches it from outside.

## Update

```sh
git pull
docker compose up -d --build
```

Compose recreates `migrate` on every `up`, so newly committed migrations run even when a
previous migration container exited successfully. The migration runner waits for the
database, takes `pg_advisory_lock`, applies only unapplied files from `drizzle/`, and never
generates or pushes schema changes.

## Backup and restore

Volumes are not backups. Take logical dumps:

```sh
# backup (bundled db)
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > backup-$(date +%F).dump
# uploads (local storage backend)
docker run --rm -v my-kitchen_uploads:/data -v "$PWD":/backup alpine tar czf /backup/uploads-$(date +%F).tgz -C /data .
```

Restore into a **disposable** database first to prove the dump works:

```sh
docker compose exec -T db createdb -U "$POSTGRES_USER" restore_test
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d restore_test --no-owner < backup-YYYY-MM-DD.dump
docker compose exec -T db psql -U "$POSTGRES_USER" -d restore_test -c 'select count(*) from recipe'
docker compose exec -T db dropdb -U "$POSTGRES_USER" restore_test
```

To restore for real: stop `app`, drop and recreate the database, `pg_restore` into it,
restore the uploads archive into the volume, start `app`.
Moving to a cloud database is the same procedure with the new `DATABASE_URL`; changing the
URL alone does not move data.

## Cloudflare cache rules

Do **not** enable "Cache Everything". Create these rules (Caching → Cache Rules), in order:

| #   | When                                                                                                                   | Then                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | URI Path starts with `/_app/immutable/`                                                                                | Eligible for cache, Edge TTL: respect origin, Browser TTL: respect origin |
| 2   | URI Path starts with `/media/` **or** `/api/` **or** contains `/__data.json` **or** starts with `/recipes/export.json` | Bypass cache                                                              |
| 3   | (default)                                                                                                              | Bypass cache                                                              |

Set **Browser Cache TTL** to _Respect Existing Headers_. The origin already sends
`private, no-store` on every dynamic response, so a mistaken cache rule would still not
serve one user's data to another, but rule 2 keeps private media and data off the shared
cache entirely. `Vary: Cookie` is not relied on for isolation.

Verify from outside:

```sh
curl -sI https://pantry.example.com/recipes | grep -i -E 'cache-control|cf-cache-status'
# expect: cache-control: private, no-store   cf-cache-status: BYPASS (or DYNAMIC)
curl -sI https://pantry.example.com/_app/immutable/<hashed file> | grep -i -E 'cache-control|cf-cache-status'
# expect: public, max-age=31536000, immutable   cf-cache-status: HIT after the first request
```

## Notes on static files

- Hashed assets under `/_app/immutable/` are served by adapter-node's static handler with
  `public, max-age=31536000, immutable` and precompressed (`br`/`gzip`) variants.
- A request for a missing file under `/_app/immutable/` returns 404 with
  `public, max-age=0, must-revalidate`, never the one-year TTL.
- `robots.txt` is served by an app route with `public, max-age=600, must-revalidate`; the
  favicon is a hashed asset. Keep the `static/` directory for truly public files only;
  anything there bypasses the app's hooks and gets no explicit `Cache-Control`.

## DATABASE_SSL

`compose.cloud-db.yaml` defaults `DATABASE_SSL` to `require` when the variable is **unset**.
Set `DATABASE_SSL=` (empty) explicitly to connect without TLS (LAN database), or
`DATABASE_SSL=no-verify` to accept a self-signed certificate.

## Optional S3 images

Set `STORAGE_BACKEND=s3`, `S3_BUCKET`, `S3_REGION`, credentials and, for non-AWS providers,
`S3_ENDPOINT` and `S3_FORCE_PATH_STYLE=true`. The bucket must be private: the app streams
objects through its authenticated `/media` endpoint and never hands out object URLs.
Switching backend does not migrate existing files; copy them with the provider's tools.

## Troubleshooting

- **migrate exits non-zero** → `docker compose logs migrate`. Fix the database connection
  or the failing SQL, then `docker compose up -d` again; nothing else starts until it succeeds.
- **app restarts** → `docker compose logs app`; usually a missing `BETTER_AUTH_SECRET`,
  bad `ORIGIN`, or database unreachable. `/health?ready=1` returns 503 while the db is down.
- **Sign-in fails with CSRF/origin errors** → `ORIGIN` must exactly match the public URL
  (scheme + host). Cloudflare must forward `Host` unchanged (default for tunnels).
- **Uploads fail with 413** → raise `BODY_SIZE_LIMIT` (adapter-node) above `UPLOAD_MAX_BYTES`.
- **Tunnel shows "unhealthy"** → check the token and that the public hostname points to
  `http://app:3000`. `docker compose logs cloudflared`.
