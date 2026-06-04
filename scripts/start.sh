
#!/bin/sh
set -e
echo "[start] PORT=${PORT:-unset}"
echo "[start] Running prisma migrate deploy..."
npx prisma migrate deploy
if [ ! -f dist/index.js ]; then
  echo "[start] dist/index.js missing — running build..."
  npx prisma generate
  npx tsc
fi
exec node dist/index.js
