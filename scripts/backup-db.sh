#!/bin/sh
# Online SQLite backup of the Graveklar database.
#
# Uses `sqlite3 .backup` so the live app doesn't have to be stopped — SQLite
# serializes the backup against in-flight writes through the WAL. The output
# is gzipped and dropped into backups/graveklar-YYYYMMDD-HHMMSS.db.gz.
#
# Schedule from cron/systemd-timer on the host:
#   0 3 * * * cd /path/to/graveklar && scripts/backup-db.sh >> /var/log/graveklar-backup.log 2>&1
#
# Reads DATABASE_URL from the environment first, then .env, falling back to
# prisma/prisma/db/custom.db for legacy installs. RETENTION_DAYS controls
# how many days of backups to keep (default 30).

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"

# Resolve DB path from DATABASE_URL or .env or legacy fallback.
DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ] && [ -f "${PROJECT_DIR}/.env" ]; then
  DB_URL=$(grep -E '^DATABASE_URL=' "${PROJECT_DIR}/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi
DB_PATH="${DB_URL#file:}"
DB_PATH="${DB_PATH:-${PROJECT_DIR}/prisma/prisma/db/custom.db}"

# Make relative paths resolve against the project dir.
case "$DB_PATH" in
  /*) ;;
  *) DB_PATH="${PROJECT_DIR}/${DB_PATH}" ;;
esac

if [ ! -f "$DB_PATH" ]; then
  echo "❌ Database file not found at: $DB_PATH" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "❌ sqlite3 not installed (apt install sqlite3 / brew install sqlite)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%d-%H%M%S)
DEST="${BACKUP_DIR}/graveklar-${STAMP}.db"

sqlite3 "$DB_PATH" ".backup '$DEST'"
gzip -9 -f "$DEST"
DEST="${DEST}.gz"

SIZE=$(wc -c <"$DEST" | tr -d ' ')
echo "✅ Backup: $DEST ($SIZE bytes)"

# Prune old backups (find handles both ctime/mtime depending on platform;
# -mtime +N drops files older than N days).
find "$BACKUP_DIR" -name 'graveklar-*.db.gz' -mtime +"${RETENTION_DAYS}" -delete
