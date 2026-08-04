import { describe, it, expect, vi } from 'vitest';

// ── T2: Tests for settlement/cancellation paths ──────────────────────────────
// Validates that the settle and cancel service functions correctly reject
// invalid inputs, enforce tenant boundaries, and handle edge cases.

vi.mock('./prisma', () => ({
  default: {
    order: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    orderItem: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    table: {
      update: vi.fn(),
    },
    transaction: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: vi.fn((fn: any) => fn({})),
  },
  basePrisma: {
    order: { findUnique: vi.fn() },
  },
}));

vi.mock('./logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./cache', () => ({
  getRedisClient: vi.fn(() => null),
  isCacheReady: vi.fn(() => false),
  cacheMiddleware: vi.fn(() => (req: any, res: any, next: any) => next()),
  invalidateCache: vi.fn(() => (req: any, res: any, next: any) => next()),
  cacheClear: vi.fn(),
}));

vi.mock('./socket', () => ({
  getIo: vi.fn(() => ({
    to: vi.fn(() => ({ emit: vi.fn() })),
    adapter: { sockets: vi.fn(() => Promise.resolve(new Set())) },
  })),
  setIo: vi.fn(),
}));

vi.mock('./printQueue', () => ({
  bufferPrintJob: vi.fn(() => Promise.resolve()),
  markEventIdPrinted: vi.fn(),
  markEventIdFailed: vi.fn(),
}));

vi.mock('./tenantContext', () => ({
  resolveTenantContext: vi.fn(() => Promise.resolve({
    restaurantId: 'rest-1',
    outletId: 'outlet-1',
    orgId: 'org-1',
    venueType: null,
  })),
  isBarOutlet: vi.fn(() => false),
  isVenueOutlet: vi.fn(() => false),
}));

vi.mock('../middleware/auth', () => ({
  assertOrderBelongsToTenant: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/transactionHelpers', () => ({
  getNextTxnNumber: vi.fn(() => Promise.resolve(1)),
  getNextBillNumber: vi.fn(() => Promise.resolve('BILL-001')),
  formatBillNumber: vi.fn((n: number) => `BILL-${String(n).padStart(3, '0')}`),
  upsertPendingTransaction: vi.fn(),
  upsertCancelledTransaction: vi.fn(),
  completedTxnWhere: vi.fn(),
}));

vi.mock('../lib/lock', () => ({
  acquireLock: vi.fn(() => Promise.resolve(true)),
  releaseLock: vi.fn(() => Promise.resolve()),
}));

import { settleOrderService, cancelOrderItemService, formatTableNumber, isBarLikeSection } from './orderService';

describe('T2 — Settlement path validation', () => {
  it('settleOrderService rejects missing restaurantId', async () => {
    await expect(
      settleOrderService({
        orderId: 'order-1',
        restaurantId: '',
        paymentMethod: 'CASH',
      } as any)
    ).rejects.toThrow('restaurantId is required');
  });

  it('settleOrderService rejects missing paymentMethod', async () => {
    await expect(
      settleOrderService({
        orderId: 'order-1',
        restaurantId: 'rest-1',
        paymentMethod: '',
      } as any)
    ).rejects.toThrow('paymentMethod is required');
  });
});

describe('T2 — Cancellation path validation', () => {
  it('cancelOrderItemService rejects missing orderId', async () => {
    await expect(
      cancelOrderItemService({
        orderId: '',
        restaurantId: 'rest-1',
        orderItemId: 'item-1',
        cancelledBy: 'captain-1',
      } as any)
    ).rejects.toThrow();
  });

  it('cancelOrderItemService rejects missing orderItemId', async () => {
    await expect(
      cancelOrderItemService({
        orderId: 'order-1',
        restaurantId: 'rest-1',
        orderItemId: '',
        cancelledBy: 'captain-1',
      } as any)
    ).rejects.toThrow();
  });

  it('cancelOrderItemService rejects missing cancelledBy', async () => {
    await expect(
      cancelOrderItemService({
        orderId: 'order-1',
        restaurantId: 'rest-1',
        orderItemId: 'item-1',
        cancelledBy: '',
      } as any)
    ).rejects.toThrow();
  });
});

// ── T8: formatTableNumber — legacy vs new tenant sectionTag duality ──────────
// New tenants use venueType directly; legacy tenants use sectionTag string matching.
// Both paths must produce correct table prefixes for all venue types.

describe('T8 — formatTableNumber: new tenant path (venueType set)', () => {
  it('BAR venue → B prefix', () => {
    expect(formatTableNumber(5, 'rest-1', undefined, undefined, 'BAR')).toBe('B5');
  });
  it('DINE_IN venue → T prefix', () => {
    expect(formatTableNumber(5, 'rest-1', undefined, undefined, 'DINE_IN')).toBe('T5');
  });
  it('CAFE venue → T prefix', () => {
    expect(formatTableNumber(3, 'rest-1', undefined, undefined, 'CAFE')).toBe('T3');
  });
  it('PDR venue → PDR prefix', () => {
    expect(formatTableNumber(2, 'rest-1', undefined, undefined, 'PDR')).toBe('PDR2');
  });
  it('CONFERENCE venue → C prefix', () => {
    expect(formatTableNumber(1, 'rest-1', undefined, undefined, 'CONFERENCE')).toBe('C1');
  });
  it('ROOM_SERVICE venue → R prefix', () => {
    expect(formatTableNumber(4, 'rest-1', undefined, undefined, 'ROOM_SERVICE')).toBe('R4');
  });
  it('BANQUET venue → B prefix', () => {
    expect(formatTableNumber(7, 'rest-1', undefined, undefined, 'BANQUET')).toBe('B7');
  });
  it('TAKEAWAY venue → P1', () => {
    expect(formatTableNumber(1, 'rest-1', undefined, undefined, 'TAKEAWAY')).toBe('P1');
  });
  it('DELIVERY venue → P1', () => {
    expect(formatTableNumber(1, 'rest-1', undefined, undefined, 'DELIVERY')).toBe('P1');
  });
  it('venueType takes priority over sectionTag', () => {
    // New tenant with venueType=BAR but legacy-style sectionTag — venueType wins
    expect(formatTableNumber(5, 'rest-1', 'Main Hall', 'venue-family-restaurant', 'BAR')).toBe('B5');
  });
  it('table 999 → Counter (regardless of venueType)', () => {
    expect(formatTableNumber(999, 'rest-1', undefined, undefined, 'BAR')).toBe('Counter');
  });
});

describe('T8 — formatTableNumber: legacy tenant path (sectionTag only, no venueType)', () => {
  it('venue-bar-conference → C prefix', () => {
    expect(formatTableNumber(1, 'rest-1', undefined, 'venue-bar-conference')).toBe('C1');
  });
  it('venue-bar-pdr → PDR prefix', () => {
    expect(formatTableNumber(2, 'rest-1', undefined, 'venue-bar-pdr')).toBe('PDR2');
  });
  it('venue-bar-rooms → R prefix', () => {
    expect(formatTableNumber(3, 'rest-1', undefined, 'venue-bar-rooms')).toBe('R3');
  });
  it('venue-bar-parcel → P1', () => {
    expect(formatTableNumber(1, 'rest-1', undefined, 'venue-bar-parcel')).toBe('P1');
  });
  it('venue-bar-gobox → GB prefix', () => {
    expect(formatTableNumber(1, 'rest-1', undefined, 'venue-bar-gobox')).toBe('GB1');
  });
  it('venue-family-restaurant → F prefix', () => {
    expect(formatTableNumber(5, 'rest-1', undefined, 'venue-family-restaurant')).toBe('F5');
  });
  it('venue-restaurant-parcel → P1', () => {
    expect(formatTableNumber(1, 'rest-1', undefined, 'venue-restaurant-parcel')).toBe('P1');
  });
  it('sectionTag with bar → B prefix', () => {
    expect(formatTableNumber(5, 'rest-1', undefined, 'venue-bar-ac-hall')).toBe('B5');
  });
});

describe('T8 — formatTableNumber: sectionName fallback (no venueType, no sectionTag)', () => {
  it('sectionName with conference → C prefix', () => {
    expect(formatTableNumber(1, 'rest-1', 'Conference Hall')).toBe('C1');
  });
  it('sectionName with pdr → PDR prefix', () => {
    expect(formatTableNumber(2, 'rest-1', 'PDR')).toBe('PDR2');
  });
  it('sectionName with room → R prefix', () => {
    expect(formatTableNumber(3, 'rest-1', 'Rooms')).toBe('R3');
  });
  it('sectionName with bar → B prefix', () => {
    expect(formatTableNumber(5, 'rest-1', 'Bar AC Hall')).toBe('B5');
  });
  it('sectionName with main hall → B prefix', () => {
    expect(formatTableNumber(5, 'rest-1', 'Main Hall')).toBe('B5');
  });
  it('sectionName with family restaurant → F prefix', () => {
    expect(formatTableNumber(5, 'rest-1', 'Family Restaurant')).toBe('F5');
  });
  it('sectionName with parcel → P1', () => {
    expect(formatTableNumber(1, 'rest-1', 'Parcel')).toBe('P1');
  });
  it('unknown sectionName → T prefix (default)', () => {
    expect(formatTableNumber(5, 'rest-1', 'Garden Seating')).toBe('T5');
  });
  it('no sectionName, no sectionTag, no venueType → T prefix (default)', () => {
    expect(formatTableNumber(5, 'rest-1')).toBe('T5');
  });
});

// ── T8: isBarLikeSection — legacy vs new tenant duality ──────────────────────

describe('T8 — isBarLikeSection: new tenant path (venueType set)', () => {
  it('BAR → true', () => {
    expect(isBarLikeSection(null, 'BAR')).toBe(true);
  });
  it('PDR → true', () => {
    expect(isBarLikeSection(null, 'PDR')).toBe(true);
  });
  it('CONFERENCE → true', () => {
    expect(isBarLikeSection(null, 'CONFERENCE')).toBe(true);
  });
  it('BANQUET → true', () => {
    expect(isBarLikeSection(null, 'BANQUET')).toBe(true);
  });
  it('ROOM_SERVICE → true', () => {
    expect(isBarLikeSection(null, 'ROOM_SERVICE')).toBe(true);
  });
  it('DINE_IN → false', () => {
    expect(isBarLikeSection(null, 'DINE_IN')).toBe(false);
  });
  it('CAFE → false', () => {
    expect(isBarLikeSection(null, 'CAFE')).toBe(false);
  });
  it('TAKEAWAY → false', () => {
    expect(isBarLikeSection(null, 'TAKEAWAY')).toBe(false);
  });
  it('venueType takes priority over sectionTag', () => {
    // Even if sectionTag says bar, DINE_IN venueType wins
    expect(isBarLikeSection('venue-bar-ac-hall', 'DINE_IN')).toBe(false);
  });
});

describe('T8 — isBarLikeSection: legacy tenant path (sectionTag only)', () => {
  it('venue-bar-conference → true', () => {
    expect(isBarLikeSection('venue-bar-conference')).toBe(true);
  });
  it('venue-bar-pdr → true', () => {
    expect(isBarLikeSection('venue-bar-pdr')).toBe(true);
  });
  it('venue-bar-rooms → true', () => {
    expect(isBarLikeSection('venue-bar-rooms')).toBe(true);
  });
  it('venue-bar-parcel → true', () => {
    expect(isBarLikeSection('venue-bar-parcel')).toBe(true);
  });
  it('venue-bar-gobox → true', () => {
    expect(isBarLikeSection('venue-bar-gobox')).toBe(true);
  });
  it('venue-restaurant-parcel → true', () => {
    expect(isBarLikeSection('venue-restaurant-parcel')).toBe(true);
  });
  it('venue-family-restaurant → false', () => {
    expect(isBarLikeSection('venue-family-restaurant')).toBe(false);
  });
  it('null sectionTag → false', () => {
    expect(isBarLikeSection(null)).toBe(false);
  });
  it('unknown sectionTag → false', () => {
    expect(isBarLikeSection('some-random-tag')).toBe(false);
  });
});
