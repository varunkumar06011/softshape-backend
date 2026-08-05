-- CreateTable
CREATE TABLE "MenuColumnMapping" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "originalHeader" TEXT NOT NULL,
    "canonicalField" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuColumnMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuColumnMapping_restaurantId_idx"
ON "MenuColumnMapping"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuColumnMapping_restaurantId_originalHeader_key"
ON "MenuColumnMapping"("restaurantId", "originalHeader");