import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';
  const venueId = 'cmqy60g55000u7dsc5rphkkix';

  // 1. Check menu items
  const items = await prisma.menuItem.findMany({
    where: {
      restaurantId: outletId,
      name: { contains: 'Magic Moments', mode: 'insensitive' },
      isDeleted: false,
    },
    include: { variants: true, category: { select: { name: true } } },
  });
  console.log(`\nMenu items matching "Magic Moments" (${items.length}):`);
  for (const item of items) {
    console.log(`  ${item.id}  |  ${item.name}  |  basePrice=${item.basePrice}  |  menuType=${item.menuType}  |  category=${item.category?.name}  |  printerTarget=${item.printerTarget}`);
    console.log(`    variants: ${item.variants.map(v => `${v.name}=₹${v.price}`).join(', ')}`);
  }

  // 2. Check venue price profile items
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    include: {
      priceProfile: {
        include: {
          items: {
            where: { menuItem: { name: { contains: 'Magic Moments', mode: 'insensitive' } } },
            include: { menuItem: { select: { name: true } } },
          },
        },
      },
    },
  });
  console.log(`\nVenue "${venue?.name}" price profile items:`);
  if (venue?.priceProfile?.items.length) {
    for (const ppi of venue.priceProfile.items) {
      console.log(`  ${ppi.menuItemId}  |  ${ppi.menuItem?.name}  |  price=₹${ppi.price}`);
    }
  } else {
    console.log('  (none found)');
  }

  // 3. Check inventory items
  const inv = await prisma.inventoryItem.findMany({
    where: { restaurantId: outletId },
    include: { menuItem: { select: { name: true } } },
  });
  const mmInv = inv.filter(i => (i.menuItem?.name || '').toLowerCase().includes('magic moments'));
  console.log(`\nInventory items matching "Magic Moments" (${mmInv.length}):`);
  for (const i of mmInv) {
    console.log(`  ${i.id}  |  ${i.menuItem?.name}  |  stock=${i.currentStock}  |  bottleSize=${i.bottleSize}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
