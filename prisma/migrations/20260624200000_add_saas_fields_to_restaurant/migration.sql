-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "barUnitMl" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "billingStatus" TEXT NOT NULL DEFAULT 'trialing',
ADD COLUMN     "features" JSONB,
ADD COLUMN     "fullBottleMl" INTEGER NOT NULL DEFAULT 750,
ADD COLUMN     "printerConfig" JSONB,
ADD COLUMN     "receiptHeader" TEXT,
ADD COLUMN     "receiptSubHeader" TEXT,
ADD COLUMN     "subscriptionId" TEXT,
ADD COLUMN     "themePrimary" TEXT,
ADD COLUMN     "themeSecondary" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);
