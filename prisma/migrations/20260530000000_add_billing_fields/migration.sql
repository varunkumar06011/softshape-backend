-- AlterTable
ALTER TABLE "DailyCounter" ADD COLUMN "billCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "billNumber" TEXT,
ADD COLUMN "paidAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Table" ADD COLUMN "discount" DECIMAL(5,2);
