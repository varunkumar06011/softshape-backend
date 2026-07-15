-- Add cashTipAmount and cardTipAmount to Transaction table
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "cashTipAmount" DECIMAL(10,2) DEFAULT 0;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "cardTipAmount" DECIMAL(10,2) DEFAULT 0;

-- Add cashTipsAmount and cardTipsAmount to XReport table
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "cashTipsAmount" DECIMAL(10,2) DEFAULT 0;
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "cardTipsAmount" DECIMAL(10,2) DEFAULT 0;
