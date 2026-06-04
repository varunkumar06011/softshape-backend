-- Migration: fix_missing_venue_columns
-- Adds schema elements present in schema.prisma but missing from the database.
-- All statements use IF NOT EXISTS so this is safe to run repeatedly.

-- ---------------------------------------------------------------------------
-- Add sectionTag column to Table (used by venue feature)
-- ---------------------------------------------------------------------------
ALTER TABLE "Table"
  ADD COLUMN IF NOT EXISTS "sectionTag" TEXT;

-- ---------------------------------------------------------------------------
-- Add inventoryDeducted column to Order
-- ---------------------------------------------------------------------------
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "inventoryDeducted" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Create VenuePrice table (per-venue override prices for shared menu items)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "VenuePrice" (
  "id"        TEXT NOT NULL,
  "venueId"   TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "price"     DECIMAL(10, 2) NOT NULL,
  "isActive"  BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VenuePrice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VenuePrice_venueId_menuItemId_key" UNIQUE ("venueId", "menuItemId")
);

-- Indexes for VenuePrice
CREATE INDEX IF NOT EXISTS "VenuePrice_venueId_idx"
  ON "VenuePrice"("venueId");

CREATE INDEX IF NOT EXISTS "VenuePrice_menuItemId_idx"
  ON "VenuePrice"("menuItemId");
