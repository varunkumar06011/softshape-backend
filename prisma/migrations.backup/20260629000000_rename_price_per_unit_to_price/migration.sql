-- Add price column to KitchenInventoryItem.
-- (pricePerUnit was in schema but never migrated to DB, so this is a fresh ADD.)
ALTER TABLE "KitchenInventoryItem" ADD COLUMN IF NOT EXISTS "price" DECIMAL(10,2) NOT NULL DEFAULT 0;
