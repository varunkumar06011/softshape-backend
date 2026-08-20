-- Migration: add_inventory_archive_and_reversal_flags
-- Adds isActive/archivedAt to InventoryItem and KitchenInventoryItem (Critical #6)
-- and inventoryReversed to Order (Critical #1).
-- All columns are additive with safe defaults — no data loss.

-- InventoryItem (bar): archive support
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP;
CREATE INDEX IF NOT EXISTS "inventory_items_restaurantId_isActive_idx" ON "inventory_items"("restaurantId", "isActive");

-- KitchenInventoryItem: archive support
ALTER TABLE "KitchenInventoryItem" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "KitchenInventoryItem" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP;
CREATE INDEX IF NOT EXISTS "KitchenInventoryItem_restaurantId_isActive_idx" ON "KitchenInventoryItem"("restaurantId", "isActive");

-- Order: inventory reversal flag (Critical #1 — soft-void idempotency guard)
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "inventoryReversed" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "Order_restaurantId_inventoryReversed_idx" ON "Order"("restaurantId", "inventoryReversed");
