#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
# start-npm.sh — run Graveklar DIRECTLY (no container), behind an external
# reverse proxy such as Nginx Proxy Manager. The app serves plain HTTP on
# :3000; the proxy terminates TLS and forwards to it.
#
# Use this from a systemd unit (ExecStart=/opt/graveklar/start-npm.sh) or by
# hand. Secrets come from the environment — set them via the systemd
# EnvironmentFile, an exported shell env, or a local .env.production file.
#
# Required env: DATABASE_URL, ADMIN_SESSION_SECRET, CRON_SECRET, ADMIN_PASSWORD
# See DEPLOYMENT.md §3 for how to generate them.
# ─────────────────────────────────────────────────────────────────────────
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# Optionally load secrets from a local env file (real environment wins).
if [ -f .env.production ]; then
  set -a; . ./.env.production; set +a
fi

export NODE_ENV=production
PORT="${PORT:-3000}"

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set (e.g. file:/var/lib/graveklar/custom.db)" >&2
  exit 1
fi
if [ -z "$ADMIN_SESSION_SECRET" ]; then
  echo "ERROR: ADMIN_SESSION_SECRET is not set (openssl rand -hex 32)" >&2
  exit 1
fi

echo "→ Graveklar (next start) on :$PORT"
echo "  DB: $DATABASE_URL"

# Apply non-destructive schema changes (idempotent no-op when in sync).
npx prisma db push --skip-generate

# Build only if there's no build yet — normally you build at deploy time, not
# on every restart. Force a rebuild with: rm -rf .next && ./start-npm.sh
if [ ! -d .next ]; then
  echo "  No .next build found — building…"
  npm run build
fi

exec npx next start -p "$PORT" -H 0.0.0.0
