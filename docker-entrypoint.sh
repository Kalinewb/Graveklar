#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
# Safety guard:
# Do not bypass destructive-schema protection without a verified backup.
# A failed migration is recoverable; silent data loss is not.
#
# If you find yourself wanting to add --accept-data-loss back to the
# `prisma db push` line below, the right move is instead:
#   1. Run scripts/backup-db.sh and verify the backup file exists.
#   2. Apply the destructive change MANUALLY from a one-off shell.
#   3. Confirm the data shape matches expectations.
#   4. Restart the container — this script will then succeed without the
#      flag because the destructive change is already applied.
# ─────────────────────────────────────────────────────────────────────────

set -e

DB_PATH="${DATABASE_URL#file:}"

echo "🗄️  Database: $DATABASE_URL"

# Apply non-destructive schema changes only. Without --accept-data-loss,
# `prisma db push` refuses any change that would drop a column, drop a
# table, or otherwise lose data. That refusal is intentional: an
# accidental schema regression on a `git pull` + `docker compose restart`
# should fail the deploy, not silently delete production data.
#
# If a destructive change is genuinely needed (renaming a column, dropping
# a feature), the operator must run it manually, outside the container,
# after taking a backup. See scripts/backup-db.sh.
echo "🔄 Applying database schema..."
if ! node /app/node_modules/prisma/build/index.js db push \
  --schema=/app/prisma/schema.prisma \
  --skip-generate; then
  echo "❌ Schema apply failed — this usually means a destructive change is required."
  echo "   Run scripts/backup-db.sh first, then apply the change manually with"
  echo "   prisma db push --accept-data-loss from a one-off shell."
  exit 1
fi

echo "✅ Database ready"
echo "🚀 Starting Graveklar..."

# `next start` (non-standalone — see Dockerfile). PORT/HOSTNAME come from env.
exec node /app/node_modules/next/dist/bin/next start -p "${PORT:-3000}" -H "${HOSTNAME:-0.0.0.0}"
