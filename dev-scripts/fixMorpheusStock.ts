// Apply sheet "MORPHEUS XO RARE 750ML" closing (4 bottles + 100ml = 3100ml)
// to DB item "Morpheus 30ml" which had no sheet row by that name.
import { PrismaClient, Prisma } from "@prisma/client";
const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";
const CLOSING_ML = 4 * 750 + 100; // 3100

async function main() {
  const inv = await prisma.inventoryItem.findFirst({
    where: { restaurantId: RESTAURANT_ID, menuItem: { name: "Morpheus 30ml" } },
    include: { menuItem: { select: { name: true } } },
  });
  if (!inv) throw new Error("Morpheus 30ml inventory not found");

  const before = Number(inv.currentStock);
  const delta = CLOSING_ML - before;

  await prisma.$transaction(async (tx) => {
    await tx.inventoryItem.updateMany({
      where: { id: inv.id, restaurantId: RESTAURANT_ID },
      data: { openingStock: new Prisma.Decimal(CLOSING_ML), currentStock: new Prisma.Decimal(CLOSING_ML), updatedAt: new Date() },
    });
    if (Math.abs(delta) > 0.01) {
      await tx.inventoryTransaction.create({
        data: {
          restaurantId: RESTAURANT_ID,
          itemId: inv.id,
          type: "ADJUSTMENT",
          quantityChange: new Prisma.Decimal(delta),
          stockBefore: new Prisma.Decimal(before),
          stockAfter: new Prisma.Decimal(CLOSING_ML),
          notes: "Physical snapshot 2026-08-24: baseline 3100ml (MORPHEUS XO RARE closing 2+2=4 btl, margin 100ml)",
          createdBy: "SeedScript",
        },
      });
    }
  });
  console.log(`✓ Morpheus 30ml: ${before}ml → ${CLOSING_ML}ml (Δ${delta}ml)`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
