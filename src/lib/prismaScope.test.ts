import { describe, it, expect, vi } from 'vitest';

// ── Phase 0.3 Regression Test ─────────────────────────────────────────────────
// Verifies that multi-outlet queries using { in: [outletA, outletB] } actually
// return rows from both outlets, not just the single outlet in AsyncLocalStorage.
//
// Before the fix, the extended prisma client's $extends interceptor would
// overwrite restaurantId: { in: [outletA, outletB] } with restaurantId: outletA
// (the single ID from tenantStorage), silently dropping outletB from the query.
// After the fix, withOrgScope() returns basePrisma (no interceptor), so the
// explicit { in: [...] } filter is preserved.

vi.mock('./prisma', async () => {
  const { AsyncLocalStorage } = await import('async_hooks');
  const tenantStorage = new AsyncLocalStorage<{ restaurantId: string }>();

  const tableOutletA = { status: 'OCCUPIED', currentBill: 100, guests: 4 };
  const tableOutletB = { status: 'AVAILABLE', currentBill: 0, guests: 0 };

  // Extended client mock — simulates the AsyncLocalStorage extension bug.
  // When tenantStorage has a context, it overwrites { in: [...] } with the
  // single context ID, just like the real Prisma extension does.
  const mockTableFindManyExtended = vi.fn((args: any) => {
    const ctx = tenantStorage.getStore();
    let effectiveId = args.where?.restaurantId;
    if (ctx && effectiveId) {
      // Simulate the bug: extension overwrites { in: [...] } with single ID
      effectiveId = ctx.restaurantId;
    }
    // If filter collapsed to a single string ID (bug case), return only 1 table
    if (typeof effectiveId === 'string') {
      return Promise.resolve([tableOutletA]);
    }
    // If filter is { in: [outletA, outletB] }, return both tables
    return Promise.resolve([tableOutletA, tableOutletB]);
  });

  // Base client mock — no extension, respects the explicit where clause
  const mockTableFindManyBase = vi.fn(() =>
    Promise.resolve([tableOutletA, tableOutletB]),
  );

  return {
    default: { table: { findMany: mockTableFindManyExtended } },
    basePrisma: { table: { findMany: mockTableFindManyBase } },
    withOutletScope: vi.fn(() => ({ table: { findMany: mockTableFindManyBase } })),
    withOrgScope: vi.fn(() => ({ table: { findMany: mockTableFindManyBase } })),
    tenantStorage,
  };
});

vi.mock('./logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../routes/reports', () => ({
  getDailySalesData: vi.fn(),
  getItemwiseSalesData: vi.fn(),
  getDiscountReportData: vi.fn(),
}));

import { tenantStorage } from './prisma';
import { getFloorStatus } from '../services/spire/fetchers';

describe('Phase 0.3 — Multi-outlet tenant scoping regression', () => {
  it('getFloorStatus with [outletA, outletB] returns rows from both outlets even when AsyncLocalStorage has outletA', async () => {
    const outletA = 'outlet-a-id';
    const outletB = 'outlet-b-id';

    // Simulate the withTenantContext middleware setting context to outletA.
    // Before the fix, the extended prisma client would overwrite
    // { in: [outletA, outletB] } with just outletA, silently dropping
    // outletB's tables from the result.
    await tenantStorage.run({ restaurantId: outletA }, async () => {
      const result = await getFloorStatus([outletA, outletB]);

      // Must include tables from both outlets (2 tables, not 1)
      expect(result.total).toBe(2);
      expect(result.occupied).toBe(1);
      expect(result.available).toBe(1);
    });
  });

  it('getFloorStatus with a single outlet still works correctly', async () => {
    const outletA = 'outlet-a-id';

    await tenantStorage.run({ restaurantId: outletA }, async () => {
      const result = await getFloorStatus([outletA]);

      // Single outlet should return both mock tables (base client doesn't filter)
      // This verifies the fix doesn't break single-outlet queries
      expect(result.total).toBe(2);
    });
  });
});
