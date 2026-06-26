-- Add dashboard refinement fields: permissions, printer routing, platform, section isolation

-- User permissions
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "permissions" JSONB DEFAULT '{}';

-- MenuItem printer routing
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "printerTarget" TEXT;
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "printerName" TEXT;

-- Order platform
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "platform" TEXT DEFAULT 'DINE_IN';

-- Transaction section + platform
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "sectionId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "platform" TEXT;

-- Foreign key from Transaction.sectionId -> Section.id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Transaction_sectionId_fkey'
    AND table_name = 'Transaction'
  ) THEN
    ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_sectionId_fkey"
      FOREIGN KEY ("sectionId") REFERENCES "Section"(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Index for section-filtered transactions
CREATE INDEX IF NOT EXISTS "Transaction_restaurantId_sectionId_idx"
  ON "Transaction"("restaurantId", "sectionId");
