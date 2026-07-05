-- CreateTable
CREATE TABLE "DailyBalanceSheet" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "reportDate" TEXT NOT NULL,
    "openingBalance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "acBarSaleComputed" DECIMAL(10,2),
    "acBarSaleOverride" DECIMAL(10,2),
    "nonAcBarSaleComputed" DECIMAL(10,2),
    "nonAcBarSaleOverride" DECIMAL(10,2),
    "familyWingSaleComputed" DECIMAL(10,2),
    "familyWingSaleOverride" DECIMAL(10,2),
    "parcelSaleComputed" DECIMAL(10,2),
    "parcelSaleOverride" DECIMAL(10,2),
    "swiggySale" DECIMAL(10,2),
    "zomatoSale" DECIMAL(10,2),
    "totalVouchers" DECIMAL(10,2),
    "closingBalance" DECIMAL(10,2),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyBalanceSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BalanceAdjustment" (
    "id" TEXT NOT NULL,
    "dailyBalanceSheetId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "sign" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BalanceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyBalanceSheet_restaurantId_reportDate_idx" ON "DailyBalanceSheet"("restaurantId", "reportDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyBalanceSheet_restaurantId_reportDate_key" ON "DailyBalanceSheet"("restaurantId", "reportDate");

-- CreateIndex
CREATE INDEX "BalanceAdjustment_dailyBalanceSheetId_idx" ON "BalanceAdjustment"("dailyBalanceSheetId");

-- AddForeignKey
ALTER TABLE "BalanceAdjustment" ADD CONSTRAINT "BalanceAdjustment_dailyBalanceSheetId_fkey" FOREIGN KEY ("dailyBalanceSheetId") REFERENCES "DailyBalanceSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
