# Deployment guide

## Prerequisites

- Docker Engine 24+ with Compose v2 (`docker compose version`), BuildKit enabled (default).
- A domain on Cloudflare and a Cloudflare Tunnel (Zero Trust → Networks → Tunnels).
- Optional: a private S3 bucket, or a managed PostgreSQL.

The launch command starts the configured services only. It never creates Cloudflare,
S3 or cloud-database resources.

## One-time configuration

1. `cp .env.example .env`
2. Set at least:
   - `POSTGRES_PASSWORD` (bundled db) or `DATABASE_URL` + `DATABASE_SSL=require` (cloud db)
   - `ORIGIN=https://pantry.example.com` (the public hostname, https)
   - `BETTER_AUTH_SECRET` (`openssl rand -base64 48`)
   - `CLOUDFLARE_TUNNEL_TOKEN` (from the tunnel's _Configure_ page)
   - `REGISTRATION_OPEN=true` for the first accounts, then `false` for a private install
3. Create the tunnel in the Cloudflare dashboard and add a **public hostname** that routes
   `pantry.example.com` → `http://app:3000` (service type HTTP, URL `app:3000`).
   The `cloudflared` container joins the compose network and resolves `app` by name.

Compose interpolates `${...}` values from the `.env` file in the project directory (the
same file `pnpm dev` and the scripts read). Keep production values there on the server, or
pass another file with `docker compose --env-file prod.env ...`. `ORIGIN` must be the URL
users type; a mismatch makes every form post fail the CSRF origin check with 403.

## Launch

```sh
docker compose up -d --build            # bundled PostgreSQL
docker compose -f compose.cloud-db.yaml up -d --build   # managed PostgreSQL
```

Order: `db` becomes healthy → `migrate` runs committed migrations (advisory-locked, exits) →
`app` starts → `cloudflared` connects. `docker compose ps` shows `migrate` as _exited (0)_.

`docker compose logs -f app` shows the Node server; `curl` inside the network:
`docker compose exec app curl -s localhost:3000/health?ready=1`.

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
docker run --rm -v pantry-and-plate_uploads:/data -v "$PWD":/backup alpine tar czf /backup/uploads-$(date +%F).tgz -C /data .
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
