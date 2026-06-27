import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { settleOrderService } from '../orderService';

// Mock auditLog so tests don't need the full lib setup
vi.mock('../../lib/auditLog', () => ({
  createAuditLog: vi.fn(),
}));

describe('orderService', () => {
  it('settleOrderService validates input parameters', async () => {
    await expect(
      settleOrderService({
        orderId: 'order-123',
        restaurantId: '',
        paymentMethod: 'CASH',
      })
    ).rejects.toThrow('restaurantId is required');
  });

  it('settleOrderService requires payment method', async () => {
    await expect(
      settleOrderService({
        orderId: 'order-123',
        restaurantId: 'rest-123',
        paymentMethod: '',
      })
    ).rejects.toThrow('paymentMethod is required');
  });
});
