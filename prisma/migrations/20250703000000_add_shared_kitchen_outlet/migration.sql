-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN "sharedKitchenOutletId" TEXT;

-- CreateIndex
CREATE INDEX "Outlet_sharedKitchenOutletId_idx" ON "Outlet"("sharedKitchenOutletId");
