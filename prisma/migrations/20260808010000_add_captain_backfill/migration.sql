-- CreateCaptainBackfillTable
CREATE TABLE IF NOT EXISTS "CaptainBackfill" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "specialSoldCount" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,

    CONSTRAINT "CaptainBackfill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CaptainBackfill_restaurantId_userId_date_key" ON "CaptainBackfill"("restaurantId", "userId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CaptainBackfill_restaurantId_date_idx" ON "CaptainBackfill"("restaurantId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CaptainBackfill_userId_idx" ON "CaptainBackfill"("userId");

-- ============================================================
-- Seed: manual backfill for 2026-08-07
-- ============================================================
INSERT INTO "CaptainBackfill" ("id", "restaurantId", "userId", "date", "specialSoldCount", "revenue", "notes", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'cmr03m0fa00015ot8jh16grhn', 'cmr0xtglf001zgoshazu1x2qs', '2026-08-07', 28, 0, 'Manual backfill 2026-08-07', NOW(), NOW()),
  (gen_random_uuid(), 'cmr03m0fa00015ot8jh16grhn', 'cmr0bhb9p00125l56dck8chi6', '2026-08-07', 12, 0, 'Manual backfill 2026-08-07', NOW(), NOW()),
  (gen_random_uuid(), 'cmqy60ci200027dscyj9ubg8h', 'cmqy60f1v000e7dsc7md04vej', '2026-08-07', 16, 0, 'Manual backfill 2026-08-07', NOW(), NOW()),
  (gen_random_uuid(), 'cmqy60ci200027dscyj9ubg8h', 'cmqy60f25000i7dscghrwbp08', '2026-08-07', 7, 0, 'Manual backfill 2026-08-07', NOW(), NOW())
ON CONFLICT ("restaurantId", "userId", "date")
DO UPDATE SET
  "specialSoldCount" = EXCLUDED."specialSoldCount",
  "revenue" = EXCLUDED."revenue",
  "notes" = EXCLUDED."notes",
  "updatedAt" = NOW();
