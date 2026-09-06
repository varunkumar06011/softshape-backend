-- Bar Inventory Redesign — One Stock Pool, Append-Only Ledger, Historical Permanence
--
-- Adds 4 new tables (bar_inventory_items, bar_inventory_movements,
-- bar_daily_records, bar_inventory_edit_logs), links MenuItem directly to
-- BarInventoryItem, and repoints BarDeductionLog from the old InventoryItem
-- table to the new bar_inventory_items table.
--
-- The BarDeductionLog FK is added with NOT VALID so existing rows (which still
-- reference inventory_items) are not checked. After the data migration script
-- (Step 2) backfills bar_inventory_items and updates BarDeductionLog.inventoryItemId,
-- the constraint can be validated with:
--   ALTER TABLE "BarDeductionLog" VALIDATE CONSTRAINT "BarDeductionLog_inventoryItemId_fkey";

-- DropForeignKey (old: BarDeductionLog → inventory_items)
ALTER TABLE "BarDeductionLog" DROP CONSTRAINT "BarDeductionLog_inventoryItemId_fkey";

-- DropIndex (old unique: orderId + inventoryItemId)
DROP INDEX "BarDeductionLog_orderId_inventoryItemId_key";

-- AlterTable: add orderItemId to BarDeductionLog
ALTER TABLE "BarDeductionLog" ADD COLUMN "orderItemId" TEXT;

-- AlterTable: add barInventoryItemId + deductionMl to MenuItem
ALTER TABLE "MenuItem" ADD COLUMN "barInventoryItemId" TEXT,
ADD COLUMN "deductionMl" INTEGER;

-- CreateTable: bar_inventory_items
CREATE TABLE "bar_inventory_items" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "bottleSizeMl" INTEGER NOT NULL,
    "currentStockMl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reorderLevelBottles" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "purchaseRate" DECIMAL(10,2),
    "sellingPricePerMl" DECIMAL(10,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isHiddenFromReport" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bar_inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable: bar_inventory_movements
CREATE TABLE "bar_inventory_movements" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "movementType" TEXT NOT NULL,
    "quantityMl" DECIMAL(12,2) NOT NULL,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "unitCost" DECIMAL(10,2),
    "source" TEXT NOT NULL,
    "correctionForId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bar_inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable: bar_daily_records
CREATE TABLE "bar_daily_records" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "openingMl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "purchasedMl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "acSaleMl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "nonAcSaleMl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "wastageMl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "adjustmentMl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "systemClosingMl" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "physicalClosingMl" DECIMAL(12,2),
    "varianceMl" DECIMAL(12,2),
    "purchaseRate" DECIMAL(10,2),
    "stockValue" DECIMAL(10,2),
    "acRevenue" DECIMAL(12,2),
    "nonAcRevenue" DECIMAL(12,2),
    "totalRevenue" DECIMAL(12,2),
    "consumptionCost" DECIMAL(12,2),
    "profit" DECIMAL(12,2),
    "profitPercent" DECIMAL(10,2),
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bar_daily_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable: bar_inventory_edit_logs
CREATE TABLE "bar_inventory_edit_logs" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "oldValue" TEXT NOT NULL,
    "newValue" TEXT NOT NULL,
    "differenceMl" DECIMAL(12,2),
    "reason" TEXT,
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bar_inventory_edit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: bar_inventory_items
CREATE INDEX "bar_inventory_items_restaurantId_isActive_idx" ON "bar_inventory_items"("restaurantId", "isActive");
CREATE INDEX "bar_inventory_items_restaurantId_brand_idx" ON "bar_inventory_items"("restaurantId", "brand");
CREATE UNIQUE INDEX "bar_inventory_items_restaurantId_name_key" ON "bar_inventory_items"("restaurantId", "name");

-- CreateIndex: bar_inventory_movements
CREATE INDEX "bar_inventory_movements_restaurantId_date_idx" ON "bar_inventory_movements"("restaurantId", "date");
CREATE INDEX "bar_inventory_movements_itemId_date_idx" ON "bar_inventory_movements"("itemId", "date");
CREATE INDEX "bar_inventory_movements_movementType_idx" ON "bar_inventory_movements"("movementType");
CREATE INDEX "bar_inventory_movements_orderId_idx" ON "bar_inventory_movements"("orderId");
CREATE INDEX "bar_inventory_movements_correctionForId_idx" ON "bar_inventory_movements"("correctionForId");

-- CreateIndex: bar_daily_records
CREATE INDEX "bar_daily_records_restaurantId_date_idx" ON "bar_daily_records"("restaurantId", "date");
CREATE UNIQUE INDEX "bar_daily_records_restaurantId_date_itemId_key" ON "bar_daily_records"("restaurantId", "date", "itemId");

-- CreateIndex: bar_inventory_edit_logs
CREATE INDEX "bar_inventory_edit_logs_restaurantId_date_itemId_idx" ON "bar_inventory_edit_logs"("restaurantId", "date", "itemId");

-- CreateIndex: BarDeductionLog new unique (orderId + orderItemId + inventoryItemId)
CREATE UNIQUE INDEX "BarDeductionLog_orderId_orderItemId_inventoryItemId_key" ON "BarDeductionLog"("orderId", "orderItemId", "inventoryItemId");

-- AddForeignKey: MenuItem → bar_inventory_items
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_barInventoryItemId_fkey" FOREIGN KEY ("barInventoryItemId") REFERENCES "bar_inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: BarDeductionLog → bar_inventory_items (NOT VALID — existing rows still reference inventory_items)
-- After data migration backfills bar_inventory_items and updates BarDeductionLog.inventoryItemId,
-- run: ALTER TABLE "BarDeductionLog" VALIDATE CONSTRAINT "BarDeductionLog_inventoryItemId_fkey";
ALTER TABLE "BarDeductionLog" ADD CONSTRAINT "BarDeductionLog_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "bar_inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- AddForeignKey: bar_inventory_movements → bar_inventory_items
ALTER TABLE "bar_inventory_movements" ADD CONSTRAINT "bar_inventory_movements_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "bar_inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: bar_daily_records → bar_inventory_items
ALTER TABLE "bar_daily_records" ADD CONSTRAINT "bar_daily_records_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "bar_inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
