// ─────────────────────────────────────────────────────────────────────────────
// Backfill: link unlinked LIQUOR menu items → BarInventoryItem
// ─────────────────────────────────────────────────────────────────────────────
// Three-way split per unlinked LIQUOR menu item:
//   1. Name matches an existing BarInventoryItem        → link it.
//   2. Looks like a drink but no inventory SKU exists    → auto-create the item
//      (0 stock; admin sets opening via the UI).
//   3. Clearly NOT a drink (charges, food, equipment)    → menuType → FOOD,
//      so it stops appearing as liquor and never deducts.
//
//   npx ts-node backfill-bar-links.ts           — dry run (report only)
//   npx ts-node backfill-bar-links.ts --apply   — write changes
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import { normalizeProductBaseName, parseMlFromName, ensureInventoryForLiquorMenuItem } from "./src/utils/barMatching";
import { BAR_UNIT_ML } from "./src/utils/barConstants";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

// Conservative non-drink detector — only obvious non-liquor words.
const NOT_DRINK = /\b(charge|projector|projecter|chicken|tandoori|tangadi|kabab|kebab|drums?|bones?|egg|hall)\b/i;

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (writes)" : "DRY RUN"}\n`);

  const unlinked = await prisma.menuItem.findMany({
    where: { menuType: "LIQUOR", barInventoryItemId: null, isAvailable: true },
    select: { id: true, name: true, restaurantId: true, deductionMl: true },
    orderBy: [{ restaurantId: "asc" }, { name: "asc" }],
  });
  console.log(`Unlinked available LIQUOR menu items: ${unlinked.length}\n`);

  const invCache = new Map<string, any[]>();
  const invFor = async (rid: string) => {
    if (!invCache.has(rid)) {
      invCache.set(rid, await prisma.barInventoryItem.findMany({
        where: { restaurantId: rid, isActive: true },
        select: { id: true, name: true, brand: true, bottleSizeMl: true },
      }));
    }
    return invCache.get(rid)!;
  };

  let linked = 0, created = 0, retyped = 0;
  const junk: any[] = [];
  const createdNames: string[] = [];

  for (const mi of unlinked) {
    // ── Bucket 3: obvious non-liquor → retype to FOOD ──
    if (NOT_DRINK.test(mi.name || "")) {
      if (APPLY) {
        await prisma.menuItem.update({ where: { id: mi.id }, data: { menuType: "FOOD" } });
      }
      retyped++;
      junk.push({ name: mi.name, rid: mi.restaurantId.slice(-6) });
      continue;
    }

    const normalized = normalizeProductBaseName(mi.name || "").toLowerCase().trim();
    const menuMl = parseMlFromName(mi.name);
    const candidates = await invFor(mi.restaurantId);

    // ── Bucket 1: match existing inventory (prefer same bottle size) ──
    const nameMatch = (inv: any) =>
      normalizeProductBaseName(inv.name || "").toLowerCase().trim() === normalized ||
      normalizeProductBaseName(inv.brand || "").toLowerCase().trim() === normalized;
    const exact = candidates.find((inv) => nameMatch(inv) && menuMl != null && Number(inv.bottleSizeMl) === menuMl)
      || candidates.find(nameMatch);

    if (exact) {
      if (APPLY) {
        await prisma.menuItem.update({
          where: { id: mi.id },
          data: { barInventoryItemId: exact.id, deductionMl: mi.deductionMl ?? menuMl ?? BAR_UNIT_ML },
        });
      }
      linked++;
      continue;
    }

    // ── Bucket 2: drink-like, no SKU → auto-create (0 stock) ──
    if (APPLY) {
      const r = await ensureInventoryForLiquorMenuItem(prisma, mi.id, mi.restaurantId, mi.name);
      if (r.inventoryItemId) {
        invCache.delete(mi.restaurantId); // refresh candidates next iteration
        if (r.created) { created++; createdNames.push(`${mi.name} [..${mi.restaurantId.slice(-6)}]`); }
        else if (r.mapped) linked++;
      } else {
        console.log(`  !! failed to create for "${mi.name}": ${r.error}`);
      }
    } else {
      created++;
      createdNames.push(`${mi.name} [..${mi.restaurantId.slice(-6)}]`);
    }
  }

  console.log(`Linked to existing SKU:        ${linked}`);
  console.log(`Auto-created new SKU (0 stk):  ${created}${APPLY ? "" : " (would create)"}`);
  console.log(`Re-typed to FOOD (non-liquor): ${retyped}${APPLY ? "" : " (would retype)"}`);

  if (junk.length) {
    console.log("\n── Re-typed to FOOD ──");
    for (const j of junk) console.log(`  ${j.name} [..${j.rid}]`);
  }
  if (createdNames.length && !APPLY) {
    console.log("\n── Would auto-create ──");
    for (const c of createdNames) console.log(`  ${c}`);
  }
  if (!APPLY) console.log("\nDry run only — pass --apply to write.");
}

main()
  .catch((e) => { console.error("FATAL:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
