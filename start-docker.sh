#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
# start-docker.sh — build + run Graveklar in a container via docker compose.
# TLS is handled by your external reverse proxy (e.g. Nginx Proxy Manager)
# pointing at the published port 3000. The SQLite DB lives in the named
# volume `graveklar-db` (see docker-compose.yml), so it survives rebuilds.
#
# Before first run: edit docker-compose.yml and replace the
# `change-me-in-production` secrets (ADMIN_PASSWORD, ADMIN_SESSION_SECRET) and
# set CRON_SECRET. See DEPLOYMENT.md §3.
# ─────────────────────────────────────────────────────────────────────────
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed." >&2
  exit 1
fi

# Prefer Compose v2 (`docker compose`), fall back to legacy `docker-compose`.
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "ERROR: docker compose is not available." >&2
  exit 1
fi

echo "→ Building + starting Graveklar container (detached)…"
$COMPOSE up -d --build

echo "→ Container status:"
$COMPOSE ps
echo "Logs: $COMPOSE logs -f graveklar"
