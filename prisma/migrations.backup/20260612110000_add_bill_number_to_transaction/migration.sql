-- Migration: add_bill_number_to_transaction
-- Adds billNumber (nullable String) to Transaction so settlement can copy Order.billNumber.

ALTER TABLE "Transaction"
  ADD COLUMN IF NOT EXISTS "billNumber" TEXT;
