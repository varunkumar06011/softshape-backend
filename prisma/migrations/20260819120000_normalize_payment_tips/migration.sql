-- Normalize payment and tip allocations across all four payment methods
-- Additive only: new columns default to 0 so legacy rows remain readable.
-- Historical MIXED tip tender is intentionally NOT reconstructed; see plan.

-- Transaction: add UPI/Other bill portions and UPI/Other tip portions
-- (cash/card bill and cash/card tip columns already exist)
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "upiAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "otherAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "upiTipAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "otherTipAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- XReport: add UPI/Other tip split, mandatory tip payout tracking, payment
-- summary snapshot fields, source fingerprint, and report status state machine
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "upiTipsAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "otherTipsAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "tipsPaidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "tipsPaidConfirmedAt" TIMESTAMP(3);
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "tipsPaidConfirmedBy" TEXT;
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "cashExpenditures" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "expectedCash" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "sourceFingerprint" TEXT;
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "reportStatus" TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "reportVersion" INTEGER NOT NULL DEFAULT 1;

-- DailyBalanceSheet: snapshot payment summary fields so a saved/locked sheet
-- remains frozen and auditable
ALTER TABLE "DailyBalanceSheet" ADD COLUMN IF NOT EXISTS "cashCollected" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "DailyBalanceSheet" ADD COLUMN IF NOT EXISTS "cardCollected" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "DailyBalanceSheet" ADD COLUMN IF NOT EXISTS "upiCollected" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "DailyBalanceSheet" ADD COLUMN IF NOT EXISTS "otherCollected" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "DailyBalanceSheet" ADD COLUMN IF NOT EXISTS "totalTips" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "DailyBalanceSheet" ADD COLUMN IF NOT EXISTS "tipsPaidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "DailyBalanceSheet" ADD COLUMN IF NOT EXISTS "cashExpenditures" DECIMAL(10,2) NOT NULL DEFAULT 0;
