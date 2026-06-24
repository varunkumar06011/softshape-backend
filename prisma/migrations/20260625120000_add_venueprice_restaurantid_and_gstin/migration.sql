-- S3: Add restaurantId to VenuePrice for multi-tenancy scoping
ALTER TABLE "VenuePrice" ADD COLUMN "restaurantId" TEXT;

-- Add index on restaurantId
CREATE INDEX "VenuePrice_restaurantId_idx" ON "VenuePrice"("restaurantId");

-- Add foreign key constraint (nullable, set null on delete)
ALTER TABLE "VenuePrice" ADD CONSTRAINT "VenuePrice_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL;

-- S2: Set GSTIN on default tenant rows
-- The bar outlet GSTIN was hardcoded as '37AEXPT1195E1ZU' in the old code
UPDATE "Restaurant" SET "gstin" = '37AEXPT1195E1ZU'
  WHERE "gstin" IS NULL
  AND ("id" = 'bar-001' OR "slug" = 'bar-001');

-- Set a default GSTIN for the main restaurant and venue if they share the same GSTIN
UPDATE "Restaurant" SET "gstin" = '37AEXPT1195E1ZU'
  WHERE "gstin" IS NULL
  AND ("id" IN ('restaurant-001', 'venue-001') OR "slug" IN ('restaurant-001', 'venue-001'));
