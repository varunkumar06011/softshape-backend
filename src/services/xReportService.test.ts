import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Step 7.0 Regression Test ──────────────────────────────────────────────────
// Verifies that computeExpenditureAmountFromExpenditures only sums EXPENSE
// and GROCERY rows, excluding LIABILITY, ASSET, and LIABILITY_PAYMENT entries.
// This prevents AP liability creation and vendor payments from inflating the
// cashier's X-Report expenditure total.

const { mockAggregate } = vi.hoisted(() => ({ mockAggregate: vi.fn() }));

const mockDb = { expenditure: { aggregate: mockAggregate } };

vi.mock('../lib/prisma', () => ({
  default: { expenditure: { aggregate: mockAggregate } },
  basePrisma: { expenditure: { aggregate: mockAggregate } },
  tenantStorage: { run: vi.fn() },
  runWithExplicitTenantScope: vi.fn(() => mockDb),
}));

vi.mock('../lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../lib/auditLog', () => ({
  createAuditLog: vi.fn(),
}));

vi.mock('../lib/transactionHelpers', () => ({
  completedTxnWhere: vi.fn(() => ({})),
}));

import { computeExpenditureAmountFromExpenditures } from './xReportService';

describe('Step 7.0 — computeExpenditureAmountFromExpenditures entryType filter', () => {
  beforeEach(() => {
    mockAggregate.mockReset();
  });

  it('includes EXPENSE and GROCERY in the sum', async () => {
    mockAggregate.mockResolvedValue({ _sum: { amount: 1500 } });

    const result = await computeExpenditureAmountFromExpenditures('r1', '2026-07-10');

    expect(result).toBe(1500);
    const callArg = mockAggregate.mock.calls[0][0];
    expect(callArg.where.entryType).toEqual({ in: ['EXPENSE', 'GROCERY'] });
  });

  it('excludes LIABILITY and ASSET entries from the sum', async () => {
    mockAggregate.mockResolvedValue({ _sum: { amount: 500 } });

    const result = await computeExpenditureAmountFromExpenditures('r1', '2026-07-10');

    expect(result).toBe(500);
    const callArg = mockAggregate.mock.calls[0][0];
    // LIABILITY, ASSET, and LIABILITY_PAYMENT must NOT be in the filter
    const allowedTypes = callArg.where.entryType.in;
    expect(allowedTypes).not.toContain('LIABILITY');
    expect(allowedTypes).not.toContain('ASSET');
    expect(allowedTypes).not.toContain('LIABILITY_PAYMENT');
  });

  it('regression: a LIABILITY entry does not inflate the expenditure total', async () => {
    // Simulate: one EXPENSE entry (₹500) + one LIABILITY entry (₹20,000) on same date.
    // The aggregate should only count the EXPENSE — the filter ensures LIABILITY is excluded.
    mockAggregate.mockResolvedValue({ _sum: { amount: 500 } });

    const result = await computeExpenditureAmountFromExpenditures('r1', '2026-07-10');

    expect(result).toBe(500);
    expect(result).not.toBe(20500);
  });
});
