-- Add tipAmount column to Transaction table
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "tipAmount" DECIMAL(10,2) DEFAULT 0;
