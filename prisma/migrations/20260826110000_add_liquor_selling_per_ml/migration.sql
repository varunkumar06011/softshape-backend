-- Add AC/Non-AC Selling/ML override fields to InventoryItem.
-- These are optional — when null, the report derives selling/ML from
-- PriceProfileItem/Venue/TaxProfile or MenuItemVariant/BarItemMapping.

ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "acSellingPerMl" DECIMAL(10,2);
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "nonAcSellingPerMl" DECIMAL(10,2);
