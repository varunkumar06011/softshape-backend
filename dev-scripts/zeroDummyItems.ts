// ─────────────────────────────────────────────────────────────────────────────
// zeroDummyItems.ts — Zero out openingStock and currentStock for the 4 items
// that were NOT on the physical inventory sheets and still hold old dummy values.
// These items had no sales today, so currentStock → 0 is safe.
// ─────────────────────────────────────────────────────────────────────────────
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";
const DUMMY_ITEMS = ["Budweiser Beer", "Kalyani Beer", "Stok Strong Beer", "Absolut Vodka 30Ml"];

async function main() {
  console.log("Zeroing dummy opening/current stock for items not on physical sheets:\n");
  for (const name of DUMMY_ITEMS) {
    const inv = await prisma.inventoryItem.findFirst({
      where: { restaurantId: RESTAURANT_ID, menuItem: { name }, isActive: true },
      include: { menuItem: { select: { name: true } } },
    });
    if (!inv) {
      console.log(`  ✗ ${name} — not found in DB, skipping`);
      continue;
    }
    const oldOpen = inv.openingStock;
    const oldCurr = inv.currentStock;
    await prisma.inventoryItem.update({
      where: { id: inv.id },
      data: { openingStock: 0, currentStock: 0 },
    });
    console.log(`  ✓ ${name} | opening ${oldOpen}→0 | current ${oldCurr}→0`);
  }
  console.log("\nDone.");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
