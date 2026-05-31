import { PrismaClient, TableStatus } from "@prisma/client";

const prisma = new PrismaClient();
const VENUE_ID = "venue-001";

const SECTIONS = [
  {
    id: "section-venue-conf1",
    name: "Conference Hall 1",
    tables: [{ number: 1, capacity: 100 }],
  },
  {
    id: "section-venue-conf2",
    name: "Conference Hall 2",
    tables: [{ number: 1, capacity: 100 }],
  },
  {
    id: "section-venue-pdr",
    name: "PDR",
    tables: [
      { number: 1, capacity: 10 },
      { number: 2, capacity: 10 },
      { number: 3, capacity: 10 },
      { number: 4, capacity: 10 },
    ],
  },
  {
    id: "section-venue-parcel",
    name: "Parcel",
    tables: [{ number: 1, capacity: 1 }],
  },
];

async function main() {
  console.log("[SeedVenueTables] Starting...");

  for (const sec of SECTIONS) {
    const section = await prisma.section.upsert({
      where: { id: sec.id },
      create: { id: sec.id, name: sec.name, restaurantId: VENUE_ID },
      update: { name: sec.name },
    });
    console.log(`[SeedVenueTables] Section: ${section.name} (${section.id})`);

    for (const tbl of sec.tables) {
      const table = await prisma.table.upsert({
        where: {
          restaurantId_sectionId_number: {
            restaurantId: VENUE_ID,
            sectionId: section.id,
            number: tbl.number,
          },
        },
        create: {
          number: tbl.number,
          capacity: tbl.capacity,
          status: TableStatus.AVAILABLE,
          restaurantId: VENUE_ID,
          sectionId: section.id,
        },
        update: {},
      });
      console.log(
        `[SeedVenueTables]   Table #${table.number} in ${section.name} (${table.id})`
      );
    }
  }

  console.log("[SeedVenueTables] Done ✓");
}

main()
  .catch((e) => {
    console.error("[SeedVenueTables] Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
