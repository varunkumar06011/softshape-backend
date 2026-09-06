// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY diagnostic: why doesn't the movement ledger reproduce currentStock?
// ─────────────────────────────────────────────────────────────────────────────
// For every BarInventoryItem it compares:
//   stored currentStockMl
//   vs  earliest OPENING movement + sum(all other movements)
//   vs  last old dailyInventorySnapshot closing + old transactions after it
// and reports per-item divergence causes:
//   A) sale movements dated BEFORE the first OPENING
//   B) no OPENING movement at all
//   C) movement count vs old inventoryTransaction count (duplication check)
//   D) old snapshot closing vs ledger total
//
// Purely SELECT queries — no writes.
//   npx ts-node diagnose-bar-ledger.ts
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const items = await prisma.barInventoryItem.findMany({
    select: { id: true, restaurantId: true, name: true, brand: true, currentStockMl: true, createdAt: true },
  });
  console.log(`Items: ${items.length}\n`);

  const stats = {
    noMovements: 0,
    noOpening: 0,
    salesBeforeOpening: 0,
    ledgerMatchesStock: 0,
    ledgerDiverges: 0,
  };
  const samples: any[] = [];

  for (const item of items) {
    const movements = await prisma.barInventoryMovement.findMany({
      where: { itemId: item.id },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      select: { id: true, date: true, movementType: true, quantityMl: true, source: true, createdAt: true },
    });
    if (movements.length === 0) { stats.noMovements++; continue; }

    const opening = movements.filter((m) => m.movementType === "OPENING");
    const firstOpening = opening[0];
    const firstDate = movements[0].date;

    if (!firstOpening) stats.noOpening++;

    // Movements dated before the first OPENING date
    const beforeOpening = firstOpening
      ? movements.filter((m) => m.date < firstOpening.date && m.movementType !== "OPENING")
      : [];
    if (beforeOpening.length > 0) stats.salesBeforeOpening++;

    // Ledger-implied stock — replay the engine's real semantics: per date,
    // OPENING movements override the carried opening; everything else is a
    // signed delta. Days without movements carry forward.
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
        .reduce((s, x) => s + Number(x.quantityMl), 0);
    }
    const ledgerStock = prevClosing;
    const openingMl = firstOpening ? Number(firstOpening.quantityMl) : 0;

    const stored = Number(item.currentStockMl);
    const diverges = Math.round(ledgerStock) !== Math.round(stored);
    diverges ? stats.ledgerDiverges++ : stats.ledgerMatchesStock++;

    // Count by type
    const byType: Record<string, { n: number; ml: number }> = {};
    for (const m of movements) {
      byType[m.movementType] = byType[m.movementType] || { n: 0, ml: 0 };
      byType[m.movementType].n++;
      byType[m.movementType].ml += Number(m.quantityMl);
    }

    samples.push({
      name: `${item.brand ?? ""} ${item.name}`.trim(),
      rid: item.restaurantId.slice(-6),
      itemCreated: item.createdAt.toISOString().slice(0, 10),
      stored,
      ledgerStock: Math.round(ledgerStock),
      delta: Math.round(ledgerStock - stored),
      firstDate,
      openingDate: firstOpening?.date ?? "-",
      openingMl,
      mvBeforeOpening: beforeOpening.length,
      mvCount: movements.length,
      byType,
      diverges,
    });
  }

  console.log("── Summary ──────────────────────────────────────────────");
  console.log(`  items with no movements at all:        ${stats.noMovements}`);
  console.log(`  items with no OPENING movement:        ${stats.noOpening}`);
  console.log(`  items with movements BEFORE opening:   ${stats.salesBeforeOpening}`);
  console.log(`  ledger == stored stock:                ${stats.ledgerMatchesStock}`);
  console.log(`  ledger != stored stock:                ${stats.ledgerDiverges}`);

  // Detail: 8 largest divergences + 3 matching items for contrast
  const diverging = samples.filter((s) => s.diverges).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const matching = samples.filter((s) => !s.diverges).slice(0, 3);
  console.log("\n── Top diverging items ──────────────────────────────────");
  for (const s of diverging.slice(0, 8)) {
    console.log(`\n${s.name} [..${s.rid}] itemCreated=${s.itemCreated}`);
    console.log(`  stored=${s.stored}  ledger=${s.ledgerStock}  Δ=${s.delta}`);
    console.log(`  firstMovement=${s.firstDate}  openingDate=${s.openingDate}  openingMl=${s.openingMl}  movementsBeforeOpening=${s.mvBeforeOpening}  totalMovements=${s.mvCount}`);
    console.log(`  byType: ${JSON.stringify(s.byType)}`);
  }
  console.log("\n── Matching items (sanity) ──────────────────────────────");
  for (const s of matching) {
    console.log(`  ${s.name}: stored=${s.stored} ledger=${s.ledgerStock} movements=${s.mvCount} opening=${s.openingDate}/${s.openingMl}`);
  }

  // Compare vs OLD tables for the worst item
  if (diverging[0]) {
    const worst = items.find((i) => `${i.brand ?? ""} ${i.name}`.trim() === diverging[0].name && i.restaurantId.endsWith(diverging[0].rid));
    if (worst) {
      console.log(`\n── Old-table comparison for "${diverging[0].name}" ──────`);
      const oldItem = await prisma.inventoryItem.findFirst({
        where: { restaurantId: worst.restaurantId, menuItem: { name: { contains: diverging[0].name.split(" ").pop()!, mode: "insensitive" } } },
        select: { id: true, currentStock: true, menuItem: { select: { name: true } } },
      });
      if (oldItem) {
        const oldTxnCount = await prisma.inventoryTransaction.count({ where: { itemId: oldItem.id } });
        const oldSnapshots = await prisma.dailyInventorySnapshot.findMany({
          where: { itemId: oldItem.id }, orderBy: { snapshotDate: "desc" }, take: 3,
          select: { snapshotDate: true, openingStock: true, closingStock: true, purchased: true, sold: true },
        });
        console.log(`  old item id=${oldItem.id}  old currentStock=${oldItem.currentStock}  old txn count=${oldTxnCount}`);
        for (const s of oldSnapshots) console.log(`  old snapshot ${s.snapshotDate}: opening=${s.openingStock} purchased=${s.purchased} sold=${s.sold} closing=${s.closingStock}`);
      } else {
        console.log("  no matching old inventoryItem found");
      }
      const dedup = await prisma.barDeductionLog.count({ where: { inventoryItemId: worst.id } });
      console.log(`  barDeductionLog rows for this item: ${dedup}`);
    }
  }
}

main()
  .catch((e) => { console.error("FATAL:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
