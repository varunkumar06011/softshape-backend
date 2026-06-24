import { PrismaClient, TableStatus } from "@prisma/client";

const prisma = new PrismaClient();
const VENUE_ID = "venue-001";

async function main() {
  console.log("[SeedGoBox] Starting...");

  // Fix wrongly-stamped Parcel table first
  await prisma.table.updateMany({
    where: {
      restaurantId: VENUE_ID,
      section: { name: { equals: 'Parcel', mode: 'insensitive' } },
      sectionTag: 'venue-bar-gobox', // was wrongly stamped
    },
    data: { sectionTag: 'venue-restaurant-parcel' },
  });
  console.log("[SeedGoBox] Fixed wrongly-stamped Parcel table.");

  // Upsert GoBox section
  const section = await prisma.section.upsert({
    where: { id: "section-venue-gobox" },
    create: { id: "section-venue-gobox", name: "GoBox", restaurantId: VENUE_ID },
    update: { name: "GoBox" },
  });
  console.log(`[SeedGoBox] Section: ${section.name} (${section.id})`);

  // Upsert 10 tables
  for (let i = 1; i <= 10; i++) {
    const table = await prisma.table.upsert({
      where: {
        restaurantId_sectionId_number: {
          restaurantId: VENUE_ID,
          sectionId: section.id,
          number: i,
        },
      },
      create: {
        number: i,
        capacity: 4,
        status: TableStatus.AVAILABLE,
        restaurantId: VENUE_ID,
        sectionId: section.id,
        sectionTag: "venue-bar-gobox",
      },
      update: { sectionTag: "venue-bar-gobox" },
    });
    console.log(`[SeedGoBox]   Table #${table.number} → GB${table.number}`);
  }

  console.log("[SeedGoBox] Done ✓");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
