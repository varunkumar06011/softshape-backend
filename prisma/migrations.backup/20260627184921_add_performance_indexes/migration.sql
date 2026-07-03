/*
  Warnings:

  - Added the required column `restaurantId` to the `MenuItemAddon` table without a default value. This is not possible if the table is not empty.
  - Added the required column `restaurantId` to the `MenuItemVariant` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Outlet" DROP CONSTRAINT "Outlet_organizationId_fkey";

-- DropIndex
DROP INDEX "Category_restaurantId_id_key";

-- DropIndex
DROP INDEX "Floor_restaurantId_id_key";

-- DropIndex
DROP INDEX "MenuItem_restaurantId_id_key";

-- DropIndex
DROP INDEX "Order_restaurantId_id_key";

-- DropIndex
DROP INDEX "PriceProfile_restaurantId_id_key";

-- DropIndex
DROP INDEX "Section_restaurantId_id_key";

-- DropIndex
DROP INDEX "Table_restaurantId_id_key";

-- DropIndex
DROP INDEX "TaxProfile_restaurantId_id_key";

-- DropIndex
DROP INDEX "Transaction_restaurantId_id_key";

-- DropIndex
DROP INDEX "User_outletId_id_key";

-- DropIndex
DROP INDEX "Venue_restaurantId_id_key";

-- DropIndex
DROP INDEX "VenuePrice_restaurantId_id_key";

-- DropIndex
DROP INDEX "daily_inventory_snapshots_restaurantId_id_key";

-- DropIndex
DROP INDEX "inventory_items_restaurantId_id_key";

-- DropIndex
DROP INDEX "inventory_transactions_restaurantId_id_key";

-- AlterTable
ALTER TABLE "MenuItemAddon" ADD COLUMN     "restaurantId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "MenuItemVariant" ADD COLUMN     "restaurantId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "MenuItemAddon_restaurantId_idx" ON "MenuItemAddon"("restaurantId");

-- CreateIndex
CREATE INDEX "MenuItemVariant_restaurantId_idx" ON "MenuItemVariant"("restaurantId");

-- CreateIndex
CREATE INDEX "Order_restaurantId_status_paidAt_idx" ON "Order"("restaurantId", "status", "paidAt" DESC);

-- CreateIndex
CREATE INDEX "OrderItem_orderId_removedFromBill_idx" ON "OrderItem"("orderId", "removedFromBill");

-- CreateIndex
CREATE INDEX "Section_restaurantId_idx" ON "Section"("restaurantId");

-- AddForeignKey
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
