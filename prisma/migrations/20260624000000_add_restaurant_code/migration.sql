-- AddColumn (idempotent)
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "restaurantCode" TEXT;
DO $$ BEGIN
  ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_restaurantCode_key" UNIQUE ("restaurantCode");
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
