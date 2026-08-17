-- Add categoryId column to DailyPurchaseEntry table for purchase category tracking
ALTER TABLE "DailyPurchaseEntry" ADD COLUMN IF NOT EXISTS "categoryId" TEXT;

-- Add foreign key constraint (idempotent)
DO $$ BEGIN
  ALTER TABLE "DailyPurchaseEntry" ADD CONSTRAINT "DailyPurchaseEntry_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "LedgerCategory"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Add index for efficient category-based queries
CREATE INDEX IF NOT EXISTS "DailyPurchaseEntry_restaurantId_categoryId_idx"
  ON "DailyPurchaseEntry"("restaurantId", "categoryId");
