-- Add TransactionStatus enum and lifecycle audit columns to Transaction

-- Create the enum type
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED', 'FAILED', 'REFUNDED');

-- Add status column with default COMPLETED for existing rows
ALTER TABLE "Transaction" ADD COLUMN "status" "TransactionStatus" NOT NULL DEFAULT 'COMPLETED';

-- Add lifecycle audit columns
ALTER TABLE "Transaction" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "Transaction" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Transaction" ADD COLUMN "failedAt" TIMESTAMP(3);
ALTER TABLE "Transaction" ADD COLUMN "recoverySource" TEXT;

-- Add indexes for the new status filtering pattern
CREATE INDEX "Transaction_status_idx" ON "Transaction"("status");
CREATE INDEX "Transaction_restaurantId_status_txnDate_idx" ON "Transaction"("restaurantId", "status", "txnDate");
