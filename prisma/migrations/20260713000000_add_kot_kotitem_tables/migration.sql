-- Create Kot table (idempotent — uses IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "Kot" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kotNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Kot_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint on (restaurantId, kotNumber)
CREATE UNIQUE INDEX IF NOT EXISTS "Kot_restaurantId_kotNumber_key" ON "Kot"("restaurantId", "kotNumber");

-- Create indexes
CREATE INDEX IF NOT EXISTS "Kot_restaurantId_tableId_idx" ON "Kot"("restaurantId", "tableId");
CREATE INDEX IF NOT EXISTS "Kot_restaurantId_orderId_idx" ON "Kot"("restaurantId", "orderId");
CREATE INDEX IF NOT EXISTS "Kot_tableId_idx" ON "Kot"("tableId");
CREATE INDEX IF NOT EXISTS "Kot_orderId_idx" ON "Kot"("orderId");

-- Add foreign key constraints (idempotent — wrapped in DO blocks)
DO $$ BEGIN ALTER TABLE "Kot" ADD CONSTRAINT "Kot_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "Kot" ADD CONSTRAINT "Kot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Create KotItem table (idempotent — uses IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "KotItem" (
    "id" TEXT NOT NULL,
    "kotId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KotItem_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX IF NOT EXISTS "KotItem_kotId_idx" ON "KotItem"("kotId");
CREATE INDEX IF NOT EXISTS "KotItem_orderItemId_idx" ON "KotItem"("orderItemId");
CREATE INDEX IF NOT EXISTS "KotItem_menuItemId_idx" ON "KotItem"("menuItemId");

-- Add foreign key constraints (idempotent — wrapped in DO blocks)
DO $$ BEGIN ALTER TABLE "KotItem" ADD CONSTRAINT "KotItem_kotId_fkey" FOREIGN KEY ("kotId") REFERENCES "Kot"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "KotItem" ADD CONSTRAINT "KotItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "KotItem" ADD CONSTRAINT "KotItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── OrderConflict table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OrderConflict" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "deviceId" TEXT,
    "cloudUpdatedAt" TIMESTAMP(3) NOT NULL,
    "edgeUpdatedAt" TIMESTAMP(3) NOT NULL,
    "cloudStatus" "OrderStatus" NOT NULL,
    "edgeStatus" "OrderStatus" NOT NULL,
    "cloudTotal" DECIMAL(10,2) NOT NULL,
    "edgeTotal" DECIMAL(10,2) NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderConflict_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrderConflict_restaurantId_resolution_idx" ON "OrderConflict"("restaurantId", "resolution");
CREATE INDEX IF NOT EXISTS "OrderConflict_orderId_idx" ON "OrderConflict"("orderId");

DO $$ BEGIN ALTER TABLE "OrderConflict" ADD CONSTRAINT "OrderConflict_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── Transaction: missing columns ──────────────────────────────────────────
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "roundOff" DECIMAL(10,2);
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "tipAmount" DECIMAL(10,2) DEFAULT 0;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "cashAmount" DECIMAL(10,2) DEFAULT 0;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "cardAmount" DECIMAL(10,2) DEFAULT 0;

-- ─── Order: missing columns ────────────────────────────────────────────────
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "captainId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "barInventoryDeducted" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "dayClosedAt" TIMESTAMP(3);

-- ─── Order: active-per-table index ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Order_tableId_status_active_idx" ON "Order"("tableId", "status") WHERE "status" IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'BILLING_REQUESTED');
