-- SectionMenuItemAvailability — per-section menu item availability override
-- Mirrors VenueMenuItemAvailability but scoped to a Section (one level below Venue).

-- CreateTable
CREATE TABLE "SectionMenuItemAvailability" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SectionMenuItemAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SectionMenuItemAvailability_sectionId_menuItemId_key" ON "SectionMenuItemAvailability"("sectionId", "menuItemId");

-- CreateIndex
CREATE INDEX "SectionMenuItemAvailability_sectionId_idx" ON "SectionMenuItemAvailability"("sectionId");

-- CreateIndex
CREATE INDEX "SectionMenuItemAvailability_menuItemId_idx" ON "SectionMenuItemAvailability"("menuItemId");

-- CreateIndex
CREATE INDEX "SectionMenuItemAvailability_restaurantId_idx" ON "SectionMenuItemAvailability"("restaurantId");

-- AddForeignKey
ALTER TABLE "SectionMenuItemAvailability" ADD CONSTRAINT "SectionMenuItemAvailability_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SectionMenuItemAvailability" ADD CONSTRAINT "SectionMenuItemAvailability_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SectionMenuItemAvailability" ADD CONSTRAINT "SectionMenuItemAvailability_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE CASCADE ON UPDATE CASCADE;
