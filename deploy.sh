#!/usr/bin/env bash
# Pantry & Plate — self-host in one command.
#
#   ./deploy.sh                                  local install on http://localhost:3000
#   ./deploy.sh --port 8080 --bind 0.0.0.0 --origin http://192.168.1.20:8080   LAN install
#   ./deploy.sh --quick-tunnel                   public try-out URL on *.trycloudflare.com (no account)
#   ./deploy.sh --tunnel-token TOKEN --origin https://pantry.example.com       your own domain
#   ./deploy.sh --cloud-db 'postgres://user:pass@host/db?sslmode=require'      managed PostgreSQL
#
# Run it again any time: it keeps your .env, applies the flags you pass, rebuilds and restarts.
# Remote bootstrap (needs git):  curl -fsSL <raw url of this file> | bash -s -- --port 8080
set -euo pipefail

PANTRY_REPO="${PANTRY_REPO:-https://github.com/YOUR-GITHUB-USER/recipe-saver.git}"
PORT="" BIND="" ORIGIN_ARG="" TOKEN="" QUICK=0 NO_TUNNEL=0 CLOUD_DB="" REGISTRATION="" DIR="" START=1 REBUILD=1

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
	case "$1" in
		--port) PORT="$2"; shift 2 ;;
		--bind) BIND="$2"; shift 2 ;;
		--origin) ORIGIN_ARG="$2"; shift 2 ;;
		--tunnel-token) TOKEN="$2"; shift 2 ;;
		--quick-tunnel) QUICK=1; shift ;;
		--no-tunnel) NO_TUNNEL=1; shift ;;
		--cloud-db) CLOUD_DB="$2"; shift 2 ;;
		--registration) REGISTRATION="$2"; shift 2 ;;
		--dir) DIR="$2"; shift 2 ;;
		--no-start) START=0; shift ;;
		--no-build) REBUILD=0; shift ;;
		-h|--help) usage 0 ;;
		*) echo "Unknown option: $1"; usage 1 ;;
	esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- bootstrap: not inside a checkout? clone one and re-run there -------------
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
if [ ! -f "$SELF_DIR/compose.yaml" ] || [ ! -f "$SELF_DIR/Dockerfile" ]; then
	command -v git >/dev/null || die "git is required to download Pantry & Plate"
	TARGET="${DIR:-pantry-and-plate}"
	if [ ! -d "$TARGET/.git" ]; then
		say "Downloading Pantry & Plate into ./$TARGET"
		git clone --depth 1 "$PANTRY_REPO" "$TARGET"
	fi
	cd "$TARGET"
	exec ./deploy.sh "$@" ${PORT:+--port "$PORT"} ${BIND:+--bind "$BIND"} ${ORIGIN_ARG:+--origin "$ORIGIN_ARG"} ${TOKEN:+--tunnel-token "$TOKEN"} $([ $QUICK = 1 ] && echo --quick-tunnel) $([ $NO_TUNNEL = 1 ] && echo --no-tunnel) ${CLOUD_DB:+--cloud-db "$CLOUD_DB"} ${REGISTRATION:+--registration "$REGISTRATION"} $([ $START = 0 ] && echo --no-start)
fi
cd "$SELF_DIR"

# --- prerequisites ------------------------------------------------------------
command -v docker >/dev/null || die "Docker is not installed. Install Docker Engine or Docker Desktop first: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose version)"
docker info >/dev/null 2>&1 || die "Docker daemon is not running (or you lack permission). Start Docker and try again."

# --- .env handling ------------------------------------------------------------
rand() { if command -v openssl >/dev/null; then openssl rand -base64 48 | tr -d '\n=/+' | cut -c1-48; else head -c 64 /dev/urandom | base64 | tr -d '\n=/+' | cut -c1-48; fi; }
set_env() { # set_env KEY VALUE  (replace or append, keeps other lines untouched)
	local key="$1" val="$2" tmp
	tmp="$(mktemp)"
	if grep -qE "^${key}=" .env; then
		awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k && !done {print k"="v; done=1; next} {print}' .env > "$tmp"
	else
		cat .env > "$tmp"; printf '%s=%s\n' "$key" "$val" >> "$tmp"
	fi
	mv "$tmp" .env
}
get_env() { grep -E "^$1=" .env | head -1 | cut -d= -f2- ; }

if [ ! -f .env ]; then
	say "Creating .env with generated secrets"
	cp .env.example .env
	set_env BETTER_AUTH_SECRET "$(rand)"
	set_env POSTGRES_PASSWORD "$(rand)"
fi
[ -n "$(get_env BETTER_AUTH_SECRET)" ] || set_env BETTER_AUTH_SECRET "$(rand)"
[ -n "$(get_env POSTGRES_PASSWORD)" ] && [ "$(get_env POSTGRES_PASSWORD)" != "change-me-to-a-long-random-password" ] || set_env POSTGRES_PASSWORD "$(rand)"

[ -n "$PORT" ] && set_env APP_PORT "$PORT"
[ -n "$BIND" ] && set_env APP_BIND "$BIND"
[ -n "$REGISTRATION" ] && set_env REGISTRATION_OPEN "$( [ "$REGISTRATION" = closed ] && echo false || echo true )"
PORT="$(get_env APP_PORT)"; PORT="${PORT:-3000}"
COMPOSE_FILE="compose.yaml"
if [ -n "$CLOUD_DB" ]; then
	set_env DATABASE_URL "$CLOUD_DB"
	COMPOSE_FILE="compose.cloud-db.yaml"
fi

# Tunnel profile
if [ -n "$TOKEN" ]; then
	set_env CLOUDFLARE_TUNNEL_TOKEN "$TOKEN"
	set_env COMPOSE_PROFILES tunnel
elif [ $QUICK = 1 ]; then
	set_env COMPOSE_PROFILES quicktunnel
elif [ $NO_TUNNEL = 1 ]; then
	set_env COMPOSE_PROFILES ""
fi
PROFILE="$(get_env COMPOSE_PROFILES)"
[ "$PROFILE" = tunnel ] && [ -z "$(get_env CLOUDFLARE_TUNNEL_TOKEN)" ] && die "COMPOSE_PROFILES=tunnel needs CLOUDFLARE_TUNNEL_TOKEN (pass --tunnel-token)"

# Origin: the URL users will type
if [ -n "$ORIGIN_ARG" ]; then
	set_env ORIGIN "${ORIGIN_ARG%/}"
elif [ "$PROFILE" = quicktunnel ]; then
	set_env ORIGIN ""
else
	CUR="$(get_env ORIGIN)"
	if [ -z "$CUR" ] || [ "$CUR" = "http://localhost:5173" ] || { [ -n "$PORT" ] && printf '%s' "$CUR" | grep -qE '^http://localhost:[0-9]+$' && [ "$CUR" != "http://localhost:$PORT" ]; }; then
		set_env ORIGIN "http://localhost:$PORT"
	fi
fi
ORIGIN_VAL="$(get_env ORIGIN)"
if [ "$PROFILE" = tunnel ] && ! printf '%s' "$ORIGIN_VAL" | grep -q '^https://'; then
	warn "With a named tunnel ORIGIN must be your public https URL (pass --origin https://pantry.example.com). Sign-in will fail until it matches."
fi

say "Configuration (.env)"
printf '   port %s on %s   origin %s   tunnel %s   database %s\n' "$PORT" "$(get_env APP_BIND)" "${ORIGIN_VAL:-<from request (quick tunnel)>}" "${PROFILE:-none}" "$( [ -n "$CLOUD_DB" ] && echo "cloud" || echo "bundled PostgreSQL" )"
[ $START = 1 ] || { say "Skipping start (--no-start). Launch with: docker compose -f $COMPOSE_FILE up -d --build"; exit 0; }

# --- launch -------------------------------------------------------------------
say "Starting: docker compose -f $COMPOSE_FILE up -d $( [ $REBUILD = 1 ] && echo --build )"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans $( [ $REBUILD = 1 ] && echo --build )

say "Waiting for the app to become ready"
for _ in $(seq 1 90); do
	if curl -fsS "http://127.0.0.1:$PORT/health?ready=1" >/dev/null 2>&1; then READY=1; break; fi
	if [ "$(docker compose -f "$COMPOSE_FILE" ps --status exited --services 2>/dev/null | grep -c '^migrate$')" = 1 ] && ! docker compose -f "$COMPOSE_FILE" logs migrate 2>/dev/null | grep -q 'migrate: done'; then
		docker compose -f "$COMPOSE_FILE" logs migrate | tail -20
		die "Database migration failed (see above). Fix the database settings in .env and run ./deploy.sh again."
	fi
	sleep 2
done
[ "${READY:-0}" = 1 ] || { docker compose -f "$COMPOSE_FILE" logs --tail 40 app; die "The app did not become healthy in time. Logs above; 'docker compose logs -f app' for more."; }

PUBLIC_URL="$ORIGIN_VAL"
if [ "$PROFILE" = quicktunnel ]; then
	say "Waiting for the Cloudflare quick tunnel URL"
	for _ in $(seq 1 45); do
		PUBLIC_URL="$(docker compose -f "$COMPOSE_FILE" logs quicktunnel 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
		[ -n "$PUBLIC_URL" ] && break
		sleep 2
	done
	[ -n "$PUBLIC_URL" ] || warn "No tunnel URL yet; check: docker compose logs -f quicktunnel"
fi

echo
say "Pantry & Plate is running"
echo "   Open:            ${PUBLIC_URL:-http://localhost:$PORT}"
[ "$PROFILE" = quicktunnel ] && echo "   (quick tunnel URLs change on every restart and are meant for trying things out)"
echo "   Create the first account at ${PUBLIC_URL:-http://localhost:$PORT}/register, then optionally run: ./deploy.sh --registration closed"
echo "   Logs:            docker compose -f $COMPOSE_FILE logs -f app"
echo "   Update:          git pull && ./deploy.sh"
echo "   Stop:            docker compose -f $COMPOSE_FILE down        (data stays in Docker volumes)"
echo "   Backup:          docs/deployment.md"
