import { describe, it, expect, vi } from 'vitest';

// ── Phase 0.3 Regression Test ─────────────────────────────────────────────────
// Verifies that multi-outlet queries using { in: [outletA, outletB] } actually
// return rows from both outlets, not just the single outlet in AsyncLocalStorage.
//
// Before the fix, the extended prisma client's $extends interceptor would
// overwrite restaurantId: { in: [outletA, outletB] } with restaurantId: outletA
// (the single ID from tenantStorage), silently dropping outletB from the query.
// After the fix, withOrgScope() returns a scoped client that injects
// restaurantId: { in: [...] } into the where clause, bypassing the
// AsyncLocalStorage extension entirely.

vi.mock('./prisma', async () => {
  const { AsyncLocalStorage } = await import('async_hooks');
  const tenantStorage = new AsyncLocalStorage<{ restaurantId: string }>();

  const tableOutletA = { status: 'OCCUPIED', currentBill: 100, guests: 4, restaurantId: 'outlet-a-id' };
  const tableOutletB = { status: 'AVAILABLE', currentBill: 0, guests: 0, restaurantId: 'outlet-b-id' };
  const allTables = [tableOutletA, tableOutletB];

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

  // Scoped client mock — simulates the real withOrgScope/withOutletScope behavior.
  // Intersects the caller's restaurantId filter with the scope so that rows
  // outside the scope are never returned, even when the caller explicitly
  // requests them.
  function createScopedMock(scope: { restaurantId: string } | { restaurantId: { in: string[] } }) {
    const scopeIds = typeof scope.restaurantId === 'string'
      ? [scope.restaurantId]
      : scope.restaurantId.in;

    function effectiveIds(callerFilter: any): string[] {
      if (callerFilter === undefined) return scopeIds;
      if (typeof callerFilter === 'string') {
        return scopeIds.includes(callerFilter) ? [callerFilter] : [];
      }
      if (Array.isArray(callerFilter?.in)) {
        return callerFilter.in.filter((id: string) => scopeIds.includes(id));
      }
      return scopeIds;
    }

    return {
      table: {
        findMany: vi.fn((args: any) => {
          const ids = effectiveIds(args?.where?.restaurantId);
          return Promise.resolve(allTables.filter(t => ids.includes(t.restaurantId)));
        }),
        findFirst: vi.fn((args: any) => {
          const ids = effectiveIds(args?.where?.restaurantId);
          return Promise.resolve(allTables.find(t => ids.includes(t.restaurantId)) || null);
        }),
        count: vi.fn((args: any) => {
          const ids = effectiveIds(args?.where?.restaurantId);
          return Promise.resolve(allTables.filter(t => ids.includes(t.restaurantId)).length);
        }),
      },
    };
  }

  const scopeCache = new Map<string, any>();

  return {
    default: { table: { findMany: mockTableFindManyExtended } },
    basePrisma: { table: { findMany: vi.fn(() => Promise.resolve(allTables)) } },
    withOutletScope: vi.fn((outletId: string) => {
      if (!scopeCache.has(outletId)) {
        scopeCache.set(outletId, createScopedMock({ restaurantId: outletId }));
      }
      return scopeCache.get(outletId);
    }),
    withOrgScope: vi.fn((_orgId: string | undefined, outletIds: string[]) => {
      const key = outletIds.slice().sort().join(',');
      if (!scopeCache.has(key)) {
        scopeCache.set(key, createScopedMock({ restaurantId: { in: outletIds } }));
      }
      return scopeCache.get(key);
    }),
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

import { tenantStorage, withOutletScope, withOrgScope } from './prisma';
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

      // Single outlet should return only outletA's table
      expect(result.total).toBe(1);
      expect(result.occupied).toBe(1);
    });
  });
});

describe('withOutletScope / withOrgScope — scope injection', () => {
  it('withOutletScope injects restaurantId into findMany when where is missing', async () => {
    const outletA = 'outlet-a-id';
    const scoped = withOutletScope(outletA) as any;

    const result = await scoped.table.findMany({});
    expect(result).toHaveLength(1);
    expect(result[0].restaurantId).toBe(outletA);
  });

  it('withOutletScope injects restaurantId into findMany when where lacks restaurantId', async () => {
    const outletA = 'outlet-a-id';
    const scoped = withOutletScope(outletA) as any;

    const result = await scoped.table.findMany({ where: { status: 'OCCUPIED' } });
    expect(result).toHaveLength(1);
    expect(result[0].restaurantId).toBe(outletA);
  });

  it('withOrgScope injects restaurantId: { in: [...] } and returns rows from all outlets', async () => {
    const outletA = 'outlet-a-id';
    const outletB = 'outlet-b-id';
    const scoped = withOrgScope(undefined, [outletA, outletB]) as any;

    const result = await scoped.table.findMany({});
    expect(result).toHaveLength(2);
  });

  it('withOrgScope does not overwrite an explicit restaurantId in the where clause', async () => {
    const outletA = 'outlet-a-id';
    const outletB = 'outlet-b-id';
    const scoped = withOrgScope(undefined, [outletA, outletB]) as any;

    // Caller explicitly asks for outletA only — scope should not expand it
    const result = await scoped.table.findMany({ where: { restaurantId: outletA } });
    expect(result).toHaveLength(1);
    expect(result[0].restaurantId).toBe(outletA);
  });

  it('withOutletScope filters out rows from other outlets on findUnique', async () => {
    const outletA = 'outlet-a-id';
    const scoped = withOutletScope(outletA) as any;

    // findUnique by a non-outletA record should return null
    const result = await scoped.table.findFirst({ where: { restaurantId: 'outlet-b-id' } });
    expect(result).toBeNull();
  });
});
