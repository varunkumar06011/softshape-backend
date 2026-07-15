-- CreateTable: RepresentativeQR for non-table QR codes (bar/section representatives)
CREATE TABLE "RepresentativeQR" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "outletType" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepresentativeQR_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativeQR_restaurantId_slug_key" ON "RepresentativeQR"("restaurantId", "slug");

-- CreateIndex
CREATE INDEX "RepresentativeQR_restaurantId_idx" ON "RepresentativeQR"("restaurantId");
