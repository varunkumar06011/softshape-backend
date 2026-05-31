const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://postgres.omjgrixjggavnxguidkb:Akhil@14324@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
    }
  }
});

async function main() {
  await prisma.$executeRawUnsafe('CREATE TABLE "VenuePrice" ("id" TEXT NOT NULL, "venueId" TEXT NOT NULL, "menuItemId" TEXT NOT NULL, "price" DECIMAL(10,2) NOT NULL, "isActive" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "VenuePrice_pkey" PRIMARY KEY ("id"));');
  await prisma.$executeRawUnsafe('CREATE INDEX "VenuePrice_venueId_idx" ON "VenuePrice"("venueId");');
  await prisma.$executeRawUnsafe('CREATE INDEX "VenuePrice_menuItemId_idx" ON "VenuePrice"("menuItemId");');
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX "VenuePrice_venueId_menuItemId_key" ON "VenuePrice"("venueId", "menuItemId");');
  console.log('Tables created!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
