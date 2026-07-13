/**
 * One-time cleanup: soft-delete LIQUOR menu items from non-bar outlets.
 *
 * Vgrand Lounge (BAR_LOUNGE) and Vgrand Family Restaurant (DINE_IN) share
 * the same organization. Liquor items were incorrectly created in the
 * Family Restaurant outlet. This script removes them.
 *
 * Usage:
 *   npx ts-node --project tsconfig.dev.json dev-scripts/cleanupLiquorFromNonBarOutlets.ts [--dry-run]
 */
import "dotenv/config";
import prisma from "../src/lib/prisma";

const BAR_OUTLET_TYPES = new Set(["BAR_LOUNGE", "BAR_WITH_DINING"]);

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(dryRun ? "[DRY RUN]" : "[LIVE]");
  console.log("Scanning for LIQUOR items in non-bar outlets...\n");

  const allOutlets = await prisma.outlet.findMany({
    select: { id: true, name: true, restaurantType: true },
  });

  const nonBarOutlets = allOutlets.filter(
    (o) => !BAR_OUTLET_TYPES.has(o.restaurantType ?? "")
  );

  let totalCleaned = 0;

  for (const outlet of nonBarOutlets) {
    const liquorItems = await prisma.menuItem.findMany({
      where: {
        restaurantId: outlet.id,
        menuType: "LIQUOR",
        isDeleted: false,
      },
      select: { id: true, name: true },
    });

    if (liquorItems.length === 0) continue;

    console.log(
      `  ${outlet.name} (${outlet.id}) — ${liquorItems.length} LIQUOR items found`
    );
    for (const item of liquorItems) {
      console.log(`    - ${item.name}`);
    }

    if (!dryRun) {
      const result = await prisma.menuItem.updateMany({
        where: {
          restaurantId: outlet.id,
          menuType: "LIQUOR",
          isDeleted: false,
        },
        data: { isDeleted: true, deletedAt: new Date() },
      });
      console.log(`    -> Soft-deleted ${result.count} items`);
      totalCleaned += result.count;
    } else {
      totalCleaned += liquorItems.length;
    }
  }

  console.log(
    `\n${dryRun ? "Would soft-delete" : "Soft-deleted"} ${totalCleaned} LIQUOR items from non-bar outlets.`
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
