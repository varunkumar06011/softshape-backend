-- Fix #22: Align MenuItemRecipe.quantity precision from Decimal(10,3) to Decimal(10,2)
ALTER TABLE "MenuItemRecipe" ALTER COLUMN "quantity" TYPE DECIMAL(10,2);

-- Fix #23: Add createdAt and updatedAt timestamps to InventoryDailyEntry
ALTER TABLE "InventoryDailyEntry" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "InventoryDailyEntry" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
