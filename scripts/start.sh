
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

echo "[start] Running prisma migrate deploy..."
DATABASE_URL="$MIGRATE_DATABASE_URL" DIRECT_URL="$MIGRATE_DATABASE_URL" npx prisma migrate deploy

if [ ! -f dist/index.js ]; then
  echo "[start] dist/index.js missing — running build..."
  npx prisma generate
  npx tsc
fi
exec node dist/index.js
