-- CreateTable: OrderDeductionLog for idempotent per-ingredient settlement deductions
CREATE TABLE "OrderDeductionLog" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "quantity" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDeductionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderDeductionLog_orderId_ingredientId_key" ON "OrderDeductionLog"("orderId", "ingredientId");
CREATE INDEX "OrderDeductionLog_orderId_idx" ON "OrderDeductionLog"("orderId");
CREATE INDEX "OrderDeductionLog_restaurantId_idx" ON "OrderDeductionLog"("restaurantId");
CREATE INDEX "OrderDeductionLog_restaurantId_status_idx" ON "OrderDeductionLog"("restaurantId", "status");

-- AddForeignKey
ALTER TABLE "OrderDeductionLog" ADD CONSTRAINT "OrderDeductionLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE;
ALTER TABLE "OrderDeductionLog" ADD CONSTRAINT "OrderDeductionLog_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "KitchenInventoryItem"("id") ON DELETE CASCADE;
