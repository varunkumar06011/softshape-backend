-- AlterTable
ALTER TABLE "ProcessedRequest" ADD COLUMN IF NOT EXISTS "deviceId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcessedRequest_deviceId_restaurantId_idx" ON "ProcessedRequest"("deviceId", "restaurantId");
