-- CreateTable: XReport
CREATE TABLE "XReport" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "reportDate" TEXT NOT NULL,
    "totalSales" DECIMAL(10,2) NOT NULL,
    "voucherAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "cardAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "cashAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes500" INTEGER NOT NULL DEFAULT 0,
    "notes200" INTEGER NOT NULL DEFAULT 0,
    "notes100" INTEGER NOT NULL DEFAULT 0,
    "notes50" INTEGER NOT NULL DEFAULT 0,
    "notes20" INTEGER NOT NULL DEFAULT 0,
    "notes10" INTEGER NOT NULL DEFAULT 0,
    "cashFromNotes" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "printed" BOOLEAN NOT NULL DEFAULT false,
    "printedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "XReport_restaurantId_reportDate_key" ON "XReport"("restaurantId", "reportDate");

-- CreateIndex
CREATE INDEX "XReport_restaurantId_reportDate_idx" ON "XReport"("restaurantId", "reportDate");

-- AddColumn: Employee designation and workerCategory
ALTER TABLE "Employee" ADD COLUMN "designation" TEXT;
ALTER TABLE "Employee" ADD COLUMN "workerCategory" TEXT;
