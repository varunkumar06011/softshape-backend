#!/bin/bash
# SoftShape AI - Database Restore Script
# Restores a compressed PostgreSQL backup created by backup.sh.
#
# Usage:
#   ./scripts/restore.sh <backup-file>
#   ./scripts/restore.sh backups/softshape_daily_20260628_020000.sql.gz
#
# Safety:
#   - Prompts for confirmation before overwriting data
#   - Creates a pre-restore backup automatically
#   - Uses --no-owner --no-acl for portable restore

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup-file>"
  echo "Available backups:"
  ls -1t "$ROOT_DIR"/backups/softshape_*.sql.gz 2>/dev/null | head -10 || echo "  (none found in backups/)"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: File not found: $BACKUP_FILE"
  exit 1
fi

DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ]; then
  echo "ERROR: DATABASE_URL is not set"
  exit 1
fi

echo "============================================"
echo "  SoftShape AI - Database Restore"
echo "============================================"
echo "  Backup file: $BACKUP_FILE"
echo "  Target DB:   $DB_URL"
echo "============================================"
echo ""
echo "WARNING: This will OVERWRITE all data in the target database."
read -p "Type 'CONFIRM' to proceed: " confirm
if [ "$confirm" != "CONFIRM" ]; then
  echo "Aborted."
  exit 0
fi

# Create pre-restore backup
PRE_RESTORE_FILE="$ROOT_DIR/backups/softshape_prerestore_$(date +%Y%m%d_%H%M%S).sql.gz"
mkdir -p "$ROOT_DIR/backups"
echo "[restore] Creating pre-restore backup: $PRE_RESTORE_FILE"
pg_dump "$DB_URL" --no-owner --no-acl --format=custom | gzip > "$PRE_RESTORE_FILE"

# Restore
echo "[restore] Decompressing and restoring..."
gunzip -c "$BACKUP_FILE" | pg_restore "$DB_URL" --no-owner --no-acl --clean --if-exists --jobs=4 2>&1 || {
  echo "[restore] pg_restore reported errors (this may be normal for --clean with missing objects)"
  echo "[restore] Pre-restore backup saved at: $PRE_RESTORE_FILE"
}

echo "[restore] Done. Pre-restore backup: $PRE_RESTORE_FILE"
echo "[restore] Verify the application is working correctly."
