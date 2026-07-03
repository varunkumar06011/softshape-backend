/*
  Warnings:

  - You are about to drop the column `restaurantId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `Restaurant` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[outletId,email]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[outletId,id]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `outletId` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "OutletAccess" DROP CONSTRAINT "OutletAccess_outletId_fkey";

-- DropForeignKey
ALTER TABLE "Restaurant" DROP CONSTRAINT "Restaurant_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Restaurant" DROP CONSTRAINT "Restaurant_parentRestaurantId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_restaurantId_fkey";

-- DropForeignKey
ALTER TABLE "Venue" DROP CONSTRAINT "Venue_restaurantId_fkey";

-- DropForeignKey
ALTER TABLE "VenuePrice" DROP CONSTRAINT "VenuePrice_restaurantId_fkey";

-- DropIndex
DROP INDEX "User_restaurantId_email_key";

-- DropIndex
DROP INDEX "User_restaurantId_id_key";

-- DropIndex
DROP INDEX "User_restaurantId_idx";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "restaurantId",
ADD COLUMN     "outletId" TEXT NOT NULL;

-- DropTable
DROP TABLE "Restaurant";

-- CreateTable
CREATE TABLE "Outlet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "restaurantCode" TEXT NOT NULL,
    "restaurantType" TEXT,
    "outletCount" INTEGER NOT NULL DEFAULT 1,
    "parentRestaurantId" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "logoUrl" TEXT,
    "receiptHeader" TEXT,
    "receiptSubHeader" TEXT,
    "themePrimary" TEXT,
    "themeSecondary" TEXT,
    "printerConfig" JSONB,
    "barUnitMl" INTEGER NOT NULL DEFAULT 30,
    "fullBottleMl" INTEGER NOT NULL DEFAULT 750,
    "halfBottleMl" INTEGER NOT NULL DEFAULT 375,
    "fssai" TEXT,
    "pricesIncludeGst" BOOLEAN NOT NULL DEFAULT false,
    "gstCategory" TEXT NOT NULL DEFAULT 'NON_AC',
    "gstRate" DOUBLE PRECISION,
    "gstRegistered" BOOLEAN NOT NULL DEFAULT true,
    "serviceChargePercent" INTEGER NOT NULL DEFAULT 0,
    "deliveryPlatforms" TEXT[],
    "planPriceSnapshot" DECIMAL(10,2),
    "paymentReference" TEXT,
    "onboardingCompletedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "venuesMigrated" BOOLEAN NOT NULL DEFAULT false,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Outlet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Outlet_slug_key" ON "Outlet"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Outlet_restaurantCode_key" ON "Outlet"("restaurantCode");

-- CreateIndex
CREATE INDEX "Outlet_parentRestaurantId_idx" ON "Outlet"("parentRestaurantId");

-- CreateIndex
CREATE INDEX "Outlet_organizationId_idx" ON "Outlet"("organizationId");

-- CreateIndex
CREATE INDEX "User_outletId_idx" ON "User"("outletId");

-- CreateIndex
CREATE UNIQUE INDEX "User_outletId_email_key" ON "User"("outletId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "User_outletId_id_key" ON "User"("outletId", "id");

-- AddForeignKey
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_parentRestaurantId_fkey" FOREIGN KEY ("parentRestaurantId") REFERENCES "Outlet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outlet" ADD CONSTRAINT "Outlet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletAccess" ADD CONSTRAINT "OutletAccess_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenuePrice" ADD CONSTRAINT "VenuePrice_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
