CREATE TABLE IF NOT EXISTS "PrintQueue" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "eventId"      TEXT NOT NULL UNIQUE,
  "payload"      JSONB NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "printedAt"    TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "PrintQueue_restaurantId_status_idx" ON "PrintQueue"("restaurantId","status");
CREATE INDEX IF NOT EXISTS "PrintQueue_createdAt_idx"           ON "PrintQueue"("createdAt");
