-- Add category field to KitchenInventoryItem for grouping inventory by type/category
ALTER TABLE "KitchenInventoryItem" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT '';
