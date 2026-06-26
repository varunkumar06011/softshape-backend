#!/bin/bash
set -e

# Run from the backend repo root (portable path)
cd "$(dirname "$0")/.."

# 1. Snapshot BEFORE any migration
npx ts-node scripts/snapshot_before_backfill.ts

# 2. Apply migrations (permissions + transaction backfill)
npx prisma migrate deploy

# 3. Regenerate client
npx prisma generate
