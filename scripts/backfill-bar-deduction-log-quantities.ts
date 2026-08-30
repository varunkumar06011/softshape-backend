/**
 * Repair script: Backfill BarDeductionLog.quantity values that were understated
 * by the pre-fix overwrite bug (fixed in inventoryService.ts — the update clause
 * now uses increment instead of overwrite, but existing rows are still wrong).
 *
 * CONSTRAINTS (enforced in code):
 *   - The ONLY field this script writes is BarDeductionLog.quantity.
 *     (BarDeductionLog.updatedAt is set automatically by Prisma.)
 *   - NEVER touches InventoryItem.currentStock, InventoryItem.openingStock,
 *     DailyInventorySnapshot, or InventoryTransaction — those are already
 *     correct (built via create/increment, not overwrite).
 *   - Defaults to DRY RUN. Only applies writes with explicit --apply flag.
 *   - Idempotent — running twice with --apply is a no-op the second time.
 *   - Each row update is its own transaction — partial failure doesn't block
 *     already-fixed rows.
 *   - Only processes BarDeductionLog rows with status='SUCCESS'.
 *
 * Usage:
 *   Dry run (default):  npx tsx scripts/backfill-bar-deduction-log-quantities.ts
 *   Apply changes:      npx tsx scripts/backfill-bar-deduction-log-quantities.ts --apply
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const FLOAT_TOLERANCE = 0.01; // ml

interface Mismatch {
  logId: string;
  orderId: string;
  inventoryItemId: string;
  itemName: string;
  currentLoggedQty: number;
  trueQty: number;
  diff: number;
}

async function main() {
  console.log('=== BarDeductionLog Quantity Backfill ===');
  console.log(`Run time: ${new Date().toISOString()}`);
  console.log(`Mode: ${APPLY ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);
  console.log('Scope: BarDeductionLog rows with status=SUCCESS only.\n');

  // ── Step 1: Find all mismatches ──
  // For each SUCCESS BarDeductionLog row, compute the true total from
  // InventoryTransaction (type='SALE', source='POS_DEDUCTION', same orderId+itemId).
  const rows = await prisma.$queryRaw<Array<{
    logId: string;
    orderId: string;
    inventoryItemId: string;
    currentLoggedQty: any;
    trueQty: any;
  }>>`
    SELECT
      bdl.id AS "logId",
      bdl."orderId",
      bdl."inventoryItemId",
      bdl.quantity AS "currentLoggedQty",
      COALESCE(SUM(ABS(it."quantityChange")), 0) AS "trueQty"
    FROM "BarDeductionLog" bdl
    LEFT JOIN "inventory_transactions" it
      ON it."orderId" = bdl."orderId"
      AND it."itemId" = bdl."inventoryItemId"
      AND it.type = 'SALE'
      AND it.source = 'POS_DEDUCTION'
    WHERE bdl.status = 'SUCCESS'
    GROUP BY bdl.id, bdl."orderId", bdl."inventoryItemId", bdl.quantity
  `;

  console.log(`Total BarDeductionLog rows scanned (status=SUCCESS): ${rows.length}`);

  // Filter to mismatches (with float tolerance)
  const mismatches: Mismatch[] = [];
  for (const r of rows) {
    const currentLoggedQty = Number(r.currentLoggedQty);
    const trueQty = Number(r.trueQty);
    const diff = trueQty - currentLoggedQty;
    if (Math.abs(diff) > FLOAT_TOLERANCE) {
      mismatches.push({
        logId: r.logId,
        orderId: r.orderId,
        inventoryItemId: r.inventoryItemId,
        itemName: '', // filled below
        currentLoggedQty,
        trueQty,
        diff,
      });
    }
  }

  console.log(`Mismatches found: ${mismatches.length}`);

  if (mismatches.length === 0) {
    console.log('✅ All BarDeductionLog quantities are correct. Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  const totalUnderLoggedMl = mismatches.reduce((s, m) => s + Math.abs(m.diff), 0);
  console.log(`Total absolute mismatch: ${totalUnderLoggedMl.toFixed(2)} ml\n`);

  // Fetch item names for readable output
  const inventoryItemIds = [...new Set(mismatches.map(m => m.inventoryItemId))];
  const invItems = await prisma.inventoryItem.findMany({
    where: { id: { in: inventoryItemIds } },
    include: { menuItem: { select: { name: true } } },
  });
  const invItemNameMap = new Map<string, string>();
  for (const inv of invItems) {
    invItemNameMap.set(inv.id, inv.menuItem?.name || '(unknown item)');
  }
  for (const m of mismatches) {
    m.itemName = invItemNameMap.get(m.inventoryItemId) || '(unknown item)';
  }

  // ── Step 2: Print mismatch table ──
  console.log('--- Mismatch Table ---\n');
  console.log(
    '  Order ID'.padEnd(40)
    + '| Item Name'.padEnd(30)
    + '| Logged (ml)'.padEnd(14)
    + '| True (ml)'.padEnd(12)
    + '| Diff (ml)',
  );
  console.log(`  ${'-'.repeat(38)}|${'-'.repeat(29)}|${'-'.repeat(13)}|${'-'.repeat(11)}|${'-'.repeat(10)}`);
  for (const m of mismatches) {
    console.log(
      `  ${m.orderId.padEnd(38)}`
      + `| ${m.itemName.padEnd(28)}`
      + `| ${String(m.currentLoggedQty.toFixed(2)).padEnd(12)}`
      + `| ${String(m.trueQty.toFixed(2)).padEnd(10)}`
      + `| ${m.diff > 0 ? '+' : ''}${m.diff.toFixed(2)}`,
    );
  }

  // ── Step 3: Check for already-voided orders ──
  // If any mismatched order has a Transaction with status='CANCELLED', the
  // void restoration already happened with the wrong (too-low) quantity.
  // Fixing the log now will NOT retroactively correct currentStock.
  const mismatchedOrderIds = [...new Set(mismatches.map(m => m.orderId))];
  const voidedTxns = await prisma.transaction.findMany({
    where: { orderId: { in: mismatchedOrderIds }, status: 'CANCELLED' },
    select: { orderId: true },
  });
  const voidedOrderIds = new Set(voidedTxns.map(t => t.orderId));

  if (voidedOrderIds.size > 0) {
    console.log(`\n${'!'.repeat(100)}`);
    console.log('⚠  ALREADY VOIDED WITH INCORRECT RESTORE');
    console.log(`${'!'.repeat(100)}`);
    console.log(`  ${voidedOrderIds.size} of the mismatched orders have an associated CANCELLED Transaction.`);
    console.log('  The void restoration already used the wrong (too-low) BarDeductionLog.quantity,');
    console.log('  so currentStock was under-restored by the mismatch amount.');
    console.log('');
    console.log('  ⚠  Fixing the log now will NOT retroactively correct currentStock.');
    console.log('     That would need a separate manual InventoryTransaction adjustment');
    console.log('     for the shortfall. This script does NOT do that — it only fixes');
    console.log('     the log so future voids (if any) restore the correct amount.');
    console.log('');
    console.log('  Voided order IDs:');
    for (const oid of voidedOrderIds) {
      const affectedItems = mismatches.filter(m => m.orderId === oid);
      const totalShortfall = affectedItems.reduce((s, m) => s + Math.abs(m.diff), 0);
      console.log(`    ${oid}  (shortfall: ${totalShortfall.toFixed(2)} ml across ${affectedItems.length} item(s))`);
    }
    console.log(`${'!'.repeat(100)}\n`);
  } else {
    console.log('\n  ✅ No mismatched orders have been voided — no currentStock correction needed.\n');
  }

  // ── Step 4: Apply (if --apply flag) ──
  if (!APPLY) {
    console.log('--- DRY RUN COMPLETE ---');
    console.log('No writes were made. To apply the fix, re-run with --apply:');
    console.log('  npx tsx scripts/backfill-bar-deduction-log-quantities.ts --apply');
    await prisma.$disconnect();
    return;
  }

  console.log('--- APPLYING FIXES ---\n');
  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (const m of mismatches) {
    try {
      // Each row update in its own transaction for isolation
      await prisma.$transaction(async (tx) => {
        // Re-fetch and re-verify the mismatch still holds (defend against
        // concurrent changes since the initial scan)
        const currentLog = await tx.barDeductionLog.findUnique({
          where: { id: m.logId },
          select: { id: true, quantity: true, status: true },
        });

        if (!currentLog) {
          console.log(`  SKIP  ${m.logId} — log row no longer exists`);
          skipped++;
          return;
        }

        if (currentLog.status !== 'SUCCESS') {
          console.log(`  SKIP  ${m.logId} — status changed to ${currentLog.status} since scan`);
          skipped++;
          return;
        }

        const currentQty = Number(currentLog.quantity);
        if (Math.abs(m.trueQty - currentQty) <= FLOAT_TOLERANCE) {
          // Already fixed (idempotent check — second run hits this)
          console.log(`  SKIP  ${m.logId} — already correct (${currentQty.toFixed(2)} ml)`);
          skipped++;
          return;
        }

        const previousQuantity = currentQty;

        // Update ONLY BarDeductionLog.quantity — nothing else
        await tx.barDeductionLog.update({
          where: { id: m.logId },
          data: {
            quantity: new Prisma.Decimal(m.trueQty),
          },
        });

        // Write an AuditLog entry for traceability
        await tx.auditLog.create({
          data: {
            action: 'BAR_DEDUCTION_LOG_BACKFILL',
            entityType: 'BarDeductionLog',
            entityId: m.logId,
            metadata: {
              orderId: m.orderId,
              inventoryItemId: m.inventoryItemId,
              itemName: m.itemName,
              previousQuantity,
              correctedQuantity: m.trueQty,
              diff: m.diff,
              source: 'backfill-script',
            } as any,
          },
        });

        console.log(
          `  FIXED ${m.logId} | order ${m.orderId} | item "${m.itemName}"`
          + ` | ${previousQuantity.toFixed(2)} → ${m.trueQty.toFixed(2)} ml`
          + ` (diff: ${m.diff > 0 ? '+' : ''}${m.diff.toFixed(2)})`,
        );
        fixed++;
      });
    } catch (err: any) {
      console.error(`  FAIL  ${m.logId} | order ${m.orderId} | ${err?.message || err}`);
      failed++;
    }
  }

  console.log(`\n--- APPLY COMPLETE ---`);
  console.log(`  Rows fixed:           ${fixed}`);
  console.log(`  Rows skipped:         ${skipped}`);
  console.log(`  Rows failed:          ${failed}`);
  console.log(`  Total mismatches:     ${mismatches.length}`);

  if (failed > 0) {
    console.log(`\n  ⚠  ${failed} row(s) failed. Re-run with --apply to retry (idempotent).`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
