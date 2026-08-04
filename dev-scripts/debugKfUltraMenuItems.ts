import prisma from '../src/lib/prisma';

async function main() {
  const ordered = await prisma.menuItem.findUnique({
    where: { id: '176c3096-cbeb-4281-ae31-9ca8c7f7856e' },
    include: { category: { select: { name: true } }, variants: true },
  });
  const invMi = await prisma.menuItem.findUnique({
    where: { id: '972382dd-1d33-43e5-a847-9c291f69d69a' },
    include: { category: { select: { name: true } }, variants: true },
  });

  console.log('ORDERED menu item (the one in orders):');
  console.log('  id:', ordered?.id);
  console.log('  name:', ordered?.name);
  console.log('  menuType:', ordered?.menuType);
  console.log('  category:', ordered?.category?.name);
  console.log('  isAvailable:', ordered?.isAvailable);
  console.log('  isDeleted:', ordered?.isDeleted);
  console.log('  variants:', ordered?.variants.map(v => ({ name: v.name, price: Number(v.price) })));
  console.log('');
  console.log('INVENTORY menu item (the one with stock):');
  console.log('  id:', invMi?.id);
  console.log('  name:', invMi?.name);
  console.log('  menuType:', invMi?.menuType);
  console.log('  category:', invMi?.category?.name);
  console.log('  isAvailable:', invMi?.isAvailable);
  console.log('  isDeleted:', invMi?.isDeleted);
  console.log('  variants:', invMi?.variants.map(v => ({ name: v.name, price: Number(v.price) })));

  // Now simulate the exact name matching
  console.log('\n--- Name matching simulation ---');
  const orderedName = (ordered?.name || '').toLowerCase().trim();
  const invName = (invMi?.name || '').toLowerCase().trim();
  console.log(`ordered normalized: "${orderedName}"`);
  console.log(`inventory normalized: "${invName}"`);
  console.log(`exact match: ${orderedName === invName}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
