// Add BarItemMapping rows for the exact (menuItemId, price) combos that
// appeared in today's settled bills but had no mapping (price variants).
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";

// (menuItemId, price) → (inventoryItemName, mlPerUnit)
const MISSING: Array<{
  menuItemId: string;
  price: number;
  invName: string;
  mlPerUnit: number;
}> = [
  // Kf Strong Beer ordered @ ₹350 and ₹200 (mapping only existed @ ₹500)
  { menuItemId: "76f5fc88-d99d-48d2-891f-c8db585a6dcd", price: 350, invName: "Kf Strong Beer", mlPerUnit: 650 },
  { menuItemId: "76f5fc88-d99d-48d2-891f-c8db585a6dcd", price: 200, invName: "Kf Strong Beer", mlPerUnit: 650 },
  // Stok Lite Beer ordered @ ₹350 (mapping only existed @ ₹220)
  { menuItemId: "5f0de6aa-1b33-4f65-9d72-2c02d73c13b8", price: 350, invName: "Stok Lite Beer", mlPerUnit: 650 },
  // Budweiser Magnum ordered @ ₹495 (mapping only existed @ ₹300)
  { menuItemId: "30532388-d0ed-44e5-8a18-bf7afbd1eb8d", price: 495, invName: "Budweiser Magnum Beer", mlPerUnit: 650 },
  // Mansion House 30ml ordered @ ₹58 (mapping only existed @ ₹37)
  { menuItemId: "b09edc00-dea6-4439-8a3c-9ed75b797657", price: 58, invName: "Mansion House 30ml", mlPerUnit: 30 },
  // Kf Storm Beer ordered @ ₹350 (mapping only existed @ ₹220)
  { menuItemId: "faf0c07c-af6a-455d-a71a-3a62e819335c", price: 350, invName: "Kf Storm Beer", mlPerUnit: 650 },
  // Thumsup 250 Ml ordered @ ₹25 (mapping only existed @ ₹20)
  { menuItemId: "c6811886-767e-4057-aa0d-88d576ca9736", price: 25, invName: "Thums Up 250ML", mlPerUnit: 250 },
  // Kf Ultra Beer ordered @ ₹350 (mapping only existed @ ₹220)
  { menuItemId: "176c3096-cbeb-4281-ae31-9ca8c7f7856e", price: 350, invName: "Kf Ultra Beer", mlPerUnit: 650 },
  // Breezer Platinum Tangy ordered @ ₹240 (mapping only existed @ ₹140)
  { menuItemId: "e9d91e0c-9460-4c73-927e-6becc5b7b78f", price: 240, invName: "BREEZER PLATINUM TANGY", mlPerUnit: 500 },
  // Sprite 250ml ordered @ ₹25 (mapping only existed @ ₹20)
  { menuItemId: "0e0420a8-bebe-4e86-962b-4a46dc93fb79", price: 25, invName: "Sprite 250ml", mlPerUnit: 250 },
];

async function main() {
  const invItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { select: { name: true } } },
  });
  const byName = new Map(invItems.map((i) => [(i.menuItem?.name || "").toLowerCase(), i]));

  for (const m of MISSING) {
    const inv = byName.get(m.invName.toLowerCase());
    if (!inv) {
      console.log(`✗ Inventory item "${m.invName}" not found`);
      continue;
    }
    try {
      await prisma.barItemMapping.upsert({
        where: { menuItemId_variantPrice: { menuItemId: m.menuItemId, variantPrice: new Prisma.Decimal(m.price) } },
        create: {
          restaurantId: RESTAURANT_ID,
          menuItemId: m.menuItemId,
          variantPrice: new Prisma.Decimal(m.price),
          primaryInvId: inv.id,
          mlPerUnit: new Prisma.Decimal(m.mlPerUnit),
        },
        update: {},
      });
      console.log(`✓ ${m.invName} @ ₹${m.price} → ${inv.id} (${m.mlPerUnit}ml/unit)`);
    } catch (e: any) {
      console.log(`✗ ${m.invName} @ ₹${m.price}: ${e.message}`);
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
