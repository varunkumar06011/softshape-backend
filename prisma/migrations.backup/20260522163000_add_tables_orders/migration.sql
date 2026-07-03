-- Extend table status for the billing workflow.
ALTER TYPE "TableStatus" ADD VALUE IF NOT EXISTS 'BILLING_REQUESTED';

-- Convert legacy table labels such as "T12" to integer table numbers.
ALTER TABLE "Table"
ALTER COLUMN "number" TYPE INTEGER
USING COALESCE(NULLIF(regexp_replace("number"::TEXT, '\D', '', 'g'), '')::INTEGER, 0);

-- Add production indexes and tenant-safe uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS "Table_restaurantId_sectionId_number_key"
ON "Table"("restaurantId", "sectionId", "number");

CREATE INDEX IF NOT EXISTS "Table_restaurantId_status_idx"
ON "Table"("restaurantId", "status");

-- Create order workflow status.
DO $$ BEGIN
  CREATE TYPE "OrderStatus" AS ENUM (
    'PENDING',
    'CONFIRMED',
    'PREPARING',
    'READY',
    'BILLING_REQUESTED',
    'PAID',
    'CANCELLED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Order" (
  "id" TEXT NOT NULL,
  "tableId" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "billingRequested" BOOLEAN NOT NULL DEFAULT false,
  "billingRequestedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrderItem" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "price" DOUBLE PRECISION NOT NULL,
  "quantity" INTEGER NOT NULL,
  "notes" TEXT,

  CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Order"
  ADD CONSTRAINT "Order_tableId_fkey"
  FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "Order_restaurantId_status_idx"
ON "Order"("restaurantId", "status");

CREATE INDEX IF NOT EXISTS "Order_tableId_status_idx"
ON "Order"("tableId", "status");
