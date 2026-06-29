
#!/bin/sh
set -e
echo "[start] PORT=${PORT:-unset}"

echo "[start] Resolving any previously failed migrations..."
npx prisma migrate resolve --rolled-back "20260624000000_add_restaurant_code" 2>/dev/null || true
npx prisma migrate resolve --rolled-back "20260629000000_rename_price_per_unit_to_price" 2>/dev/null || true

echo "[start] Running prisma migrate deploy..."
npx prisma migrate deploy

if [ ! -f dist/index.js ]; then
  echo "[start] dist/index.js missing — running build..."
  npx prisma generate
  npx tsc
fi
exec node dist/index.js
