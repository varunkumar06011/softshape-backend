-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "unitOfMeasure" TEXT NOT NULL,
    "bottleSize" INTEGER NOT NULL,
    "openingStock" DECIMAL(10,2) NOT NULL,
    "currentStock" DECIMAL(10,2) NOT NULL,
    "reorderLevel" DECIMAL(10,2) NOT NULL,
    "costPerBottle" DECIMAL(10,2),
    "lastRestocked" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transactions" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" TEXT NOT NULL,
    "quantityChange" DECIMAL(10,2) NOT NULL,
    "stockBefore" DECIMAL(10,2) NOT NULL,
    "stockAfter" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT,
    "transactionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_inventory_snapshots" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "openingStock" DECIMAL(10,2) NOT NULL,
    "purchased" DECIMAL(10,2) NOT NULL,
    "sold" DECIMAL(10,2) NOT NULL,
    "wastage" DECIMAL(10,2) NOT NULL,
    "adjusted" DECIMAL(10,2) NOT NULL,
    "closingStock" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_inventory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_menuItemId_key" ON "inventory_items"("menuItemId");

-- CreateIndex
CREATE INDEX "inventory_items_restaurantId_idx" ON "inventory_items"("restaurantId");

-- CreateIndex
CREATE INDEX "inventory_items_menuItemId_idx" ON "inventory_items"("menuItemId");

-- CreateIndex
CREATE INDEX "inventory_items_currentStock_idx" ON "inventory_items"("currentStock");

-- CreateIndex
CREATE INDEX "inventory_transactions_restaurantId_transactionDate_idx" ON "inventory_transactions"("restaurantId", "transactionDate");

-- CreateIndex
CREATE INDEX "inventory_transactions_itemId_idx" ON "inventory_transactions"("itemId");

-- CreateIndex
CREATE INDEX "inventory_transactions_orderId_idx" ON "inventory_transactions"("orderId");

-- CreateIndex
CREATE INDEX "inventory_transactions_type_idx" ON "inventory_transactions"("type");

-- CreateIndex
CREATE INDEX "daily_inventory_snapshots_restaurantId_snapshotDate_idx" ON "daily_inventory_snapshots"("restaurantId", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "daily_inventory_snapshots_restaurantId_snapshotDate_itemId_key" ON "daily_inventory_snapshots"("restaurantId", "snapshotDate", "itemId");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_inventory_snapshots" ADD CONSTRAINT "daily_inventory_snapshots_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
