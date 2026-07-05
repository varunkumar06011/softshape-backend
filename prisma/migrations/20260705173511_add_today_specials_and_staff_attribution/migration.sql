-- AddColumn: MenuItem today specials fields
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "isSpecial" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "specialChannel" TEXT;
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "specialActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "specialExpiresAt" TIMESTAMP(3);

-- AddColumn: Order createdByUserId for staff attribution
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Order_createdByUserId_idx" ON "Order"("createdByUserId");

-- AddColumn: Transaction createdByUserId for staff attribution
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Transaction_createdByUserId_idx" ON "Transaction"("createdByUserId");
