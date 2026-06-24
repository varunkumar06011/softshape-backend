-- Add restaurantType, outletCount, parentRestaurantId to Restaurant (idempotent)
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "restaurantType" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "outletCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "parentRestaurantId" TEXT;

-- Add index on parentRestaurantId (idempotent)
CREATE INDEX IF NOT EXISTS "Restaurant_parentRestaurantId_idx" ON "Restaurant"("parentRestaurantId");

-- Add foreign key constraint for parentRestaurantId (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Restaurant_parentRestaurantId_fkey'
  ) THEN
    ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_parentRestaurantId_fkey"
      FOREIGN KEY ("parentRestaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Backfill: set outletCount for legacy default tenant (restaurant + bar + venue = 3 outlets)
UPDATE "Restaurant" SET "outletCount" = 3
  WHERE "outletCount" = 1
  AND ("restaurantCode" = 'RESTAURANT-001' OR "slug" = 'restaurant-001');

-- Backfill: set restaurantType for existing restaurants
UPDATE "Restaurant" SET "restaurantType" = 'DINE_IN'
  WHERE "restaurantType" IS NULL
  AND ("slug" = 'restaurant-001' OR "slug" = 'venue-001');

UPDATE "Restaurant" SET "restaurantType" = 'BAR_LOUNGE'
  WHERE "restaurantType" IS NULL
  AND "slug" = 'bar-001';
