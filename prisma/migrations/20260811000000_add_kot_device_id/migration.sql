-- Add deviceId column to Kot to distinguish which edge terminal created each KOT.
-- Enables multi-desktop outlets where two terminals independently produce KOT #1
-- on the same day. The deviceId is nullable so historical records (which predate
-- this column) remain valid — PostgreSQL treats NULL as distinct in unique
-- constraints, so existing rows do not collide with each other or with new rows.
ALTER TABLE "Kot" ADD COLUMN IF NOT EXISTS "deviceId" TEXT;

-- Replace the unique index: (restaurantId, kotNumber, counterDate)
-- -> (restaurantId, deviceId, kotNumber, counterDate)
DROP INDEX IF EXISTS "Kot_restaurantId_kotNumber_counterDate_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Kot_restaurantId_deviceId_kotNumber_counterDate_key"
  ON "Kot"("restaurantId", "deviceId", "kotNumber", "counterDate");
