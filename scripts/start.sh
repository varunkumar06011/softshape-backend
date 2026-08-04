
#!/bin/sh
set -e
echo "[start] PORT=${PORT:-unset}"

# Prisma migrations must use a direct DB connection. Pooled connections (e.g.
# Supabase PgBouncer / pooler with pool_size: 25) exhaust their session limit
# during migrate deploy and fail with "max clients reached".
if [ -n "$DIRECT_URL" ]; then
  echo "[start] Using DIRECT_URL for migrations..."
  MIGRATE_DATABASE_URL="$DIRECT_URL"
else
  echo "[start] WARNING: DIRECT_URL is not set. Using DATABASE_URL for migrations."
  echo "[start]          If you see 'max clients reached', set DIRECT_URL to your direct DB URL."
  MIGRATE_DATABASE_URL="$DATABASE_URL"
fi

echo "[start] Resolving any previously failed migrations..."
DATABASE_URL="$MIGRATE_DATABASE_URL" DIRECT_URL="$MIGRATE_DATABASE_URL" npx prisma migrate resolve --rolled-back "20260624000000_add_restaurant_code" 2>/dev/null || true
DATABASE_URL="$MIGRATE_DATABASE_URL" DIRECT_URL="$MIGRATE_DATABASE_URL" npx prisma migrate resolve --rolled-back "20260629000000_rename_price_per_unit_to_price" 2>/dev/null || true
DATABASE_URL="$MIGRATE_DATABASE_URL" DIRECT_URL="$MIGRATE_DATABASE_URL" npx prisma migrate resolve --rolled-back "20260710160000_add_order_active_per_table_index" 2>/dev/null || true
DATABASE_URL="$MIGRATE_DATABASE_URL" DIRECT_URL="$MIGRATE_DATABASE_URL" npx prisma migrate resolve --rolled-back "20260711023000_add_all_pending_schema_changes" 2>/dev/null || true

# Clean up duplicate active orders for the same table before creating the unique index.
# The migration 20260710160000_add_order_active_per_table_index creates a partial unique
# index on Order.tableId for active statuses. If duplicate active orders exist, the index
# creation fails with error 23505. This psql command marks older duplicates as CANCELLED.
echo "[start] Cleaning up duplicate active orders..."
psql "$MIGRATE_DATABASE_URL" -c "
UPDATE \"Order\" SET status = 'CANCELLED', \"updatedAt\" = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY \"tableId\"
      ORDER BY \"updatedAt\" DESC
    ) AS rn
    FROM \"Order\"
    WHERE status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'BILLING_REQUESTED')
      AND \"isDeleted\" = false
  ) ranked WHERE rn > 1
);
" 2>/dev/null || echo "[start] Duplicate cleanup skipped (psql not available or no duplicates)"

echo "[start] Running prisma migrate deploy..."
DATABASE_URL="$MIGRATE_DATABASE_URL" DIRECT_URL="$MIGRATE_DATABASE_URL" npx prisma migrate deploy || {
  echo "[start] WARNING: prisma migrate deploy failed — continuing anyway."
  echo "[start] Schema probes will detect any missing tables/columns at runtime."
}

if [ ! -f dist/index.js ]; then
  echo "[start] dist/index.js missing — running build..."
  npx prisma generate
  npx tsc
fi
exec node dist/index.js
