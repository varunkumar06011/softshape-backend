FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/

RUN npm ci

COPY tsconfig.json ./
COPY src ./src/

RUN npx prisma generate && npm run build

ENV NODE_ENV=production
# Railway injects PORT at runtime (usually 8080). EXPOSE must match.
EXPOSE 8080

CMD ["node", "dist/index.js"]
