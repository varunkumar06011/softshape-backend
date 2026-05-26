ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "txnDate" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "txnNumber" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "Transaction_restaurantId_txnDate_idx" ON "Transaction"("restaurantId", "txnDate");
