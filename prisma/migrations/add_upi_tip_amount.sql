-- Add upiTipAmount to Transaction table (mirrors cashTipAmount/cardTipAmount).
-- A UPI tip works like a card tip: money settles to the bank/UPI account, but the
-- cashier must pay the waiter out of the cash drawer, so cash on hand is lower.
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "upiTipAmount" DECIMAL(10,2) DEFAULT 0;

-- Add upiTipsAmount to XReport table (mirrors cashTipsAmount/cardTipsAmount)
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "upiTipsAmount" DECIMAL(10,2) DEFAULT 0;

-- Add upiAmount to Transaction table (mirrors cashAmount/cardAmount).
-- Used for Other/MIXED payment method splits so UPI can be a third splittable
-- component alongside cash and card. Routes to otherSales when zero of
-- cash/card/upi are populated. Null/legacy rows are treated as "UPI not selected".
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "upiAmount" DECIMAL(10,2) DEFAULT 0;
