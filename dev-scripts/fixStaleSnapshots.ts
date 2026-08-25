// Fix stale daily snapshots: sync closingStock = currentStock and recompute sold
import { Prisma, PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";
const TODAY = "2026-08-24";

async function main() {
  const snapshots = await prisma.dailyInventorySnapshot.findMany({
    where: { restaurantId: RESTAURANT_ID, snapshotDate: TODAY },
    include: { item: true },
  });

  let fixed = 0;
  let ok = 0;

  for (const s of snapshots) {
    const currentStock = Number(s.item?.currentStock ?? 0);
    const snapshotClosing = Number(s.closingStock);
    if (currentStock === snapshotClosing) { ok++; continue; }

    // Recompute: sold = opening + purchased - closing - wastage + |adjusted if negative|
    // But simplest: closing = currentStock, sold = opening + purchased - currentStock - wastage - (adjusted < 0 ? |adjusted| : 0)
    const opening = Number(s.openingStock);
    const purchased = Number(s.purchased);
    const wastage = Number(s.wastage);
    const adjusted = Number(s.adjusted);
    const adjustedOut = adjusted < 0 ? Math.abs(adjusted) : 0;
    const sold = opening + purchased - currentStock - wastage - adjustedOut;

    await prisma.dailyInventorySnapshot.update({
      where: { id: s.id },
      data: {
        sold: new Prisma.Decimal(Math.max(0, sold)),
        closingStock: new Prisma.Decimal(currentStock),
      },
    });
    console.log(`Fixed: ${s.itemName} | opening ${opening} → sold ${sold} → closing ${currentStock}`);
    fixed++;
  }

  console.log(`\n========================================`);
  console.log(`Already correct: ${ok} | Fixed: ${fixed} | Total: ${snapshots.length}`);
  console.log(`========================================`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
