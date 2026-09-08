#!/bin/sh
# Restore a Graveklar SQLite backup.
#
# Usage:
#   scripts/restore-db.sh backups/graveklar-20260601-030000.db.gz [target/path.db]
#
# If TARGET is omitted, restores to a temp file and prints its path
# (useful for verifying a backup without touching production). To restore
# OVER the live database, pass the target explicitly — the script will
# refuse unless GRAVEKLAR_CONFIRM_OVERWRITE=YES.

set -e

SRC="${1:-}"
TGT="${2:-}"

if [ -z "$SRC" ]; then
  echo "Usage: $0 <backup.db.gz> [target.db]" >&2
  exit 2
fi

if [ ! -f "$SRC" ]; then
  echo "❌ Source backup not found: $SRC" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "❌ sqlite3 not installed" >&2
  exit 1
fi

TEMP_TARGET=false
if [ -z "$TGT" ]; then
  # mktemp creates the file already; mark it so the overwrite-safety check
  # below skips it (we want to put data in this temp path immediately).
  TGT=$(mktemp -t graveklar-restore.XXXXXX.db)
  TEMP_TARGET=true
  echo "🔁 Restoring to temp file: $TGT"
fi

# Safety: refuse to overwrite an existing target unless explicitly confirmed.
# Skipped when we just created the temp file ourselves.
if [ "$TEMP_TARGET" = false ] && [ -f "$TGT" ] && [ "${GRAVEKLAR_CONFIRM_OVERWRITE:-}" != "YES" ]; then
  echo "❌ Target exists: $TGT" >&2
  echo "   Set GRAVEKLAR_CONFIRM_OVERWRITE=YES to overwrite." >&2
  exit 1
fi

# Decompress + verify by opening in sqlite3.
TMP=$(mktemp -t graveklar-restore-stage.XXXXXX.db)
gunzip -c "$SRC" > "$TMP"

# Integrity check before placing at target.
RESULT=$(sqlite3 "$TMP" 'PRAGMA integrity_check;' | head -1)
if [ "$RESULT" != "ok" ]; then
  echo "❌ Restore failed integrity check: $RESULT" >&2
  rm -f "$TMP"
  exit 1
fi

mv "$TMP" "$TGT"
ROWS=$(sqlite3 "$TGT" 'SELECT COUNT(*) FROM Booking;' 2>/dev/null || echo "?")
echo "✅ Restored to $TGT (Booking rows: $ROWS)"
