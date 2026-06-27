-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "venuesMigrated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Section" ADD COLUMN     "floorId" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "venueId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "venueId" TEXT;

-- CreateTable
CREATE TABLE "TaxProfile" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gstCategory" TEXT NOT NULL DEFAULT 'NON_AC',
    "gstRate" DOUBLE PRECISION,
    "gstRegistered" BOOLEAN NOT NULL DEFAULT true,
    "serviceChargePercent" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceProfile" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceProfileItem" (
    "id" TEXT NOT NULL,
    "priceProfileId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceProfileItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "venueType" TEXT NOT NULL DEFAULT 'DINE_IN',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "priceProfileId" TEXT,
    "taxProfileId" TEXT,
    "kotPrinterName" TEXT,
    "billPrinterName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Floor" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Floor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxProfile_restaurantId_idx" ON "TaxProfile"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxProfile_restaurantId_id_key" ON "TaxProfile"("restaurantId", "id");

-- CreateIndex
CREATE INDEX "PriceProfile_restaurantId_idx" ON "PriceProfile"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceProfile_restaurantId_id_key" ON "PriceProfile"("restaurantId", "id");

-- CreateIndex
CREATE INDEX "PriceProfileItem_priceProfileId_idx" ON "PriceProfileItem"("priceProfileId");

-- CreateIndex
CREATE INDEX "PriceProfileItem_menuItemId_idx" ON "PriceProfileItem"("menuItemId");

-- CreateIndex
CREATE INDEX "PriceProfileItem_restaurantId_idx" ON "PriceProfileItem"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceProfileItem_priceProfileId_menuItemId_key" ON "PriceProfileItem"("priceProfileId", "menuItemId");

-- CreateIndex
CREATE INDEX "Venue_restaurantId_idx" ON "Venue"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "Venue_restaurantId_id_key" ON "Venue"("restaurantId", "id");

-- CreateIndex
CREATE INDEX "Floor_venueId_idx" ON "Floor"("venueId");

-- CreateIndex
CREATE INDEX "Floor_restaurantId_idx" ON "Floor"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "Floor_restaurantId_id_key" ON "Floor"("restaurantId", "id");

-- CreateIndex
CREATE INDEX "Section_venueId_idx" ON "Section"("venueId");

-- CreateIndex
CREATE INDEX "Section_floorId_idx" ON "Section"("floorId");

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceProfileItem" ADD CONSTRAINT "PriceProfileItem_priceProfileId_fkey" FOREIGN KEY ("priceProfileId") REFERENCES "PriceProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceProfileItem" ADD CONSTRAINT "PriceProfileItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_priceProfileId_fkey" FOREIGN KEY ("priceProfileId") REFERENCES "PriceProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_taxProfileId_fkey" FOREIGN KEY ("taxProfileId") REFERENCES "TaxProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Floor" ADD CONSTRAINT "Floor_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
