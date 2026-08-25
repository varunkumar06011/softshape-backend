// ─────────────────────────────────────────────────────────────────────────────
// generateBarMappings.ts — Auto-generate BarItemMapping records for all liquor
// menu items by matching menu item names to inventory item names, using the
// SAME matching logic as the live deduction path (barMatching.ts).
//
// For each menu item variant (price), creates one BarItemMapping row:
//   menuItemId + variantPrice → primaryInvId (+ optional secondaryInvId), mlPerUnit
//
// Run dry:   npx ts-node --compiler-options '{"module":"CommonJS"}' dev-scripts/generateBarMappings.ts
// Apply:     set APPLY = true below, re-run.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient, Prisma } from "@prisma/client";
import {
  buildInventoryByName,
  buildDualVariantMap,
  findInventoryForOrderedItem,
  computeMlPerUnit,
} from "../src/utils/barMatching";

const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";

const APPLY = true; // false = dry run (print only)

// Manual aliases: menu item name → inventory item name (for spelling variants
// the fuzzy matcher can't catch).
const MANUAL_ALIASES: Record<string, string> = {
  "thumsup 250 ml": "Thums Up 250ML",
  "thumsup 600 ml": "Thums Up 650ml",
  "thumsup 740ml": "Thums Up 650ml",
  "thumsup 1ltr": "Thums Up 650ml",
  "tin thums up": "Thums Up 250ML",
  "coca cola 250 ml": "Coca Cola 250ml",
  "mazza 250ml": "Maaza 250ml",
  "vat69 750ml": "Vat 69",
  "vat69 180ml": "Vat 69",
  "vat69 375ml": "Vat 69",
  "royal stag 750ml": "Royal Stag 30ml",
  "royal stag 180ml": "Royal Stag 30ml",
  "royal stag 375ml": "Royal Stag 30ml",
  "morpheus 180ml": "Morpheus 30ml",
  "morpheus 750ml": "Morpheus 30ml",
  "morpheus 375ml": "Morpheus 30ml",
  "smirnoff orange vodka 180ml": "Smirnoff Orange Vodka 30ml",
  "smirnoff orange vodka 750ml": "Smirnoff Orange Vodka 30ml",
  "dewars 30ml": "Dewars",
  "napoleon green 750ml": "Courrier Napoleon Green",
  "bp 750ml": "Blenders Pride 30ml",
  "bp 180ml": "Blenders Pride 30ml",
  "b10 whisky 750ml": "Sterling B10 30ml",
  "b7 whisky 750ml": "Sterling B7 30ml",
  "im whisky 750ml": "Imperial Blue",
  "im whisky 180ml": "Imperial Blue",
  "im whisky 375ml": "Imperial Blue",
  "teachers 750ml": "Teacher Higland",
  "teachers 50 30ml": "Teacher Higland",
  "cnb red 750ml": "Courrier Napoleon Red",
  "cnb red 180ml": "Courrier Napoleon Red",
  "cnb green 750ml": "Courrier Napoleon Green",
  "cnb green 180ml": "Courrier Napoleon Green",
};

// Parse ml from a name like "X 30Ml" / "X 750ml" / "X 250 Ml". Returns null if none.
function mlFromName(name: string): number | null {
  const m = name.match(/(\d+)\s*ml/i);
  return m ? parseInt(m[1], 10) : null;
}

async function main() {
  console.log(`Generating BarItemMappings for ${RESTAURANT_ID}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const allInventoryItems = await prisma.inventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    include: { menuItem: { include: { variants: true } } },
  });

  const inventoryByName = buildInventoryByName(allInventoryItems);
  const dualVariantMap = buildDualVariantMap(inventoryByName);

  const liquorMenuItems = await prisma.menuItem.findMany({
    where: {
      restaurantId: RESTAURANT_ID,
      menuType: "LIQUOR",
      isAvailable: true,
    },
    include: { variants: true },
  });

  // Existing mappings to skip duplicates
  const existing = await prisma.barItemMapping.findMany({
    where: { restaurantId: RESTAURANT_ID },
    select: { menuItemId: true, variantPrice: true },
  });
  const existingKeys = new Set(existing.map((e) => `${e.menuItemId}:${Number(e.variantPrice)}`));

  let matched = 0;
  let unmatched = 0;
  let created = 0;
  let skippedExisting = 0;
  const unmatchedNames: string[] = [];

  for (const mi of liquorMenuItems) {
    const variants = (mi as any).variants as Array<{ name: string; price: any }>;
    if (!variants || variants.length === 0) continue;

    // Manual alias first, then fuzzy matcher
    const aliasTarget = MANUAL_ALIASES[mi.name.toLowerCase().trim()];
    let primary: any = null;
    let secondary: any = null;

    if (aliasTarget) {
      primary = inventoryByName.get(aliasTarget.toLowerCase()) ?? null;
      if (primary) {
        console.log(`  [alias] "${mi.name}" → "${aliasTarget}"`);
      }
    }
    if (!primary) {
      const found = findInventoryForOrderedItem(
        mi.name,
        inventoryByName,
        dualVariantMap,
        "[MapGen]",
        () => {}
      );
      primary = found.primary;
      secondary = found.secondary;
    }

    if (!primary) {
      unmatched++;
      unmatchedNames.push(mi.name);
      continue;
    }

    matched++;
    const menuMl = mlFromName(mi.name);

    for (const v of variants) {
      const price = Number(v.price);
      const key = `${mi.id}:${price}`;
      if (existingKeys.has(key)) {
        skippedExisting++;
        continue;
      }

      // ml per unit priority:
      //   1. variant name digits (e.g. "30ml", "650ml")
      //   2. menu item name digits (e.g. "Royal Challenge 30Ml")
      //   3. computeMlPerUnit fallback (beer → 650, other → bottleSize)
      const variantMl = mlFromName(String(v.name));
      let mlPerUnit: number;
      if (variantMl && variantMl > 0) {
        mlPerUnit = variantMl;
      } else if (menuMl && menuMl > 0) {
        mlPerUnit = menuMl;
      } else {
        const computed = computeMlPerUnit(primary, price, mi.name, "[MapGen]", () => {});
        mlPerUnit = computed.mlPerUnit;
      }

      console.log(
        `  ${mi.name} @ ₹${price} (${v.name}) → ${primary.menuItem?.name} | ${mlPerUnit}ml/unit${secondary ? ` | spill: ${secondary.menuItem?.name}` : ""}`
      );

      if (APPLY) {
        await prisma.barItemMapping.create({
          data: {
            restaurantId: RESTAURANT_ID,
            menuItemId: mi.id,
            variantPrice: new Prisma.Decimal(price),
            primaryInvId: primary.id,
            secondaryInvId: secondary?.id ?? null,
            mlPerUnit: new Prisma.Decimal(mlPerUnit),
          },
        });
        created++;
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`Menu items matched:   ${matched}`);
  console.log(`Menu items unmatched: ${unmatched}`);
  console.log(`Variants skipped (already mapped): ${skippedExisting}`);
  if (APPLY) console.log(`Mappings created: ${created}`);
  console.log(`========================================`);

  if (unmatchedNames.length > 0) {
    console.log(`\nUnmatched menu items (need manual mapping):`);
    unmatchedNames.forEach((n) => console.log(`  - ${n}`));
  }

  if (!APPLY) console.log(`\nDRY RUN — no changes. Set APPLY = true to write.`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
