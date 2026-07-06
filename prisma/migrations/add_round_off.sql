-- Add roundOff column to Transaction table
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "roundOff" DECIMAL(10,2);
