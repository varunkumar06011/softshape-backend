/*
  Warnings:

  - You are about to alter the column `basePrice` on the `MenuItem` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(10,2)`.
  - The `menuType` column on the `MenuItem` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to alter the column `price` on the `MenuItemAddon` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(10,2)`.
  - You are about to alter the column `price` on the `MenuItemVariant` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(10,2)`.
  - You are about to alter the column `totalAmount` on the `Order` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(10,2)`.
  - You are about to alter the column `price` on the `OrderItem` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(10,2)`.
  - You are about to alter the column `currentBill` on the `Table` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(10,2)`.
  - A unique constraint covering the columns `[restaurantId,id]` on the table `Category` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,id]` on the table `MenuItem` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,id]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[slug]` on the table `Restaurant` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,id]` on the table `Section` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,id]` on the table `Table` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,email]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,id]` on the table `VenuePrice` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,id]` on the table `daily_inventory_snapshots` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,id]` on the table `inventory_items` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[restaurantId,id]` on the table `inventory_transactions` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `slug` to the `Restaurant` table without a default value. This is not possible if the table is not empty.
  - Made the column `restaurantCode` on table `Restaurant` required. This step will fail if there are existing NULL values in that column.
  - Changed the type of `role` on the `User` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `restaurantId` to the `VenuePrice` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'CASHIER', 'CAPTAIN', 'KITCHEN');

-- CreateEnum
CREATE TYPE "MenuType" AS ENUM ('FOOD', 'LIQUOR');

-- DropForeignKey
ALTER TABLE "MenuItemAddon" DROP CONSTRAINT "MenuItemAddon_menuItemId_fkey";

-- DropForeignKey
ALTER TABLE "MenuItemVariant" DROP CONSTRAINT "MenuItemVariant_menuItemId_fkey";

-- DropForeignKey
ALTER TABLE "Restaurant" DROP CONSTRAINT "Restaurant_parentRestaurantId_fkey";

-- DropIndex
DROP INDEX "Transaction_orderId_idx";

-- DropIndex
DROP INDEX "Transaction_restaurantId_paidAt_idx";

-- DropIndex
DROP INDEX "User_email_key";

-- AlterTable
ALTER TABLE "CaptainAssignment" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "printerTarget" TEXT;

-- AlterTable
ALTER TABLE "DailyCounter" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Employee" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "KitchenInventoryItem" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "MenuItem" ALTER COLUMN "basePrice" SET DATA TYPE DECIMAL(10,2),
DROP COLUMN "menuType",
ADD COLUMN     "menuType" "MenuType" NOT NULL DEFAULT 'FOOD';

-- AlterTable
ALTER TABLE "MenuItemAddon" ALTER COLUMN "price" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "MenuItemVariant" ALTER COLUMN "price" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "OnboardingPayment" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "menuType" "MenuType" NOT NULL DEFAULT 'FOOD',
ALTER COLUMN "price" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "PayrollRecord" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "gstCategory" TEXT NOT NULL DEFAULT 'NON_AC',
ADD COLUMN     "gstRate" DOUBLE PRECISION,
ADD COLUMN     "gstRegistered" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "halfBottleMl" INTEGER NOT NULL DEFAULT 375,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'starter',
ADD COLUMN     "slug" TEXT NOT NULL,
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "restaurantCode" SET NOT NULL,
ALTER COLUMN "deliveryPlatforms" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Table" ADD COLUMN     "lastWaiterCallAt" TIMESTAMP(3),
ALTER COLUMN "currentBill" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Transaction" ALTER COLUMN "items" SET DATA TYPE JSONB;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" "UserRole" NOT NULL,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "VenuePrice" ADD COLUMN     "restaurantId" TEXT NOT NULL,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'starter',
    "subscriptionId" TEXT,
    "billingStatus" TEXT NOT NULL DEFAULT 'trialing',
    "trialEndsAt" TIMESTAMP(3),
    "paymentStatus" TEXT NOT NULL DEFAULT 'LEGACY_EXEMPT',
    "features" JSONB,
    "enabledModules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutletAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "permissions" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutletAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutletAccess_userId_idx" ON "OutletAccess"("userId");

-- CreateIndex
CREATE INDEX "OutletAccess_outletId_idx" ON "OutletAccess"("outletId");

-- CreateIndex
CREATE UNIQUE INDEX "OutletAccess_userId_outletId_key" ON "OutletAccess"("userId", "outletId");

-- CreateIndex
CREATE INDEX "Category_restaurantId_isActive_sortOrder_idx" ON "Category"("restaurantId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Category_restaurantId_id_key" ON "Category"("restaurantId", "id");

-- CreateIndex
CREATE INDEX "MenuItem_restaurantId_isAvailable_isDeleted_idx" ON "MenuItem"("restaurantId", "isAvailable", "isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_restaurantId_id_key" ON "MenuItem"("restaurantId", "id");

-- CreateIndex
CREATE INDEX "Order_restaurantId_isDeleted_idx" ON "Order"("restaurantId", "isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "Order_restaurantId_id_key" ON "Order"("restaurantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Restaurant_slug_key" ON "Restaurant"("slug");

-- CreateIndex
CREATE INDEX "Restaurant_organizationId_idx" ON "Restaurant"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Section_restaurantId_id_key" ON "Section"("restaurantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Table_restaurantId_id_key" ON "Table"("restaurantId", "id");

-- CreateIndex
CREATE INDEX "Transaction_restaurantId_paidAt_idx" ON "Transaction"("restaurantId", "paidAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "User_restaurantId_email_key" ON "User"("restaurantId", "email");

-- CreateIndex
CREATE INDEX "VenuePrice_restaurantId_idx" ON "VenuePrice"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "VenuePrice_restaurantId_id_key" ON "VenuePrice"("restaurantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_inventory_snapshots_restaurantId_id_key" ON "daily_inventory_snapshots"("restaurantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_restaurantId_id_key" ON "inventory_items"("restaurantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transactions_restaurantId_id_key" ON "inventory_transactions"("restaurantId", "id");

-- AddForeignKey
ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_parentRestaurantId_fkey" FOREIGN KEY ("parentRestaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletAccess" ADD CONSTRAINT "OutletAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletAccess" ADD CONSTRAINT "OutletAccess_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemVariant" ADD CONSTRAINT "MenuItemVariant_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemAddon" ADD CONSTRAINT "MenuItemAddon_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenuePrice" ADD CONSTRAINT "VenuePrice_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenuePrice" ADD CONSTRAINT "VenuePrice_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
