// ─────────────────────────────────────────────────────────────────────────────
// Rebuild ALL BarDailyRecords from the movement ledger (one-off repair)
// ─────────────────────────────────────────────────────────────────────────────
// Purpose: heal any daily records that were computed before the CORRECTION
// sign fix (corrections on AC_SALE / NON_AC_SALE / WASTAGE were applied with
// the wrong sign). Daily records are derived from movements — rewriting them
// is safe and idempotent.
//
// For every BarInventoryItem:
//   1. Find the earliest movement date.
//   2. sequentialRebuild from that date through today.
//   3. Log currentStockMl before/after so you can see what changed.
//
// Usage:
//   npx ts-node rebuild-bar-records.ts            — dry run (report only)
//   npx ts-node rebuild-bar-records.ts --apply    — actually rebuild
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import { sequentialRebuild } from "./src/services/barInventoryService";
import { getKolkataDateString } from "./src/utils/date";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const today = getKolkataDateString();
  console.log(`Mode: ${APPLY ? "APPLY (writes)" : "DRY RUN (report only)"} — rebuilding through ${today}\n`);

  const items = await prisma.barInventoryItem.findMany({
    select: { id: true, restaurantId: true, name: true, brand: true, currentStockMl: true },
    orderBy: { restaurantId: "asc" },
  });
  console.log(`Found ${items.length} bar inventory items\n`);

  let rebuilt = 0;
  let changed = 0;
  const diffs: any[] = [];

  for (const item of items) {
    const earliest = await prisma.barInventoryMovement.findFirst({
      where: { itemId: item.id },
      orderBy: { date: "asc" },
      select: { date: true },
    });
    const fromDate = earliest?.date;
    if (!fromDate) continue; // no history — nothing to rebuild

    const stockBefore = Number(item.currentStockMl);

    if (APPLY) {
      await prisma.$transaction(async (tx: any) => {
        await sequentialRebuild(tx, item.restaurantId, item.id, fromDate);
      });
    } else {
      // Dry run: replay the engine's real semantics — per date, OPENING
      // movements OVERRIDE the carried-forward opening; all other movements
      // apply as signed deltas. Days without movements carry forward.
      const movements = await prisma.barInventoryMovement.findMany({
        where: { itemId: item.id },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      });
      const byDate = new Map<string, typeof movements>();
      for (const m of movements) {
        const arr = byDate.get(m.date) || [];
        arr.push(m);
        byDate.set(m.date, arr);
      }
      let prevClosing = 0;
      for (const [, day] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const openings = day.filter((m) => m.movementType === "OPENING");
        const opening = openings.length ? Number(openings[openings.length - 1].quantityMl) : prevClosing;
        prevClosing = opening + day.filter((m) => m.movementType !== "OPENING")
          .reduce((s, m) => s + Number(m.quantityMl), 0);
      }
      const closing = prevClosing;
      if (Math.round(closing * 100) !== Math.round(stockBefore * 100)) {
        changed++;
        diffs.push({
          item: `${item.brand ?? ""} ${item.name}`.trim(),
          restaurantId: item.restaurantId,
          stockNow: stockBefore,
          stockRebuilt: closing,
          delta: closing - stockBefore,
        });
      }
      rebuilt++;
      continue;
    }

    const fresh = await prisma.barInventoryItem.findUnique({
      where: { id: item.id }, select: { currentStockMl: true },
    });
    const stockAfter = Number(fresh?.currentStockMl ?? 0);
    rebuilt++;
    if (Math.round(stockAfter * 100) !== Math.round(stockBefore * 100)) {
      changed++;
      diffs.push({
        item: `${item.brand ?? ""} ${item.name}`.trim(),
        restaurantId: item.restaurantId,
        stockBefore,
        stockAfter,
        delta: stockAfter - stockBefore,
      });
    }
  }

  console.log(`Processed ${rebuilt} items — ${changed} changed.\n`);
  if (diffs.length > 0) {
    console.log("Items whose closing stock differs after rebuild:");
    for (const d of diffs) {
      console.log(
        `  ${d.item} (${d.restaurantId}): ${d.stockBefore ?? d.stockNow} → ${d.stockAfter ?? d.stockRebuilt}  (Δ ${d.delta})`,
      );
    }
  } else {
    console.log("No discrepancies — all records already agree with the ledger.");
  }
}

main()
  .catch((e) => { console.error("FATAL:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
