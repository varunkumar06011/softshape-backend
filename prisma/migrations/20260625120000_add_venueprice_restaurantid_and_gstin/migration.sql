-- S3: Add restaurantId to VenuePrice for multi-tenancy scoping (idempotent)
ALTER TABLE "VenuePrice" ADD COLUMN IF NOT EXISTS "restaurantId" TEXT;

-- Add index on restaurantId (idempotent)
CREATE INDEX IF NOT EXISTS "VenuePrice_restaurantId_idx" ON "VenuePrice"("restaurantId");

-- Add foreign key constraint (nullable, set null on delete) — idempotent via DO block
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'VenuePrice_restaurantId_fkey'
  ) THEN
    ALTER TABLE "VenuePrice" ADD CONSTRAINT "VenuePrice_restaurantId_fkey"
      FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- S2: Set GSTIN on default tenant rows
UPDATE "Restaurant" SET "gstin" = '37AEXPT1195E1ZU'
  WHERE "gstin" IS NULL
  AND ("id" = 'bar-001' OR "slug" = 'bar-001');

UPDATE "Restaurant" SET "gstin" = '37AEXPT1195E1ZU'
  WHERE "gstin" IS NULL
  AND ("id" IN ('restaurant-001', 'venue-001') OR "slug" IN ('restaurant-001', 'venue-001'));
