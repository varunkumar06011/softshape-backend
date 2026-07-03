/**
 * migrateSharedKitchen.ts — One-time data migration for shared kitchen inventory.
 *
 * Usage:
 *   npx tsx dev-scripts/migrateSharedKitchen.ts --owner <ownerOutletId> --outlet <outletId> [--execute]
 *
 * Without --execute, runs in dry-run mode (no writes, just logs what would happen).
 * With --execute, performs the migration and sets sharedKitchenOutletId on the outlet.
 *
 * Steps:
 * 1. Fetch all KitchenInventoryItem rows for both --owner and --outlet
 * 2. Match by name (case-insensitive) — items that exist in both
 * 3. For matched items:
 *    a. Pick the owner's row as canonical
 *    b. Repoint MenuItemRecipe.ingredientId in --outlet → owner's row ID
 *    c. Migrate outlet's InventoryDailyEntry rows to owner's restaurantId + owner's itemId
 *       - Collision handling for @@unique([restaurantId, itemId, entryDate]):
 *         merge into owner's row (sum addedStock/consumedStock, keep owner's opening/closing)
 *    d. Delete the outlet's duplicate KitchenInventoryItem row
 * 4. For items only in --outlet (not in owner):
 *    a. Repoint KitchenInventoryItem.restaurantId → owner's ID
 *    b. Repoint InventoryDailyEntry.restaurantId → owner's ID
 * 5. For items only in --owner: no action needed
 * 6. Set Outlet.sharedKitchenOutletId = owner's ID (if --execute)
 * 7. Invalidate tenant context cache for all outlets in the org
 */

import { basePrisma } from "../src/lib/prisma";
import { invalidateTenantContextCache } from "../src/lib/tenantContext";

async function main() {
  const args = process.argv.slice(2);
  const ownerIdx = args.indexOf("--owner");
  const outletIdx = args.indexOf("--outlet");
  const execute = args.includes("--execute");

  if (ownerIdx === -1 || outletIdx === -1 || !args[ownerIdx + 1] || !args[outletIdx + 1]) {
    console.error("Usage: npx tsx dev-scripts/migrateSharedKitchen.ts --owner <ownerOutletId> --outlet <outletId> [--execute]");
    process.exit(1);
  }

  const ownerId = args[ownerIdx + 1];
  const outletId = args[outletIdx + 1];

  console.log(`[migrate] Owner: ${ownerId}, Outlet: ${outletId}, Mode: ${execute ? "EXECUTE" : "DRY-RUN"}`);

  // Fetch owner and outlet info
  const [owner, outlet] = await Promise.all([
    basePrisma.outlet.findUnique({ where: { id: ownerId }, select: { id: true, name: true, organizationId: true } }),
    basePrisma.outlet.findUnique({ where: { id: outletId }, select: { id: true, name: true, organizationId: true, sharedKitchenOutletId: true } }),
  ]);

  if (!owner) { console.error(`[migrate] Owner outlet ${ownerId} not found`); process.exit(1); }
  if (!outlet) { console.error(`[migrate] Outlet ${outletId} not found`); process.exit(1); }
  if (owner.organizationId !== outlet.organizationId) {
    console.error(`[migrate] Owner and outlet must be in the same organization`);
    process.exit(1);
  }
  if (outlet.sharedKitchenOutletId) {
    console.error(`[migrate] Outlet already has sharedKitchenOutletId = ${outlet.sharedKitchenOutletId}`);
    process.exit(1);
  }

  // Step 1: Fetch all kitchen items for both
  const [ownerItems, outletItems] = await Promise.all([
    basePrisma.kitchenInventoryItem.findMany({ where: { restaurantId: ownerId } }),
    basePrisma.kitchenInventoryItem.findMany({ where: { restaurantId: outletId } }),
  ]);

  console.log(`[migrate] Owner items: ${ownerItems.length}, Outlet items: ${outletItems.length}`);

  // Step 2: Match by name (case-insensitive)
  const ownerByName = new Map(ownerItems.map(i => [i.name.toLowerCase(), i]));
  const matched: { owner: typeof ownerItems[0]; outlet: typeof outletItems[0] }[] = [];
  const outletOnly: typeof outletItems[0][] = [];

  for (const oi of outletItems) {
    const match = ownerByName.get(oi.name.toLowerCase());
    if (match) {
      matched.push({ owner: match, outlet: oi });
    } else {
      outletOnly.push(oi);
    }
  }

  console.log(`[migrate] Matched items: ${matched.length}, Outlet-only items: ${outletOnly.length}`);

  // Step 3: Process matched items
  for (const { owner: ownerItem, outlet: outletItem } of matched) {
    console.log(`[migrate] Matched: "${ownerItem.name}" (owner: ${ownerItem.id}, outlet: ${outletItem.id})`);

    // 3b. Repoint MenuItemRecipe.ingredientId in outlet → owner's row ID
    const recipes = await basePrisma.menuItemRecipe.findMany({
      where: { ingredientId: outletItem.id },
      select: { id: true },
    });
    console.log(`[migrate]   Repointing ${recipes.length} MenuItemRecipe rows`);
    if (execute && recipes.length > 0) {
      await basePrisma.menuItemRecipe.updateMany({
        where: { ingredientId: outletItem.id },
        data: { ingredientId: ownerItem.id },
      });
    }

    // 3d. Migrate outlet's InventoryDailyEntry rows
    const outletEntries = await basePrisma.inventoryDailyEntry.findMany({
      where: { restaurantId: outletId, itemId: outletItem.id },
    });

    for (const entry of outletEntries) {
      // Check for collision: owner already has an entry for this date
      const ownerEntry = await basePrisma.inventoryDailyEntry.findUnique({
        where: {
          restaurantId_itemId_entryDate: {
            restaurantId: ownerId,
            itemId: ownerItem.id,
            entryDate: entry.entryDate,
          },
        },
      });

      if (ownerEntry) {
        // Collision — merge into owner's row
        const mergedAdded = Number(ownerEntry.addedStock) + Number(entry.addedStock);
        const mergedConsumed = Number(ownerEntry.consumedStock) + Number(entry.consumedStock);
        console.log(`[migrate]   Date ${entry.entryDate}: merging (added: +${entry.addedStock}, consumed: +${entry.consumedStock}) into owner's entry`);
        if (execute) {
          await basePrisma.inventoryDailyEntry.update({
            where: { id: ownerEntry.id },
            data: {
              addedStock: mergedAdded,
              consumedStock: mergedConsumed,
            },
          });
          await basePrisma.inventoryDailyEntry.delete({ where: { id: entry.id } });
        }
      } else {
        // No collision — simple repoint
        if (execute) {
          await basePrisma.inventoryDailyEntry.update({
            where: { id: entry.id },
            data: { restaurantId: ownerId, itemId: ownerItem.id },
          });
        }
      }
    }

    // 3c. Delete the outlet's duplicate KitchenInventoryItem row
    console.log(`[migrate]   Deleting outlet's duplicate item row`);
    if (execute) {
      await basePrisma.kitchenInventoryItem.delete({ where: { id: outletItem.id } });
    }
  }

  // Step 4: Process outlet-only items (not in owner)
  for (const item of outletOnly) {
    console.log(`[migrate] Outlet-only: "${item.name}" (${item.id}) — repointing to owner`);

    if (execute) {
      // 4a. Repoint KitchenInventoryItem.restaurantId → owner's ID
      await basePrisma.kitchenInventoryItem.update({
        where: { id: item.id },
        data: { restaurantId: ownerId },
      });

      // 4b. Repoint InventoryDailyEntry.restaurantId → owner's ID
      await basePrisma.inventoryDailyEntry.updateMany({
        where: { itemId: item.id, restaurantId: outletId },
        data: { restaurantId: ownerId },
      });
    }
  }

  // Step 6: Set sharedKitchenOutletId
  console.log(`[migrate] Setting sharedKitchenOutletId = ${ownerId} on outlet ${outletId}`);
  if (execute) {
    await basePrisma.outlet.update({
      where: { id: outletId },
      data: { sharedKitchenOutletId: ownerId },
    });
  }

  // Step 7: Invalidate tenant context cache
  const allOutlets = await basePrisma.outlet.findMany({
    where: { organizationId: owner.organizationId },
    select: { id: true },
  });
  if (execute) {
    await Promise.all(allOutlets.map(o => invalidateTenantContextCache(o.id)));
  }

  console.log(`[migrate] Done. ${execute ? "Changes applied." : "Dry-run — no changes made. Run with --execute to apply."}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
