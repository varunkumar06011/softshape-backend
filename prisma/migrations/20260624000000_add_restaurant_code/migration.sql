-- AddColumn (idempotent)
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "restaurantCode" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Restaurant_restaurantCode_key" ON "Restaurant"("restaurantCode");
