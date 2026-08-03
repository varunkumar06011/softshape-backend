// Quick DB connectivity check
import prisma from '../src/lib/prisma';

async function main() {
  try {
    const outlets = await prisma.outlet.findMany({ select: { id: true, name: true } });
    console.log('✅ DB Connected. Outlets:', JSON.stringify(outlets, null, 2));

    // Check if bar_item_mappings table exists
    try {
      const mappingCount = await prisma.barItemMapping.count();
      console.log('✅ bar_item_mappings table exists. Rows:', mappingCount);
    } catch (e: any) {
      console.log('⚠️ bar_item_mappings table does NOT exist yet (migration not run):', e.message);
    }

    // Count menu items by type
    const liquorItems = await prisma.menuItem.count({ where: { menuType: 'LIQUOR', isDeleted: false } });
    const foodItems = await prisma.menuItem.count({ where: { menuType: 'FOOD', isDeleted: false } });
    console.log(`Menu items: ${liquorItems} LIQUOR, ${foodItems} FOOD`);

    // Count inventory items
    const barInvCount = await prisma.inventoryItem.count();
    console.log(`Bar inventory items: ${barInvCount}`);

    // Count kitchen inventory items
    const kitchenInvCount = await prisma.kitchenInventoryItem.count();
    console.log(`Kitchen inventory items: ${kitchenInvCount}`);

    // Count recipes
    const recipeCount = await prisma.menuItemRecipe.count();
    console.log(`Menu item recipes: ${recipeCount}`);

    // Check for orders that need deduction
    const stuckOrders = await prisma.order.count({
      where: {
        status: 'PAID',
        OR: [
          { inventoryDeducted: false },
          { barInventoryDeducted: false },
        ],
      },
    });
    console.log(`Stuck orders (need deduction): ${stuckOrders}`);

  } catch (e: any) {
    console.error('❌ DB Error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
