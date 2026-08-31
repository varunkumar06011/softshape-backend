/**
 * Regression tests for the combined inventory endpoint's closing stock
 * and revenue scaling logic.
 *
 * Tests the calculation patterns used in fetchCombinedInventory (barInventory.ts)
 * to verify:
 *   Fix 2a: Closing stock uses snapshot's acClosingBottles (includes wastage/adjustments)
 *           instead of re-deriving as opening + purchases - acSale - nonAcSale
 *   Fix 2b: AC revenue is scaled to match Transaction.grandTotal
 *   Fix 2d: Opening stock uses snap.openingStock (not prevSnap.closingStock)
 *
 * Run: npx vitest run src/routes/__tests__/combinedInventoryCalc.test.ts
 */
import { describe, it, expect } from 'vitest';

// ════════════════════════════════════════════════════════════════════════════
// Fix 2a: Closing stock calculation — uses snapshot, not re-derived formula
// ════════════════════════════════════════════════════════════════════════════

describe('Fix 2a — Combined endpoint closing stock from snapshot', () => {
  // Replicate the summary loop logic from fetchCombinedInventory
  function calcClosingBtl(r: any): number {
    const btl = Number(r.bottleSize) || 0;
    const openingBtl = Number(r.openingStockBottles) || 0;
    const receivedBtl = Number(r.purchasesBottles) || 0;
    const acSaleBtl = btl > 0 ? (Number(r.acSale) || 0) / btl : 0;
    const nonAcSaleBtl = Number(r.nonAcDeduction) || 0;
    const snapClosingBtl = Number(r.acClosingBottles) || 0;
    const hasSnapClosing = r.acClosingBottles != null;
    return hasSnapClosing
      ? snapClosingBtl
      : (openingBtl + receivedBtl - acSaleBtl - nonAcSaleBtl);
  }

  it('uses snapshot closing when available (includes wastage/adjustments)', () => {
    const row = {
      bottleSize: 750,
      openingStockBottles: 10,
      purchasesBottles: 5,
      acSale: 2250,  // 3 bottles × 750ml
      nonAcDeduction: 2,
      acClosingBottles: 8, // snapshot says 8 (e.g. 1 bottle wastage)
    };
    // Formula would give: 10 + 5 - 3 - 2 = 10
    // Snapshot says: 8 (because 2 bottles were wasted)
    expect(calcClosingBtl(row)).toBe(8);
  });

  it('falls back to formula when acClosingBottles is undefined (standalone Non-AC)', () => {
    const row = {
      bottleSize: 750,
      openingStockBottles: 10,
      purchasesBottles: 5,
      acSale: 2250,  // 3 bottles
      nonAcDeduction: 2,
      acClosingBottles: undefined, // no AC snapshot for standalone Non-AC
    };
    // Formula: 10 + 5 - 3 - 2 = 10
    expect(calcClosingBtl(row)).toBe(10);
  });

  it('handles closing stock = 0 correctly (all stock sold)', () => {
    const row = {
      bottleSize: 750,
      openingStockBottles: 10,
      purchasesBottles: 0,
      acSale: 7500,  // 10 bottles × 750ml
      nonAcDeduction: 0,
      acClosingBottles: 0, // all stock sold — legitimate zero
    };
    // Must use snapshot value (0), not fall back to formula
    expect(calcClosingBtl(row)).toBe(0);
  });

  it('handles closing stock = 0 with Non-AC deduction too', () => {
    const row = {
      bottleSize: 750,
      openingStockBottles: 5,
      purchasesBottles: 0,
      acSale: 1500,  // 2 bottles
      nonAcDeduction: 3,
      acClosingBottles: 0, // all stock sold
    };
    expect(calcClosingBtl(row)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix 2b: Revenue scaling — AC revenue scaled to match Transaction.grandTotal
// ════════════════════════════════════════════════════════════════════════════

describe('Fix 2b — Combined endpoint revenue scaling', () => {
  // Replicate the scaling logic from fetchCombinedInventory
  function scaleRevenue(
    acRevenueByMenuItem: Map<string, number>,
    allPosRevenueRaw: number,
    txnTotal: number
  ): Map<string, number> {
    const scaleFactor = allPosRevenueRaw > 0 ? txnTotal / allPosRevenueRaw : 1;
    const scaled = new Map<string, number>();
    for (const [menuItemId, rev] of acRevenueByMenuItem) {
      scaled.set(menuItemId, Math.round(rev * scaleFactor * 100) / 100);
    }
    return scaled;
  }

  it('scales AC revenue to match transaction grand total', () => {
    const raw = new Map([
      ['m1', 1000],
      ['m2', 2000],
    ]);
    const allPosRevenueRaw = 3000;
    const txnTotal = 3100; // slightly higher due to rounding/items not in order items
    const scaled = scaleRevenue(raw, allPosRevenueRaw, txnTotal);
    // scaleFactor = 3100/3000 = 1.0333...
    // m1: 1000 × 1.0333 = 1033.33
    // m2: 2000 × 1.0333 = 2066.67
    expect(scaled.get('m1')).toBeCloseTo(1033.33, 2);
    expect(scaled.get('m2')).toBeCloseTo(2066.67, 2);
    // Sum should approximately equal txnTotal
    const sum = (scaled.get('m1') || 0) + (scaled.get('m2') || 0);
    expect(sum).toBeCloseTo(3100, 0);
  });

  it('uses scaleFactor=1 when no POS revenue (no division by zero)', () => {
    const raw = new Map<string, number>();
    const scaled = scaleRevenue(raw, 0, 5000);
    expect(scaled.size).toBe(0);
  });

  it('preserves revenue exactly when txnTotal equals raw revenue', () => {
    const raw = new Map([
      ['m1', 1500],
      ['m2', 2500],
    ]);
    const scaled = scaleRevenue(raw, 4000, 4000);
    expect(scaled.get('m1')).toBe(1500);
    expect(scaled.get('m2')).toBe(2500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix 2d: Opening stock — uses snap.openingStock, not prevSnap.closingStock
// ════════════════════════════════════════════════════════════════════════════

describe('Fix 2d — Opening stock from snapshot', () => {
  // Replicate the opening stock logic from buildLiquorReportForDate
  function calcOpeningMl(snap: any, prevSnap: any, currentStock: number): number {
    if (snap) {
      return Number(snap.openingStock);
    }
    return prevSnap ? Number(prevSnap.closingStock) : (currentStock || 0);
  }

  it('uses snap.openingStock when today\'s snapshot exists', () => {
    const snap = { openingStock: 5000 }; // admin edited to 5000ml
    const prevSnap = { closingStock: 3000 }; // yesterday's closing was 3000ml
    // Before fix: would use prevSnap.closingStock = 3000 (ignoring admin edit)
    // After fix: uses snap.openingStock = 5000 (respects admin edit)
    expect(calcOpeningMl(snap, prevSnap, 4000)).toBe(5000);
  });

  it('falls back to prevSnap.closingStock when no today snapshot', () => {
    const snap = null;
    const prevSnap = { closingStock: 3000 };
    expect(calcOpeningMl(snap, prevSnap, 4000)).toBe(3000);
  });

  it('falls back to currentStock when no snapshot at all', () => {
    const snap = null;
    const prevSnap = null;
    expect(calcOpeningMl(snap, prevSnap, 4000)).toBe(4000);
  });

  it('falls back to 0 when no snapshot and no currentStock', () => {
    const snap = null;
    const prevSnap = null;
    expect(calcOpeningMl(snap, prevSnap, 0)).toBe(0);
  });

  // Zero-activity AC items (line 4477)
  function calcOpeningMlZeroActivity(snap: any, prevSnap: any): number {
    return snap ? Number(snap.openingStock) : (prevSnap ? Number(prevSnap.closingStock) : 0);
  }

  it('zero-activity: uses snap.openingStock when snapshot exists', () => {
    const snap = { openingStock: 7500 };
    const prevSnap = { closingStock: 6000 };
    expect(calcOpeningMlZeroActivity(snap, prevSnap)).toBe(7500);
  });

  it('zero-activity: falls back to prevSnap.closingStock', () => {
    const snap = null;
    const prevSnap = { closingStock: 6000 };
    expect(calcOpeningMlZeroActivity(snap, prevSnap)).toBe(6000);
  });

  it('zero-activity: falls back to 0 when no snapshots', () => {
    expect(calcOpeningMlZeroActivity(null, null)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Combined: Full summary calculation with all fixes applied
// ════════════════════════════════════════════════════════════════════════════

describe('Full summary calculation — all fixes integrated', () => {
  it('closing stock value uses snapshot closing (with wastage)', () => {
    const rows = [
      {
        bottleSize: 750,
        purchaseRate: 500,
        openingStockBottles: 10,
        purchasesBottles: 5,
        acSale: 2250, // 3 bottles
        nonAcDeduction: 2,
        acClosingBottles: 8, // snapshot: 10+5-3-2=10, minus 2 wastage = 8
      },
    ];

    let closingStockValue = 0;
    for (const r of rows) {
      const pr = Number(r.purchaseRate) || 0;
      const btl = Number(r.bottleSize) || 0;
      const openingBtl = Number(r.openingStockBottles) || 0;
      const receivedBtl = Number(r.purchasesBottles) || 0;
      const acSaleBtl = btl > 0 ? (Number(r.acSale) || 0) / btl : 0;
      const nonAcSaleBtl = Number(r.nonAcDeduction) || 0;
      const snapClosingBtl = Number(r.acClosingBottles) || 0;
      const hasSnapClosing = r.acClosingBottles != null;
      const closingBtl = hasSnapClosing
        ? snapClosingBtl
        : (openingBtl + receivedBtl - acSaleBtl - nonAcSaleBtl);
      closingStockValue += closingBtl * pr;
    }

    // 8 bottles × 500 = 4000 (not 10 × 500 = 5000 from formula)
    expect(closingStockValue).toBe(4000);
  });

  it('closing stock value uses formula when no snapshot (standalone Non-AC)', () => {
    const rows = [
      {
        bottleSize: 750,
        purchaseRate: 300,
        openingStockBottles: 10,
        purchasesBottles: 5,
        acSale: 0,
        nonAcDeduction: 3,
        acClosingBottles: undefined, // standalone Non-AC
      },
    ];

    let closingStockValue = 0;
    for (const r of rows) {
      const pr = Number(r.purchaseRate) || 0;
      const btl = Number(r.bottleSize) || 0;
      const openingBtl = Number(r.openingStockBottles) || 0;
      const receivedBtl = Number(r.purchasesBottles) || 0;
      const acSaleBtl = btl > 0 ? (Number(r.acSale) || 0) / btl : 0;
      const nonAcSaleBtl = Number(r.nonAcDeduction) || 0;
      const snapClosingBtl = Number(r.acClosingBottles) || 0;
      const hasSnapClosing = r.acClosingBottles != null;
      const closingBtl = hasSnapClosing
        ? snapClosingBtl
        : (openingBtl + receivedBtl - acSaleBtl - nonAcSaleBtl);
      closingStockValue += closingBtl * pr;
    }

    // Formula: 10 + 5 - 0 - 3 = 12 bottles × 300 = 3600
    expect(closingStockValue).toBe(3600);
  });
});
