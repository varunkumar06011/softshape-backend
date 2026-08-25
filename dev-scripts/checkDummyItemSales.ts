// Check: (a) did today's bills sell any of the 4 dummy-stock items?
// (b) what exactly do the 3 stock-out bills need?
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";
const DAY_START = new Date("2026-08-24T00:00:00.000+05:30");
const DAY_END = new Date("2026-08-25T00:00:00.000+05:30");

const DUMMY_ITEMS = ["Budweiser Beer", "Kalyani Beer", "Stok Strong Beer", "Absolut Vodka 30Ml"];

async function main() {
  // (a) SALE transactions today against the 4 dummy items
  const invItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, menuItem: { name: { in: DUMMY_ITEMS } } },
    include: { menuItem: { select: { name: true } } },
  });
  console.log("=== (a) Today's transactions for dummy items ===");
  for (const inv of invItems) {
    const txns = await prisma.inventoryTransaction.findMany({
      where: {
        restaurantId: RESTAURANT_ID,
        itemId: inv.id,
        transactionDate: { gte: DAY_START, lt: DAY_END },
        NOT: { notes: { startsWith: "Physical snapshot" } },
      },
      select: { type: true, quantityChange: true, notes: true },
    });
    console.log(`${inv.menuItem?.name}: current=${inv.currentStock}ml | today txns: ${txns.length}`);
    txns.forEach((t) => console.log(`   ${t.type} ${t.quantityChange}ml — ${t.notes || ""}`));
  }

  // (b) The 3 stock-out orders: which bar items do they contain?
  console.log("\n=== (b) Stock-out order contents ===");
  const orderIds = ["29d296e5", "2b8ef6d4", "528dfd3b"];
  const orders = await prisma.order.findMany({
    where: { restaurantId: RESTAURANT_ID, status: "PAID" },
    include: { items: { where: { removedFromBill: false, quantity: { gt: 0 } }, include: { menuItem: true } } },
  });
  for (const o of orders) {
    if (!orderIds.some((s) => o.id.endsWith(s))) continue;
    console.log(`\nOrder ${o.id.slice(-8)} (₹${o.totalAmount}):`);
    for (const item of o.items) {
      const mt = item.menuItem.menuType as string;
      if (mt === "LIQUOR" || mt === "BAR") {
        console.log(`   ${item.menuItem.name} x${item.quantity} @ ₹${item.price}`);
      }
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
