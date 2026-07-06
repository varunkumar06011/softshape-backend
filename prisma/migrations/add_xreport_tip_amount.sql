-- Add tipAmount column to XReport table
ALTER TABLE "XReport" ADD COLUMN IF NOT EXISTS "tipAmount" DECIMAL(10,2) DEFAULT 0;
