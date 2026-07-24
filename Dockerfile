# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — Container image build for the Softshape backend API
# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage Docker build for Railway/Render deployment:
#   - Base: node:20-slim with OpenSSL (for Prisma)
#   - Installs dependencies (npm ci)
#   - Copies source, Prisma schema, scripts, and menu data
#   - Builds TypeScript (tsc) and generates Prisma client
#   - Runtime: starts via scripts/start.sh (prisma migrate + node)
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl ca-certificates postgresql-client curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/
# Copy local workspace packages so file: dependencies (e.g. @softshape/output) resolve during npm ci
COPY packages ./packages/

RUN npm ci

# Build the local @softshape/output package (file: dependency — npm ci doesn't
# reliably run its prepare script, so compile dist/ explicitly).
RUN ./node_modules/.bin/tsc -p packages/output/tsconfig.json

COPY tsconfig.json ./
COPY src ./src/
COPY scripts ./scripts/
COPY docs ./docs/
# Copy menu data so auto-seed can find it at runtime
COPY vgrandmenu.txt ./vgrandmenu.txt

RUN npx prisma generate && npm run build

ENV NODE_ENV=production
# Railway injects PORT at runtime (usually 8080). EXPOSE must match.
EXPOSE 8080

# Run DB migrations then start server
CMD ["sh", "scripts/start.sh"]
