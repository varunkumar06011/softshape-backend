-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "entryType" TEXT NOT NULL DEFAULT 'EXPENSE',
ADD COLUMN     "isSettled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ledgerCategoryId" TEXT,
ADD COLUMN     "linkedPurchaseOrderId" TEXT,
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "settledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LedgerCategory" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entryType" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isAssetCategory" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LedgerCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpeningBalance" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "asOfDate" TEXT NOT NULL,
    "cashInHand" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "bankBalance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "openingEquity" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "isFinalized" BOOLEAN NOT NULL DEFAULT false,
    "finalizedById" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpeningBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpeningBalanceLine" (
    "id" TEXT NOT NULL,
    "openingBalanceId" TEXT NOT NULL,
    "lineType" TEXT NOT NULL,
    "refId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(10,2),
    "unitCost" DECIMAL(10,2),
    "amount" DECIMAL(10,2) NOT NULL,
    "ledgerCategoryId" TEXT,
    "originalDate" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpeningBalanceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "outstandingBalance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "orderDate" TEXT NOT NULL,
    "deliveredDate" TEXT,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "amountPaid" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit" TEXT,
    "unitCost" DECIMAL(10,2) NOT NULL,
    "lineTotal" DECIMAL(10,2) NOT NULL,
    "ledgerCategoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "kitchenInventoryItemId" TEXT,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderPayment" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "paymentDate" TEXT NOT NULL,
    "method" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyCogsEntry" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kitchenInventoryItemId" TEXT NOT NULL,
    "consumedQty" DECIMAL(10,2) NOT NULL,
    "unitCostAtConsumption" DECIMAL(10,2) NOT NULL,
    "cogsAmount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyCogsEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedAsset" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ledgerCategoryId" TEXT,
    "purchaseDate" TEXT NOT NULL,
    "purchaseCost" DECIMAL(10,2) NOT NULL,
    "usefulLifeMonths" INTEGER,
    "salvageValue" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "depreciationMethod" TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
    "serialNumber" TEXT,
    "currentBookValue" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "disposedDate" TEXT,
    "disposalNotes" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourcePurchaseOrderItemId" TEXT,
    "sourceOpeningBalanceLineId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepreciationEntry" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "fixedAssetId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "depreciationAmount" DECIMAL(10,2) NOT NULL,
    "bookValueAfter" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepreciationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Liability" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "liabilityType" TEXT NOT NULL,
    "ledgerCategoryId" TEXT,
    "principalAmount" DECIMAL(10,2) NOT NULL,
    "currentBalance" DECIMAL(10,2) NOT NULL,
    "interestRate" DECIMAL(5,2),
    "startDate" TEXT NOT NULL,
    "lender" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceOpeningBalanceLineId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Liability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiabilityPayment" (
    "id" TEXT NOT NULL,
    "liabilityId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "paymentDate" TEXT NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiabilityPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquityAdjustment" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "date" TEXT NOT NULL,
    "narration" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquityAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerCategory_restaurantId_idx" ON "LedgerCategory"("restaurantId");

-- CreateIndex
CREATE INDEX "LedgerCategory_restaurantId_entryType_isActive_idx" ON "LedgerCategory"("restaurantId", "entryType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerCategory_restaurantId_entryType_name_key" ON "LedgerCategory"("restaurantId", "entryType", "name");

-- CreateIndex
CREATE INDEX "OpeningBalance_restaurantId_idx" ON "OpeningBalance"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningBalance_restaurantId_key" ON "OpeningBalance"("restaurantId");

-- CreateIndex
CREATE INDEX "OpeningBalanceLine_openingBalanceId_idx" ON "OpeningBalanceLine"("openingBalanceId");

-- CreateIndex
CREATE INDEX "OpeningBalanceLine_lineType_idx" ON "OpeningBalanceLine"("lineType");

-- CreateIndex
CREATE INDEX "Vendor_restaurantId_name_idx" ON "Vendor"("restaurantId", "name");

-- CreateIndex
CREATE INDEX "Vendor_restaurantId_idx" ON "Vendor"("restaurantId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_restaurantId_status_idx" ON "PurchaseOrder"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_restaurantId_idx" ON "PurchaseOrder"("restaurantId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_vendorId_idx" ON "PurchaseOrder"("vendorId");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_purchaseOrderId_idx" ON "PurchaseOrderItem"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderPayment_purchaseOrderId_idx" ON "PurchaseOrderPayment"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "DailyCogsEntry_restaurantId_date_idx" ON "DailyCogsEntry"("restaurantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyCogsEntry_restaurantId_date_kitchenInventoryItemId_key" ON "DailyCogsEntry"("restaurantId", "date", "kitchenInventoryItemId");

-- CreateIndex
CREATE INDEX "FixedAsset_restaurantId_idx" ON "FixedAsset"("restaurantId");

-- CreateIndex
CREATE INDEX "FixedAsset_restaurantId_status_idx" ON "FixedAsset"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "DepreciationEntry_restaurantId_periodMonth_idx" ON "DepreciationEntry"("restaurantId", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "DepreciationEntry_fixedAssetId_periodMonth_key" ON "DepreciationEntry"("fixedAssetId", "periodMonth");

-- CreateIndex
CREATE INDEX "Liability_restaurantId_idx" ON "Liability"("restaurantId");

-- CreateIndex
CREATE INDEX "Liability_restaurantId_status_idx" ON "Liability"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "Liability_restaurantId_liabilityType_idx" ON "Liability"("restaurantId", "liabilityType");

-- CreateIndex
CREATE INDEX "LiabilityPayment_liabilityId_idx" ON "LiabilityPayment"("liabilityId");

-- CreateIndex
CREATE INDEX "LiabilityPayment_liabilityId_paymentDate_idx" ON "LiabilityPayment"("liabilityId", "paymentDate");

-- CreateIndex
CREATE INDEX "EquityAdjustment_restaurantId_idx" ON "EquityAdjustment"("restaurantId");

-- CreateIndex
CREATE INDEX "EquityAdjustment_restaurantId_direction_idx" ON "EquityAdjustment"("restaurantId", "direction");

-- CreateIndex
CREATE INDEX "EquityAdjustment_restaurantId_date_idx" ON "EquityAdjustment"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "Voucher_restaurantId_entryType_idx" ON "Voucher"("restaurantId", "entryType");

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_ledgerCategoryId_fkey" FOREIGN KEY ("ledgerCategoryId") REFERENCES "LedgerCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_linkedPurchaseOrderId_fkey" FOREIGN KEY ("linkedPurchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerCategory" ADD CONSTRAINT "LedgerCategory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalance" ADD CONSTRAINT "OpeningBalance_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalance" ADD CONSTRAINT "OpeningBalance_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalanceLine" ADD CONSTRAINT "OpeningBalanceLine_openingBalanceId_fkey" FOREIGN KEY ("openingBalanceId") REFERENCES "OpeningBalance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalanceLine" ADD CONSTRAINT "OpeningBalanceLine_ledgerCategoryId_fkey" FOREIGN KEY ("ledgerCategoryId") REFERENCES "LedgerCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_ledgerCategoryId_fkey" FOREIGN KEY ("ledgerCategoryId") REFERENCES "LedgerCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_kitchenInventoryItemId_fkey" FOREIGN KEY ("kitchenInventoryItemId") REFERENCES "KitchenInventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderPayment" ADD CONSTRAINT "PurchaseOrderPayment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderPayment" ADD CONSTRAINT "PurchaseOrderPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyCogsEntry" ADD CONSTRAINT "DailyCogsEntry_kitchenInventoryItemId_fkey" FOREIGN KEY ("kitchenInventoryItemId") REFERENCES "KitchenInventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_ledgerCategoryId_fkey" FOREIGN KEY ("ledgerCategoryId") REFERENCES "LedgerCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_sourcePurchaseOrderItemId_fkey" FOREIGN KEY ("sourcePurchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_sourceOpeningBalanceLineId_fkey" FOREIGN KEY ("sourceOpeningBalanceLineId") REFERENCES "OpeningBalanceLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepreciationEntry" ADD CONSTRAINT "DepreciationEntry_fixedAssetId_fkey" FOREIGN KEY ("fixedAssetId") REFERENCES "FixedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liability" ADD CONSTRAINT "Liability_ledgerCategoryId_fkey" FOREIGN KEY ("ledgerCategoryId") REFERENCES "LedgerCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liability" ADD CONSTRAINT "Liability_sourceOpeningBalanceLineId_fkey" FOREIGN KEY ("sourceOpeningBalanceLineId") REFERENCES "OpeningBalanceLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liability" ADD CONSTRAINT "Liability_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityPayment" ADD CONSTRAINT "LiabilityPayment_liabilityId_fkey" FOREIGN KEY ("liabilityId") REFERENCES "Liability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityPayment" ADD CONSTRAINT "LiabilityPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquityAdjustment" ADD CONSTRAINT "EquityAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

