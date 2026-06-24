import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanupZeroPriceItems() {
  console.log('🔍 Finding items with all zero prices...');

  const itemsToDelete = ['Buffet Nv', 'Buffet Veg'];

  let deletedCount = 0;

  for (const name of itemsToDelete) {
    const items = await prisma.menuItem.findMany({
      where: {
        name: { contains: name, mode: 'insensitive' },
        isDeleted: false,
      },
    });

    if (items.length > 0) {
      console.log(`📌 Found ${items.length} item(s) matching "${name}"`);

      for (const item of items) {
        await prisma.menuItem.update({
          where: { id: item.id },
          data: {
            isDeleted: true,
            deletedAt: new Date(),
          },
        });
        console.log(`  ✅ Soft-deleted: ${item.name} (ID: ${item.id})`);
        deletedCount++;
      }
    } else {
      console.log(`  ℹ️  No items found matching "${name}"`);
    }
  }

  console.log(`\n✅ Cleanup complete. Deleted ${deletedCount} zero-price items.`);
}

cleanupZeroPriceItems()
  .then(() => prisma.$disconnect())
  .catch((error) => {
    console.error('❌ Error during cleanup:', error);
    prisma.$disconnect();
    process.exit(1);
  });
