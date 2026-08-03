-- Add upiAmount to Transaction table (mirrors cashAmount/cardAmount).
-- Used for Other/MIXED payment method splits so UPI can be a third splittable
-- component alongside cash and card. Routes to otherSales when zero of
-- cash/card/upi are populated. Null/legacy rows are treated as "UPI not selected".
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "upiAmount" DECIMAL(10,2) DEFAULT 0;
