#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# SoftShape AI — Database Backup Script
# ─────────────────────────────────────────────────────────────────────────────
# Creates a compressed PostgreSQL dump of the SoftShape database.
# Features:
#   - Timestamped filename with gzip compression
#   - Configurable retention policy (default: 7 daily, 4 weekly, 12 monthly)
#   - Optional S3 upload via AWS CLI
#   - Webhook notification on failure
#   - Integrity check (gzip -t) after dump
#
# Usage:
#   ./scripts/backup.sh                    # Daily backup (default)
#   ./scripts/backup.sh --weekly           # Weekly backup (kept longer)
#   ./scripts/backup.sh --monthly          # Monthly backup (kept longest)
#   BACKUP_RETENTION_DAILY=14 ./scripts/backup.sh  # Override retention
#
# Required env vars (read from .env or environment):
#   DATABASE_URL or DATABASE_BACKUP_URL  — PostgreSQL connection string
#
# Optional env vars:
#   BACKUP_DIR              — Local backup directory (default: ./backups)
#   BACKUP_RETENTION_DAILY  — Days to keep daily backups (default: 7)
#   BACKUP_RETENTION_WEEKLY — Weeks to keep weekly backups (default: 4)
#   BACKUP_RETENTION_MONTHLY— Months to keep monthly backups (default: 12)
#   S3_BACKUP_BUCKET        — S3 bucket name for offsite upload (optional)
#   S3_BACKUP_PREFIX        — S3 key prefix (default: backups/)
#   BACKUP_WEBHOOK_URL      — Slack-compatible webhook for failure alerts
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Load .env if present ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

# ── Configuration ────────────────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
RETENTION_DAILY="${BACKUP_RETENTION_DAILY:-7}"
RETENTION_WEEKLY="${BACKUP_RETENTION_WEEKLY:-4}"
RETENTION_MONTHLY="${BACKUP_RETENTION_MONTHLY:-12}"
S3_BUCKET="${S3_BACKUP_BUCKET:-}"
S3_PREFIX="${S3_BACKUP_PREFIX:-backups/}"
WEBHOOK_URL="${BACKUP_WEBHOOK_URL:-}"

# Determine backup type from argument
BACKUP_TYPE="daily"
if [ "${1:-}" = "--weekly" ]; then BACKUP_TYPE="weekly"; fi
if [ "${1:-}" = "--monthly" ]; then BACKUP_TYPE="monthly"; fi

# ── Resolve database URL ─────────────────────────────────────────────────────
DB_URL="${DATABASE_BACKUP_URL:-${DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
  echo "[backup] ERROR: DATABASE_URL or DATABASE_BACKUP_URL is not set"
  exit 1
fi

# ── Prepare ──────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME="softshape_${BACKUP_TYPE}_${TIMESTAMP}.sql.gz"
FILEPATH="$BACKUP_DIR/$FILENAME"
STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "[backup] Starting ${BACKUP_TYPE} backup at $STARTED_AT"
echo "[backup] Target: $FILEPATH"

# ── Helper: send failure notification ────────────────────────────────────────
send_failure_notification() {
  local reason="$1"
  local detail="$2"
  local msg="SoftShape Backup FAILED: ${reason} at ${STARTED_AT}"
  echo "[backup] NOTIFICATION: $msg"
  if [ -n "$WEBHOOK_URL" ]; then
    curl -s -X POST "$WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"text\": \"$msg\nDetail: $detail\"}" \
      || true
  fi
}

# ── Run pg_dump ──────────────────────────────────────────────────────────────
if ! pg_dump "$DB_URL" --no-owner --no-acl --format=custom | gzip > "$FILEPATH" 2>/tmp/backup_pgdump_err; then
  echo "[backup] ERROR: pg_dump failed"
  cat /tmp/backup_pgdump_err
  send_failure_notification "pg_dump failed" "$(cat /tmp/backup_pgdump_err)"
  exit 1
fi

FILE_SIZE=$(du -h "$FILEPATH" | cut -f1)
echo "[backup] Dump created: $FILENAME ($FILE_SIZE)"

# ── Integrity check ──────────────────────────────────────────────────────────
if ! gzip -t "$FILEPATH" 2>/dev/null; then
  echo "[backup] ERROR: Gzip integrity check failed — file is corrupt"
  send_failure_notification "Gzip integrity check failed" "$FILEPATH"
  exit 1
fi
echo "[backup] Integrity check passed"

# ── Upload to S3 (optional) ──────────────────────────────────────────────────
if [ -n "$S3_BUCKET" ]; then
  echo "[backup] Uploading to S3: s3://$S3_BUCKET/$S3_PREFIX$FILENAME"
  if aws s3 cp "$FILEPATH" "s3://$S3_BUCKET/$S3_PREFIX$FILENAME" --quiet 2>/tmp/backup_s3_err; then
    echo "[backup] S3 upload successful"
  else
    echo "[backup] WARNING: S3 upload failed (local backup still exists)"
    cat /tmp/backup_s3_err
  fi
fi

# ── Cleanup old backups ──────────────────────────────────────────────────────
cleanup_old_backups() {
  local prefix="$1"
  local keep_count="$2"
  local old_files
  old_files=$(ls -1t "$BACKUP_DIR"/softshape_${prefix}_*.sql.gz 2>/dev/null | tail -n +"$((keep_count + 1))")
  if [ -n "$old_files" ]; then
    echo "$old_files" | xargs rm -f
    echo "[backup] Cleaned up old ${prefix} backups (kept $keep_count)"
  fi
}

cleanup_old_backups "daily" "$RETENTION_DAILY"
if [ "$BACKUP_TYPE" = "weekly" ]; then
  cleanup_old_backups "weekly" "$RETENTION_WEEKLY"
fi
if [ "$BACKUP_TYPE" = "monthly" ]; then
  cleanup_old_backups "monthly" "$RETENTION_MONTHLY"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
FINISHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "[backup] Completed at $FINISHED_AT"
echo "[backup] File: $FILENAME ($FILE_SIZE)"
