/**
 * addMissingBarTables.ts
 *
 * Inserts bar tables 26-30 into the live DB for restaurantId = "bar-001".
 * Safe to run multiple times – skips any table number that already exists.
 *
 * Run with:
 *   npx ts-node -r tsconfig-paths/register prisma/addMissingBarTables.ts
 */

import { PrismaClient, TableStatus } from "@prisma/client";

const prisma = new PrismaClient();
const BAR_ID = "bar-001";
const MISSING_TABLE_NUMBERS = [26, 27, 28, 29, 30];

async function main() {
  console.log(`Looking for Bar section in restaurantId="${BAR_ID}"…`);

  // Reuse the existing "Bar Hall" section
  let section = await prisma.section.findFirst({
    where: { restaurantId: BAR_ID },
  });

  if (!section) {
    console.log("No section found – creating 'Bar Hall'…");
    section = await prisma.section.create({
      data: { name: "Bar Hall", restaurantId: BAR_ID },
    });
  }
  console.log(`Using section: "${section.name}" (${section.id})`);

  for (const num of MISSING_TABLE_NUMBERS) {
    const existing = await prisma.table.findFirst({
      where: { restaurantId: BAR_ID, number: num },
    });

    if (existing) {
      console.log(`  Table ${num} already exists (${existing.id}) – skipping.`);
      continue;
    }

    const created = await prisma.table.create({
      data: {
        number: num,
        capacity: 4,
        status: TableStatus.AVAILABLE,
        sectionId: section.id,
        restaurantId: BAR_ID,
      },
    });
    console.log(`  ✓ Created table ${num} → ${created.id}`);
  }

  console.log("Done. Bar now has all 30 tables.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
