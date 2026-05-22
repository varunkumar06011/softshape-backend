#!/bin/sh
set -e
echo "[start] PORT=${PORT:-unset}"
if [ ! -f dist/index.js ]; then
  echo "[start] dist/index.js missing — running build..."
  npx prisma generate
  npm run build
fi
exec node dist/index.js
