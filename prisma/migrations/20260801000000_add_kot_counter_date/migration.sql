-- Add counterDate column to Kot for date-scoped KOT numbering.
-- Allows KOT numbers to restart at 1 each IST business day without colliding
-- with previous days' KOTs.

-- 1. Add column as nullable so existing rows can be backfilled.
ALTER TABLE "Kot" ADD COLUMN "counterDate" TEXT;

-- 2. Backfill from createdAt (stored as UTC timestamp) converted to IST date.
--    createdAt is timestamp(3) without timezone; interpret as UTC then shift
--    to Asia/Kolkata (UTC+5:30) and format as YYYY-MM-DD.
UPDATE "Kot"
SET "counterDate" = to_char(
  ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'),
  'YYYY-MM-DD'
)
WHERE "counterDate" IS NULL;

-- 3. Set NOT NULL after backfill.
ALTER TABLE "Kot" ALTER COLUMN "counterDate" SET NOT NULL;

-- 4. Replace the unique index: (restaurantId, kotNumber) -> (restaurantId, kotNumber, counterDate)
DROP INDEX IF EXISTS "Kot_restaurantId_kotNumber_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Kot_restaurantId_kotNumber_counterDate_key"
  ON "Kot"("restaurantId", "kotNumber", "counterDate");
