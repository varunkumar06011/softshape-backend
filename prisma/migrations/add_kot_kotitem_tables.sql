-- Create Kot table
CREATE TABLE "Kot" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kotNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Kot_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint on (restaurantId, kotNumber)
CREATE UNIQUE INDEX "Kot_restaurantId_kotNumber_key" ON "Kot"("restaurantId", "kotNumber");

-- Create indexes
CREATE INDEX "Kot_restaurantId_tableId_idx" ON "Kot"("restaurantId", "tableId");
CREATE INDEX "Kot_restaurantId_orderId_idx" ON "Kot"("restaurantId", "orderId");
CREATE INDEX "Kot_tableId_idx" ON "Kot"("tableId");
CREATE INDEX "Kot_orderId_idx" ON "Kot"("orderId");

-- Add foreign key constraints
ALTER TABLE "Kot" ADD CONSTRAINT "Kot_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE;
ALTER TABLE "Kot" ADD CONSTRAINT "Kot_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE;

-- Create KotItem table
CREATE TABLE "KotItem" (
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
CREATE INDEX "KotItem_kotId_idx" ON "KotItem"("kotId");
CREATE INDEX "KotItem_orderItemId_idx" ON "KotItem"("orderItemId");
CREATE INDEX "KotItem_menuItemId_idx" ON "KotItem"("menuItemId");

-- Add foreign key constraints
ALTER TABLE "KotItem" ADD CONSTRAINT "KotItem_kotId_fkey"
    FOREIGN KEY ("kotId") REFERENCES "Kot"("id") ON DELETE CASCADE;
ALTER TABLE "KotItem" ADD CONSTRAINT "KotItem_orderItemId_fkey"
    FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE;
