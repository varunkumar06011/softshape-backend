-- Add linkedPurchaseOrderPaymentId column to Voucher (Expenditure) table
-- This links expenditure entries to specific PurchaseOrderPayment records for dedup
ALTER TABLE "Voucher" ADD COLUMN IF NOT EXISTS "linkedPurchaseOrderPaymentId" TEXT;

-- Add foreign key constraint (idempotent)
DO $$ BEGIN
  ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_linkedPurchaseOrderPaymentId_fkey"
    FOREIGN KEY ("linkedPurchaseOrderPaymentId") REFERENCES "PurchaseOrderPayment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Add index for efficient dedup lookups
CREATE INDEX IF NOT EXISTS "Voucher_linkedPurchaseOrderPaymentId_idx" ON "Voucher"("linkedPurchaseOrderPaymentId");
