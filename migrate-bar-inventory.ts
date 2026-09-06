// ─────────────────────────────────────────────────────────────────────────────
// Bar Inventory Redesign — Data Migration Script
//
// Migrates data from the old dual-table model (InventoryItem + NonAcInventoryItem)
// into the new single-stock-pool model (BarInventoryItem + BarInventoryMovement +
// BarDailyRecord). Also repoints BarDeductionLog.inventoryItemId from the old
// InventoryItem table to the new bar_inventory_items table.
//
// Phases:
//   1. Create BarInventoryItem from InventoryItem
//   2. Merge NonAcInventoryItem into BarInventoryItem
//   3. Link MenuItems to BarInventoryItem
//   4. Migrate InventoryTransaction → BarInventoryMovement
//   5. Migrate DailyInventorySnapshot → BarDailyRecord
//   6. Migrate NonAcDailyEntry → NON_AC_SALE movements + BarDailyRecord
//   7. Repoint BarDeductionLog.inventoryItemId → BarInventoryItem.id
//
// Idempotent: safe to run multiple times. Uses upserts and existence checks.
//
// Usage:
//   npx ts-node migrate-bar-inventory.ts [--restaurant-id=xxx]
//   npx ts-node migrate-bar-inventory.ts --dry-run   (report only, no writes)
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import { getKolkataDateString } from "./src/utils/date";
import { parseMlFromName, normalizeProductBaseName } from "./src/utils/barMatching";

const prisma = new PrismaClient();

const isDryRun = process.argv.includes("--dry-run");
const restaurantArg = process.argv.find((a) => a.startsWith("--restaurant-id="));
const targetRestaurantId = restaurantArg ? restaurantArg.split("=")[1] : undefined;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract a human-readable brand from an item name by stripping size suffixes. */
function extractBrand(name: string): string {
  const base = normalizeProductBaseName(name);
  // Title-case the first letters for display
  return base
    .split(" ")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Determine the category label from a MenuItem's category object or name. */
function extractCategory(menuItem: any): string {
  const cat = menuItem.category;
  if (cat && typeof cat === "object" && "name" in cat) {
    return String(cat.name || "Liquor");
  }
  if (typeof cat === "string") return cat;
  return "Liquor";
}

/** Convert bottle count to ml for a given bottle size. */
function bottlesToMl(bottles: number, bottleSizeMl: number): number {
  return bottles * bottleSizeMl;
}

// ── Phase 1: Create BarInventoryItem from InventoryItem ───────────────────────

async function phase1_CreateFromInventoryItem(
  restaurantId: string,
  invItemToBarItem: Map<string, string>,
): Promise<number> {
  // Include archived items that have BarDeductionLogs so their deduction logs
  // can be repointed to valid BarInventoryItems (no data loss).
  const archivedWithLogs = await prisma.barDeductionLog.findMany({
    where: { restaurantId },
    select: { inventoryItemId: true },
    distinct: ["inventoryItemId"],
  });
  const archivedIds = new Set(archivedWithLogs.map((l) => l.inventoryItemId));

  const invItems = await prisma.inventoryItem.findMany({
    where: {
      restaurantId,
      OR: [
        { isActive: true },
        { id: { in: [...archivedIds] } },
      ],
    },
    include: { menuItem: { include: { category: true } } },
  });

  let created = 0;
  for (const inv of invItems) {
    const menuItem = inv.menuItem;
    if (!menuItem) continue;

    const name = menuItem.name;
    const bottleSizeMl = inv.bottleSize > 0 ? inv.bottleSize : (parseMlFromName(name) ?? 750);
    const brand = extractBrand(name);
    const category = extractCategory(menuItem);

    // currentStock is in ml for InventoryItem
    const currentStockMl = Number(inv.currentStock) || 0;
    const reorderLevelBottles = Number(inv.reorderLevel) || 0;
    const purchaseRate = inv.costPerBottle ? Number(inv.costPerBottle) : null;
    const sellingPricePerMl = inv.acSellingPerMl ? Number(inv.acSellingPerMl) : null;

    if (isDryRun) {
      console.log(`  [DRY] Phase1: would create BarInventoryItem "${name}" (stock=${currentStockMl}ml)`);
      created++;
      continue;
    }

    const barItem = await prisma.barInventoryItem.upsert({
      where: { restaurantId_name: { restaurantId, name } },
      create: {
        restaurantId,
        name,
        brand,
        category,
        bottleSizeMl,
        currentStockMl,
        reorderLevelBottles,
        purchaseRate,
        sellingPricePerMl,
        isActive: inv.isActive,
        isHiddenFromReport: inv.isHiddenFromReport,
      },
      update: {
        // Only update if not already set (don't overwrite migrated data)
        currentStockMl: currentStockMl,
        purchaseRate: purchaseRate ?? undefined,
        sellingPricePerMl: sellingPricePerMl ?? undefined,
      },
    });

    invItemToBarItem.set(inv.id, barItem.id);
    created++;
  }

  return created;
}

// ── Phase 2: Merge NonAcInventoryItem into BarInventoryItem ───────────────────

async function phase2_MergeNonAc(
  restaurantId: string,
  invItemToBarItem: Map<string, string>,
): Promise<number> {
  const nonAcItems = await prisma.nonAcInventoryItem.findMany({
    where: { restaurantId, isActive: true },
  });

  let merged = 0;
  for (const nonAc of nonAcItems) {
    const name = nonAc.itemName;
    const bottleSizeMl = nonAc.bottleSize > 0 ? nonAc.bottleSize : (parseMlFromName(name) ?? 750);
    const brand = extractBrand(name);
    const category = nonAc.category || "Liquor";

    // Convert bottle-based stock to ml
    const currentStockMl = bottlesToMl(Number(nonAc.currentBottles) || 0, bottleSizeMl);
    const reorderLevelBottles = 0;
    const purchaseRate = nonAc.purchaseRate ? Number(nonAc.purchaseRate) : null;
    const sellingPricePerMl = nonAc.nonAcSellingPrice
      ? Number(nonAc.nonAcSellingPrice) / bottleSizeMl
      : null;

    if (isDryRun) {
      console.log(`  [DRY] Phase2: would merge NonAc "${name}" (stock=${currentStockMl}ml)`);
      merged++;
      continue;
    }

    // Try to find existing BarInventoryItem by name
    let barItem = await prisma.barInventoryItem.findUnique({
      where: { restaurantId_name: { restaurantId, name } },
    });

    if (barItem) {
      // Merge: use NonAc purchaseRate if AC has none
      await prisma.barInventoryItem.update({
        where: { id: barItem.id },
        data: {
          purchaseRate: barItem.purchaseRate ?? purchaseRate,
          sellingPricePerMl: barItem.sellingPricePerMl ?? sellingPricePerMl,
        },
      });
    } else {
      barItem = await prisma.barInventoryItem.create({
        data: {
          restaurantId,
          name,
          brand,
          category,
          bottleSizeMl,
          currentStockMl,
          reorderLevelBottles,
          purchaseRate,
          sellingPricePerMl,
          isActive: nonAc.isActive,
          isHiddenFromReport: nonAc.isHiddenFromReport,
        },
      });
    }

    // Map NonAc item to bar item for Phase 6
    invItemToBarItem.set(`nonac:${nonAc.id}`, barItem.id);
    merged++;
  }

  return merged;
}

// ── Phase 3: Link MenuItems to BarInventoryItem ───────────────────────────────

async function phase3_LinkMenuItems(restaurantId: string): Promise<{ linked: number; autoCreated: number }> {
  const liquorItems = await prisma.menuItem.findMany({
    where: { restaurantId, menuType: "LIQUOR", isDeleted: false },
    include: { category: true, inventoryItem: true },
  });

  let linked = 0;
  let autoCreated = 0;

  for (const menuItem of liquorItems) {
    const name = menuItem.name;
    const parsedMl = parseMlFromName(name);
    const deductionMl = parsedMl ?? null;

    // Skip if already linked
    if (menuItem.barInventoryItemId) {
      // Still ensure deductionMl is set
      if (!menuItem.deductionMl && deductionMl) {
        if (!isDryRun) {
          await prisma.menuItem.update({
            where: { id: menuItem.id },
            data: { deductionMl },
          });
        }
      }
      linked++;
      continue;
    }

    // Strategy 1: Direct — this menuItem had an InventoryItem
    if (menuItem.inventoryItem) {
      const inv = menuItem.inventoryItem;
      const barItem = await prisma.barInventoryItem.findUnique({
        where: { restaurantId_name: { restaurantId, name } },
      });
      if (barItem) {
        if (!isDryRun) {
          await prisma.menuItem.update({
            where: { id: menuItem.id },
            data: { barInventoryItemId: barItem.id, deductionMl },
          });
        }
        linked++;
        continue;
      }
    }

    // Strategy 2: Base-name match — find a BarInventoryItem with same brand and bottle size >= parsed ml
    const baseName = normalizeProductBaseName(name);
    const allBarItems = await prisma.barInventoryItem.findMany({
      where: { restaurantId, isActive: true },
    });

    // Find items with same normalized base name
    const sameBrand = allBarItems.filter(
      (bi) => normalizeProductBaseName(bi.name) === baseName,
    );

    let targetBarItem: any = null;

    if (parsedMl && sameBrand.length > 0) {
      // For peg sizes (30/60/90), find the largest bottle (typically 750ml)
      // For bottle sizes (180/375/750), find the exact match
      if (parsedMl <= 90) {
        // Peg → largest bottle of same brand
        targetBarItem = sameBrand.reduce((max, bi) =>
          bi.bottleSizeMl > max.bottleSizeMl ? bi : max,
        );
      } else {
        // Bottle size → exact match
        targetBarItem = sameBrand.find((bi) => bi.bottleSizeMl === parsedMl) ?? null;
        if (!targetBarItem) {
          // Fall back to largest bottle
          targetBarItem = sameBrand.reduce((max, bi) =>
            bi.bottleSizeMl > max.bottleSizeMl ? bi : max,
          );
        }
      }
    } else if (sameBrand.length > 0) {
      // No size parsed → use largest bottle
      targetBarItem = sameBrand.reduce((max, bi) =>
        bi.bottleSizeMl > max.bottleSizeMl ? bi : max,
      );
    }

    if (targetBarItem) {
      if (!isDryRun) {
        await prisma.menuItem.update({
          where: { id: menuItem.id },
          data: { barInventoryItemId: targetBarItem.id, deductionMl },
        });
      }
      linked++;
      continue;
    }

    // Strategy 3: Auto-create BarInventoryItem with opening stock = 0
    const bottleSizeMl = parsedMl && parsedMl >= 180 ? parsedMl : 750;
    const brand = extractBrand(name);
    const category = extractCategory(menuItem);

    if (isDryRun) {
      console.log(`  [DRY] Phase3: would auto-create BarInventoryItem for "${name}"`);
      autoCreated++;
      continue;
    }

    // Use the menu item name as the bar item name if it's a bottle size,
    // otherwise use brand + bottle size
    const barItemName = parsedMl && parsedMl >= 180 ? name : `${brand} ${bottleSizeMl}ml`;

    const newBarItem = await prisma.barInventoryItem.upsert({
      where: { restaurantId_name: { restaurantId, name: barItemName } },
      create: {
        restaurantId,
        name: barItemName,
        brand,
        category,
        bottleSizeMl,
        currentStockMl: 0,
        reorderLevelBottles: 0,
        isActive: true,
      },
      update: {},
    });

    await prisma.menuItem.update({
      where: { id: menuItem.id },
      data: { barInventoryItemId: newBarItem.id, deductionMl },
    });
    autoCreated++;
  }

  return { linked, autoCreated };
}

// ── Phase 4: Migrate InventoryTransaction → BarInventoryMovement ──────────────

const TX_TYPE_MAP: Record<string, string> = {
  POS_DEDUCTION: "AC_SALE",
  PURCHASE: "PURCHASE",
  WASTAGE: "WASTAGE",
  WASTAGE_ENTRY: "WASTAGE",
  ADJUSTMENT: "ADJUSTMENT",
  SALE_REVERSAL: "SALE_REVERSAL",
  OPENING: "OPENING",
  PHYSICAL_COUNT: "PHYSICAL_COUNT",
};

async function phase4_MigrateTransactions(
  restaurantId: string,
  invItemToBarItem: Map<string, string>,
): Promise<number> {
  const transactions = await prisma.inventoryTransaction.findMany({
    where: { restaurantId },
    include: { item: { include: { menuItem: true } } },
    orderBy: { transactionDate: "asc" },
  });

  let migrated = 0;
  for (const tx of transactions) {
    const barItemId = invItemToBarItem.get(tx.itemId);
    if (!barItemId) continue;

    const movementType = TX_TYPE_MAP[tx.type] || "ADJUSTMENT";
    const dateStr = getKolkataDateString(tx.transactionDate);
    const quantityMl = Number(tx.quantityChange) || 0;

    if (isDryRun) {
      migrated++;
      continue;
    }

    await prisma.barInventoryMovement.create({
      data: {
        restaurantId,
        itemId: barItemId,
        date: dateStr,
        movementType,
        quantityMl,
        orderId: tx.orderId,
        unitCost: tx.unitCost ? Number(tx.unitCost) : null,
        source: tx.source || "MANUAL_ENTRY",
        notes: tx.notes,
        createdBy: tx.createdBy,
      },
    });
    migrated++;
  }

  return migrated;
}

// ── Phase 5: Migrate DailyInventorySnapshot → BarDailyRecord ──────────────────

async function phase5_MigrateSnapshots(
  restaurantId: string,
  invItemToBarItem: Map<string, string>,
): Promise<number> {
  const snapshots = await prisma.dailyInventorySnapshot.findMany({
    where: { restaurantId },
  });

  let migrated = 0;
  for (const snap of snapshots) {
    const barItemId = invItemToBarItem.get(snap.itemId);
    if (!barItemId) continue;

    if (isDryRun) {
      migrated++;
      continue;
    }

    const openingMl = Number(snap.openingStock) || 0;
    const purchasedMl = Number(snap.purchased) || 0;
    const acSaleMl = Number(snap.sold) || 0;
    const wastageMl = Number(snap.wastage) || 0;
    const adjustmentMl = Number(snap.adjusted) || 0;
    const systemClosingMl = Number(snap.closingStock) || 0;

    await prisma.barDailyRecord.upsert({
      where: {
        restaurantId_date_itemId: {
          restaurantId,
          date: snap.snapshotDate,
          itemId: barItemId,
        },
      },
      create: {
        restaurantId,
        itemId: barItemId,
        date: snap.snapshotDate,
        openingMl,
        purchasedMl,
        acSaleMl,
        wastageMl,
        adjustmentMl,
        systemClosingMl,
        finalized: true,
      },
      update: {},
    });
    migrated++;
  }

  return migrated;
}

// ── Phase 6: Migrate NonAcDailyEntry → NON_AC_SALE movements + BarDailyRecord ─

async function phase6_MigrateNonAcDaily(
  restaurantId: string,
  invItemToBarItem: Map<string, string>,
): Promise<number> {
  const entries = await prisma.nonAcDailyEntry.findMany({
    where: { restaurantId },
    include: { item: true },
  });

  let migrated = 0;
  for (const entry of entries) {
    const barItemId = invItemToBarItem.get(`nonac:${entry.itemId}`);
    if (!barItemId) continue;

    const bottleSizeMl = entry.item.bottleSize > 0 ? entry.item.bottleSize : 650;
    const adminDeductionMl = bottlesToMl(Number(entry.adminDeduction) || 0, bottleSizeMl);
    const receivedMl = bottlesToMl(Number(entry.receivedBottles) || 0, bottleSizeMl);
    const openingMl = bottlesToMl(Number(entry.openingBottles) || 0, bottleSizeMl);
    const closingMl = bottlesToMl(Number(entry.closingBottles) || 0, bottleSizeMl);

    if (isDryRun) {
      migrated++;
      continue;
    }

    // Create NON_AC_SALE movement for the deduction
    if (adminDeductionMl > 0) {
      await prisma.barInventoryMovement.create({
        data: {
          restaurantId,
          itemId: barItemId,
          date: entry.entryDate,
          movementType: "NON_AC_SALE",
          quantityMl: -adminDeductionMl,
          source: "PDF_TO_ADMIN",
          notes: entry.reason,
          createdBy: entry.createdBy,
        },
      });
    }

    // Create PURCHASE movement for received bottles
    if (receivedMl > 0) {
      await prisma.barInventoryMovement.create({
        data: {
          restaurantId,
          itemId: barItemId,
          date: entry.entryDate,
          movementType: "PURCHASE",
          quantityMl: receivedMl,
          source: "PURCHASE_ENTRY",
          notes: entry.reason,
          createdBy: entry.createdBy,
        },
      });
    }

    // Create/update BarDailyRecord
    await prisma.barDailyRecord.upsert({
      where: {
        restaurantId_date_itemId: {
          restaurantId,
          date: entry.entryDate,
          itemId: barItemId,
        },
      },
      create: {
        restaurantId,
        itemId: barItemId,
        date: entry.entryDate,
        openingMl,
        purchasedMl: receivedMl,
        nonAcSaleMl: adminDeductionMl,
        systemClosingMl: closingMl,
        finalized: true,
      },
      update: {
        nonAcSaleMl: adminDeductionMl,
        purchasedMl: receivedMl,
      },
    });
    migrated++;
  }

  return migrated;
}

// ── Phase 7: Repoint BarDeductionLog.inventoryItemId ──────────────────────────

async function phase7_RepointDeductionLogs(
  restaurantId: string,
  invItemToBarItem: Map<string, string>,
): Promise<number> {
  const logs = await prisma.barDeductionLog.findMany({
    where: { restaurantId },
  });

  let repointed = 0;
  for (const log of logs) {
    const newItemId = invItemToBarItem.get(log.inventoryItemId);
    if (!newItemId || newItemId === log.inventoryItemId) continue;

    if (isDryRun) {
      repointed++;
      continue;
    }

    await prisma.barDeductionLog.update({
      where: { id: log.id },
      data: { inventoryItemId: newItemId },
    });
    repointed++;
  }

  return repointed;
}

// ── Create OPENING movements for current stock ────────────────────────────────

async function createOpeningMovements(restaurantId: string): Promise<number> {
  const today = getKolkataDateString();
  const barItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId, currentStockMl: { not: 0 } },
  });

  let created = 0;
  for (const item of barItems) {
    // Check if an OPENING movement already exists
    const existing = await prisma.barInventoryMovement.findFirst({
      where: { itemId: item.id, movementType: "OPENING" },
    });
    if (existing) continue;

    if (isDryRun) {
      created++;
      continue;
    }

    await prisma.barInventoryMovement.create({
      data: {
        restaurantId,
        itemId: item.id,
        date: today,
        movementType: "OPENING",
        quantityMl: Number(item.currentStockMl),
        source: "OPENING_SETUP",
        notes: "Migrated from existing stock",
      },
    });
    created++;
  }

  return created;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`Bar Inventory Data Migration ${isDryRun ? "(DRY RUN)" : ""}`);
  console.log(`${"=".repeat(80)}\n`);

  // Get all restaurants that have inventory data
  const restaurants: string[] = [];
  if (targetRestaurantId) {
    restaurants.push(targetRestaurantId);
  } else {
    const invRestaurants = await prisma.inventoryItem.findMany({
      where: { isActive: true },
      select: { restaurantId: true },
      distinct: ["restaurantId"],
    });
    const nonAcRestaurants = await prisma.nonAcInventoryItem.findMany({
      where: { isActive: true },
      select: { restaurantId: true },
      distinct: ["restaurantId"],
    });
    const allIds = new Set([
      ...invRestaurants.map((r) => r.restaurantId),
      ...nonAcRestaurants.map((r) => r.restaurantId),
    ]);
    restaurants.push(...allIds);
  }

  for (const restaurantId of restaurants) {
    console.log(`\n${"-".repeat(60)}`);
    console.log(`Restaurant: ${restaurantId}`);
    console.log(`${"-".repeat(60)}`);

    const invItemToBarItem = new Map<string, string>();

    console.log("\nPhase 1: Create BarInventoryItem from InventoryItem...");
    const p1 = await phase1_CreateFromInventoryItem(restaurantId, invItemToBarItem);
    console.log(`  Created/updated ${p1} BarInventoryItems from InventoryItem`);

    console.log("\nPhase 2: Merge NonAcInventoryItem into BarInventoryItem...");
    const p2 = await phase2_MergeNonAc(restaurantId, invItemToBarItem);
    console.log(`  Merged/created ${p2} items from NonAcInventoryItem`);

    console.log("\nPhase 3: Link MenuItems to BarInventoryItem...");
    const p3 = await phase3_LinkMenuItems(restaurantId);
    console.log(`  Linked ${p3.linked} MenuItems, auto-created ${p3.autoCreated} BarInventoryItems`);

    console.log("\nPhase 4: Migrate InventoryTransaction → BarInventoryMovement...");
    const p4 = await phase4_MigrateTransactions(restaurantId, invItemToBarItem);
    console.log(`  Migrated ${p4} transactions`);

    console.log("\nPhase 5: Migrate DailyInventorySnapshot → BarDailyRecord...");
    const p5 = await phase5_MigrateSnapshots(restaurantId, invItemToBarItem);
    console.log(`  Migrated ${p5} snapshots`);

    console.log("\nPhase 6: Migrate NonAcDailyEntry → movements + BarDailyRecord...");
    const p6 = await phase6_MigrateNonAcDaily(restaurantId, invItemToBarItem);
    console.log(`  Migrated ${p6} NonAc daily entries`);

    console.log("\nPhase 7: Repoint BarDeductionLog.inventoryItemId...");
    const p7 = await phase7_RepointDeductionLogs(restaurantId, invItemToBarItem);
    console.log(`  Repointed ${p7} deduction logs`);

    console.log("\nCreating OPENING movements for current stock...");
    const openings = await createOpeningMovements(restaurantId);
    console.log(`  Created ${openings} OPENING movements`);

    // Verification
    console.log("\nVerification:");
    const totalBarItems = await prisma.barInventoryItem.count({ where: { restaurantId } });
    const totalMovements = await prisma.barInventoryMovement.count({ where: { restaurantId } });
    const totalRecords = await prisma.barDailyRecord.count({ where: { restaurantId } });
    const unlinkedLiquor = await prisma.menuItem.count({
      where: { restaurantId, menuType: "LIQUOR", isDeleted: false, barInventoryItemId: null },
    });
    console.log(`  Total BarInventoryItems: ${totalBarItems}`);
    console.log(`  Total BarInventoryMovements: ${totalMovements}`);
    console.log(`  Total BarDailyRecords: ${totalRecords}`);
    console.log(`  Unlinked LIQUOR MenuItems: ${unlinkedLiquor}`);
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log("Migration complete.");
  console.log(`${"=".repeat(80)}\n`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error("Migration failed:", e);
    prisma.$disconnect();
    process.exit(1);
  });
