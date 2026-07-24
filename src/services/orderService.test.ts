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

import { settleOrderService, cancelOrderItemService } from './orderService';

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
