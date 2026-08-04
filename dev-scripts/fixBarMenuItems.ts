import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixBarMenuItems() {
  try {
    // Get all outlets (restaurants)
    const restaurants = await prisma.outlet.findMany();
    
    for (const restaurant of restaurants) {
      console.log(`Processing restaurant: ${restaurant.name} (${restaurant.id})`);
      
      // Find menu items that should be bar items but don't have correct settings
      // This looks for items in bar categories or with bar-like names
      const barCategories = await prisma.category.findMany({
        where: {
          restaurantId: restaurant.id,
          name: {
            contains: 'bar',
            mode: 'insensitive'
          }
        }
      });
      
      const barCategoryIds = barCategories.map(c => c.id);
      
      // Update items in bar categories to have menuType = LIQUOR
      if (barCategoryIds.length > 0) {
        const updated = await prisma.menuItem.updateMany({
          where: {
            restaurantId: restaurant.id,
            categoryId: { in: barCategoryIds },
            menuType: 'FOOD' // Only update those incorrectly set as FOOD
          },
          data: {
            menuType: 'LIQUOR'
          }
        });
        
        console.log(`  Updated ${updated.count} items in bar categories to LIQUOR`);
      }
      
      // Also update items with printerTarget = BAR_PRINTER but wrong menuType
      const updatedByPrinter = await prisma.menuItem.updateMany({
        where: {
          restaurantId: restaurant.id,
          printerTarget: 'BAR_PRINTER',
          menuType: 'FOOD'
        },
        data: {
          menuType: 'LIQUOR'
        }
      });
      
      console.log(`  Updated ${updatedByPrinter.count} items with BAR_PRINTER to LIQUOR`);
    }
    
    console.log('Done!');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixBarMenuItems();
