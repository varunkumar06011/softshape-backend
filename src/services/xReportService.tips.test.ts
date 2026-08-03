import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Tip reallocation regression tests (two-pass design) ────────────────────────
// Verifies that computePaymentBreakdownFromTransactions correctly splits
// cash/card/upi/other buckets in Pass 1 (base split, no tip math) and then
// applies eligibility-aware tip reallocation in Pass 2 (card/UPI tips move from
// cash bucket into their settlement buckets, but ONLY for eligible rows).
//
// Eligibility rule:
//   - Direct CARD/UPI: eligible. Direct CASH: not eligible.
//   - MIXED: eligible iff CASH not selected AND (CARD or UPI selected).
//     CASH+CARD, CASH+UPI, CASH+CARD+UPI → not eligible (cash-sourced tip invisible).
//     CARD+UPI (no cash) → eligible. 1-method MIXED → like direct of that method.
//     Zero-method MIXED/OTHER → not eligible.
//
// Invariant: cashSales + cardSales + upiSales + otherSales == sum(grandTotal).
// Cash tips never affect any bucket (waiter keeps them directly).

const { mockGroupBy, mockFindMany } = vi.hoisted(() => ({
  mockGroupBy: vi.fn(),
  mockFindMany: vi.fn(),
}));

// Prisma client mock: transaction.groupBy + transaction.findMany are the only
// methods exercised by the two functions under test. computePaymentBreakdownFromTransactions
// calls findMany twice (Pass 1 for MIXED rows, Pass 2 for all rows); the mock
// implementation routes based on the where.method filter.
vi.mock('../lib/prisma', () => {
  const mockPrisma = {
    transaction: {
      groupBy: mockGroupBy,
      findMany: mockFindMany,
    },
  };
  return {
    default: mockPrisma,
    basePrisma: mockPrisma,
    tenantStorage: { run: vi.fn() },
    runWithExplicitTenantScope: vi.fn(() => mockPrisma),
  };
});

vi.mock('../lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../lib/auditLog', () => ({
  createAuditLog: vi.fn(),
}));

vi.mock('../lib/transactionHelpers', () => ({
  completedTxnWhere: vi.fn(() => ({})),
}));

import { computePaymentBreakdownFromTransactions, computeTipsFromTransactions } from './xReportService';

// Helper: build a groupBy result row for a single payment method.
function groupRow(method: string, grandTotal: number, tips: { cash?: number; card?: number; upi?: number } = {}) {
  return {
    method,
    _sum: {
      grandTotal,
      amount: grandTotal,
      cashTipAmount: tips.cash ?? 0,
      cardTipAmount: tips.card ?? 0,
      upiTipAmount: tips.upi ?? 0,
    },
  };
}

// Helper: build a full transaction row (for findMany results).
function txnRow(opts: {
  method: string;
  grandTotal?: number;
  cashAmount?: number;
  cardAmount?: number;
  upiAmount?: number;
  cashTipAmount?: number;
  cardTipAmount?: number;
  upiTipAmount?: number;
}) {
  return {
    method: opts.method,
    grandTotal: opts.grandTotal ?? 0,
    amount: opts.grandTotal ?? 0,
    cashAmount: opts.cashAmount ?? null,
    cardAmount: opts.cardAmount ?? null,
    upiAmount: opts.upiAmount ?? null,
    cashTipAmount: opts.cashTipAmount ?? 0,
    cardTipAmount: opts.cardTipAmount ?? 0,
    upiTipAmount: opts.upiTipAmount ?? 0,
  };
}

// Helper: set up mocks for computePaymentBreakdownFromTransactions.
// allTxns = all transactions for the period (used by Pass 2 findMany).
// mixedTxns = only MIXED transactions (used by Pass 1 findMany). If not provided,
//             mixedTxns is derived from allTxns (filtered by method === 'MIXED').
// groupRows = the groupBy result rows. If not provided, derived from allTxns.
function setupMocks(allTxns: any[], opts: { mixedTxns?: any[]; groupRows?: any[] } = {}) {
  const mixedTxns = opts.mixedTxns ?? allTxns.filter(t => t.method === 'MIXED');
  // Build groupRows from allTxns if not provided: sum grandTotal + tips per method.
  const groupRows = opts.groupRows ?? (() => {
    const byMethod = new Map<string, { grandTotal: number; cashTip: number; cardTip: number; upiTip: number }>();
    for (const t of allTxns) {
      const m = t.method;
      if (!byMethod.has(m)) byMethod.set(m, { grandTotal: 0, cashTip: 0, cardTip: 0, upiTip: 0 });
      const e = byMethod.get(m)!;
      e.grandTotal += Number(t.grandTotal ?? 0);
      e.cashTip += Number(t.cashTipAmount ?? 0);
      e.cardTip += Number(t.cardTipAmount ?? 0);
      e.upiTip += Number(t.upiTipAmount ?? 0);
    }
    return Array.from(byMethod.entries()).map(([method, e]) => groupRow(method, e.grandTotal, { cash: e.cashTip, card: e.cardTip, upi: e.upiTip }));
  })();

  mockGroupBy.mockResolvedValue(groupRows);
  // Pass 1 findMany: where.method === 'MIXED' → return mixedTxns.
  // Pass 2 findMany: no method filter → return allTxns.
  mockFindMany.mockImplementation((args: any) => {
    if (args?.where?.method === 'MIXED') return Promise.resolve(mixedTxns);
    return Promise.resolve(allTxns);
  });
}

describe('computePaymentBreakdownFromTransactions — Pass 1 base split (no tips)', () => {
  beforeEach(() => {
    mockGroupBy.mockReset();
    mockFindMany.mockReset();
  });

  it('CASH bill: base split to cash bucket, no reallocation', async () => {
    setupMocks([txnRow({ method: 'CASH', grandTotal: 1080, cashTipAmount: 20 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(1080);
    expect(r.cardSales).toBe(0);
    expect(r.upiSales).toBe(0);
    expect(r.otherSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(1080);
  });

  it('CARD bill: base split to card bucket', async () => {
    setupMocks([txnRow({ method: 'CARD', grandTotal: 570 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(0);
    expect(r.cardSales).toBe(570);
    expect(r.upiSales).toBe(0);
    expect(r.otherSales).toBe(0);
  });

  it('UPI bill: base split to upi bucket', async () => {
    setupMocks([txnRow({ method: 'UPI', grandTotal: 400 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.upiSales).toBe(400);
    expect(r.cashSales).toBe(0);
    expect(r.cardSales).toBe(0);
  });

  it('MIXED bill with cash+card+upi: base split across all three buckets', async () => {
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 1200, cashAmount: 200, cardAmount: 500, upiAmount: 500 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(200);
    expect(r.cardSales).toBe(500);
    expect(r.upiSales).toBe(500);
    expect(r.otherSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(1200);
  });

  it('MIXED bill with zero methods selected: full amount to otherSales', async () => {
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 250, cashAmount: 0, cardAmount: 0, upiAmount: 0 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.otherSales).toBe(250);
    expect(r.cashSales).toBe(0);
    expect(r.cardSales).toBe(0);
    expect(r.upiSales).toBe(0);
  });

  it('MIXED bill with remainder routing to otherSales', async () => {
    // grandTotal 1000, cash 300, card 400, upi 100 → other = 200
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 1000, cashAmount: 300, cardAmount: 400, upiAmount: 100 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(300);
    expect(r.cardSales).toBe(400);
    expect(r.upiSales).toBe(100);
    expect(r.otherSales).toBe(200);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(1000);
  });

  it('legacy MIXED row with null upiAmount: treated as upi=0 (backward compatible)', async () => {
    const legacyRow = { method: 'MIXED', grandTotal: 1000, amount: 1000, cashAmount: 400, cardAmount: 600, upiAmount: null, cashTipAmount: 0, cardTipAmount: 0, upiTipAmount: 0 };
    setupMocks([legacyRow]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(400);
    expect(r.cardSales).toBe(600);
    expect(r.upiSales).toBe(0);
    expect(r.otherSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(1000);
  });
});

describe('computePaymentBreakdownFromTransactions — Pass 2 tip reallocation (eligibility rule)', () => {
  beforeEach(() => {
    mockGroupBy.mockReset();
    mockFindMany.mockReset();
  });

  // ── Direct transactions ──────────────────────────────────────────────────

  it('direct CASH bill with cash tip: NOT reallocated (waiter keeps it)', async () => {
    setupMocks([txnRow({ method: 'CASH', grandTotal: 1080, cashTipAmount: 20 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(1080); // unchanged
    expect(r.cardSales).toBe(0);
    expect(r.upiSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(1080);
  });

  it('direct CARD bill with card tip: reallocated (card += tip, cash -= tip)', async () => {
    setupMocks([txnRow({ method: 'CARD', grandTotal: 570, cardTipAmount: 30 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cardSales).toBe(600); // 570 + 30
    expect(r.cashSales).toBe(-30); // drawer payout
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(570);
  });

  it('direct UPI bill with upi tip: reallocated (upi += tip, cash -= tip)', async () => {
    // Example 1: Direct UPI bill 400 + UPI tip 50
    setupMocks([txnRow({ method: 'UPI', grandTotal: 400, upiTipAmount: 50 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.upiSales).toBe(450); // 400 + 50
    expect(r.cashSales).toBe(-50); // drawer payout
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(400);
  });

  // ── MIXED: CASH present → NOT eligible ────────────────────────────────────

  it('MIXED CASH+CARD with card tip: NOT reallocated (cash-sourced, invisible)', async () => {
    // Example 2: Other, CASH+CARD (400/600), tip 20 logged as cardTipAmount
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 1000, cashAmount: 400, cardAmount: 600, cardTipAmount: 20 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(400); // unchanged
    expect(r.cardSales).toBe(600); // unchanged
    expect(r.upiSales).toBe(0);
    expect(r.otherSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(1000);
  });

  it('MIXED CASH+UPI with upi tip: NOT reallocated (cash-sourced, invisible)', async () => {
    // Example 3: Other, CASH+UPI (300/500), tip 15 logged as upiTipAmount
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 800, cashAmount: 300, upiAmount: 500, upiTipAmount: 15 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(300); // unchanged
    expect(r.cardSales).toBe(0);
    expect(r.upiSales).toBe(500); // unchanged
    expect(r.otherSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(800);
  });

  it('MIXED CASH+CARD+UPI with card tip: NOT reallocated (cash present)', async () => {
    // Example 4: Other, CASH+CARD+UPI (200/500/500), tip 40 logged as cardTipAmount
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 1200, cashAmount: 200, cardAmount: 500, upiAmount: 500, cardTipAmount: 40 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(200); // unchanged
    expect(r.cardSales).toBe(500); // unchanged
    expect(r.upiSales).toBe(500); // unchanged
    expect(r.otherSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(1200);
  });

  // ── MIXED: CARD+UPI only (no cash) → eligible ─────────────────────────────

  it('MIXED CARD+UPI (no cash) with card tip: reallocated to card bucket', async () => {
    // Example 5: Other, CARD+UPI only (600/300), tip 30 logged as cardTipAmount
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 900, cashAmount: 0, cardAmount: 600, upiAmount: 300, cardTipAmount: 30 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(-30); // drawer payout
    expect(r.cardSales).toBe(630); // 600 + 30
    expect(r.upiSales).toBe(300); // unchanged
    expect(r.otherSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(900);
  });

  it('MIXED CARD+UPI (no cash) with upi tip: reallocated to upi bucket', async () => {
    // Example 6: Other, CARD+UPI only (400/500), tip 25 logged as upiTipAmount
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 900, cashAmount: 0, cardAmount: 400, upiAmount: 500, upiTipAmount: 25 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(-25); // drawer payout
    expect(r.cardSales).toBe(400); // unchanged
    expect(r.upiSales).toBe(525); // 500 + 25
    expect(r.otherSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(900);
  });

  // ── MIXED: 1-method and 0-method edge cases ──────────────────────────────

  it('MIXED with only CARD selected (no cash, no upi) + card tip: eligible (like direct CARD)', async () => {
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 500, cashAmount: 0, cardAmount: 500, upiAmount: 0, cardTipAmount: 50 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cardSales).toBe(550); // 500 + 50
    expect(r.cashSales).toBe(-50);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(500);
  });

  it('MIXED with only UPI selected (no cash, no card) + upi tip: eligible (like direct UPI)', async () => {
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 300, cashAmount: 0, cardAmount: 0, upiAmount: 300, upiTipAmount: 10 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.upiSales).toBe(310); // 300 + 10
    expect(r.cashSales).toBe(-10);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(300);
  });

  it('MIXED with only CASH selected + cash tip: NOT eligible', async () => {
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 500, cashAmount: 500, cardAmount: 0, upiAmount: 0, cashTipAmount: 15 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(500); // unchanged
    expect(r.cardSales).toBe(0);
    expect(r.upiSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(500);
  });

  it('MIXED with zero methods selected + tip: NOT eligible, bill to otherSales', async () => {
    // Example 7: Other, zero methods selected, bill 250, tip 10
    setupMocks([txnRow({ method: 'MIXED', grandTotal: 250, cashAmount: 0, cardAmount: 0, upiAmount: 0, cardTipAmount: 10 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.otherSales).toBe(250);
    expect(r.cashSales).toBe(0);
    expect(r.cardSales).toBe(0);
    expect(r.upiSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(250);
  });
});

describe('computePaymentBreakdownFromTransactions — worked examples (combined)', () => {
  beforeEach(() => {
    mockGroupBy.mockReset();
    mockFindMany.mockReset();
  });

  it('Example 8: combined day (Examples 1–7) — invariant holds across all buckets', async () => {
    const allTxns = [
      // Ex 1: Direct UPI bill 400 + UPI tip 50
      txnRow({ method: 'UPI', grandTotal: 400, upiTipAmount: 50 }),
      // Ex 2: Other CASH+CARD (400/600), tip 20 as cardTipAmount
      txnRow({ method: 'MIXED', grandTotal: 1000, cashAmount: 400, cardAmount: 600, cardTipAmount: 20 }),
      // Ex 3: Other CASH+UPI (300/500), tip 15 as upiTipAmount
      txnRow({ method: 'MIXED', grandTotal: 800, cashAmount: 300, upiAmount: 500, upiTipAmount: 15 }),
      // Ex 4: Other CASH+CARD+UPI (200/500/500), tip 40 as cardTipAmount
      txnRow({ method: 'MIXED', grandTotal: 1200, cashAmount: 200, cardAmount: 500, upiAmount: 500, cardTipAmount: 40 }),
      // Ex 5: Other CARD+UPI (600/300), tip 30 as cardTipAmount
      txnRow({ method: 'MIXED', grandTotal: 900, cashAmount: 0, cardAmount: 600, upiAmount: 300, cardTipAmount: 30 }),
      // Ex 6: Other CARD+UPI (400/500), tip 25 as upiTipAmount
      txnRow({ method: 'MIXED', grandTotal: 900, cashAmount: 0, cardAmount: 400, upiAmount: 500, upiTipAmount: 25 }),
      // Ex 7: Other zero methods, bill 250, tip 10
      txnRow({ method: 'MIXED', grandTotal: 250, cashAmount: 0, cardAmount: 0, upiAmount: 0, cardTipAmount: 10 }),
    ];
    setupMocks(allTxns);

    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');

    // Expected from the worked examples table:
    // Cash: 0 - 50 (ex1) - 30 (ex5) - 25 (ex6) = -105... wait, let me recalculate.
    // Base cash: ex2=400, ex3=300, ex4=200, ex5=0, ex6=0, ex7=0, ex1=0 → 900
    // Eligible tips: ex1 upi 50, ex5 card 30, ex6 upi 25 → totalCardTip=30, totalUpiTip=75
    // Cash: 900 - 30 - 75 = 795
    // Card: ex2=600, ex4=500, ex5=600, ex6=400 + 30 = 2130
    // UPI: ex1=400, ex3=500, ex4=500, ex5=300, ex6=500 + 75 = 2275
    // Other: ex7=250 = 250
    // Sum: 795 + 2130 + 2275 + 250 = 5450
    expect(r.cashSales).toBe(795);
    expect(r.cardSales).toBe(2130);
    expect(r.upiSales).toBe(2275);
    expect(r.otherSales).toBe(250);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(5450);
  });

  it('Example 9: direct CASH bill 1080 + cash tip 20 — excluded from Total Tips, no reallocation', async () => {
    setupMocks([txnRow({ method: 'CASH', grandTotal: 1080, cashTipAmount: 20 })]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(1080);
    expect(r.cardSales).toBe(0);
    expect(r.upiSales).toBe(0);
    expect(r.otherSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(1080);
  });

  it('combined CASH + CARD + UPI direct bills with tips: invariant holds', async () => {
    // CASH 1080 (cash tip 20), CARD 570 (card tip 30), UPI 400 (upi tip 50)
    setupMocks([
      txnRow({ method: 'CASH', grandTotal: 1080, cashTipAmount: 20 }),
      txnRow({ method: 'CARD', grandTotal: 570, cardTipAmount: 30 }),
      txnRow({ method: 'UPI', grandTotal: 400, upiTipAmount: 50 }),
    ]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    // Cash: 1080 - 30 (card tip payout) - 50 (upi tip payout) = 1000
    expect(r.cashSales).toBe(1000);
    expect(r.cardSales).toBe(600);  // 570 + 30
    expect(r.upiSales).toBe(450);   // 400 + 50
    expect(r.otherSales).toBe(0);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(2050);
  });

  it('no transactions: all buckets zero', async () => {
    setupMocks([]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    expect(r.cashSales).toBe(0);
    expect(r.cardSales).toBe(0);
    expect(r.upiSales).toBe(0);
    expect(r.otherSales).toBe(0);
  });
});

describe('computePaymentBreakdownFromTransactions — Pass 1/Pass 2 isolation', () => {
  beforeEach(() => {
    mockGroupBy.mockReset();
    mockFindMany.mockReset();
  });

  it('Pass 1 output (base split) is correct before Pass 2 adjustment — verified via no-tip rows', async () => {
    // When no tips are present, Pass 2 does nothing, so the result IS Pass 1 output.
    setupMocks([
      txnRow({ method: 'CASH', grandTotal: 500 }),
      txnRow({ method: 'CARD', grandTotal: 300 }),
      txnRow({ method: 'UPI', grandTotal: 200 }),
      txnRow({ method: 'MIXED', grandTotal: 1000, cashAmount: 400, cardAmount: 400, upiAmount: 200 }),
      txnRow({ method: 'OTHER', grandTotal: 100 }),
    ]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    // Pass 1: cash=500+400=900, card=300+400=700, upi=200+200=400, other=100
    expect(r.cashSales).toBe(900);
    expect(r.cardSales).toBe(700);
    expect(r.upiSales).toBe(400);
    expect(r.otherSales).toBe(100);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(2100);
  });

  it('Pass 2 only moves tips between buckets — total invariant preserved with tips', async () => {
    // Same as above but with tips on eligible rows.
    setupMocks([
      txnRow({ method: 'CASH', grandTotal: 500, cashTipAmount: 10 }),
      txnRow({ method: 'CARD', grandTotal: 300, cardTipAmount: 20 }),
      txnRow({ method: 'UPI', grandTotal: 200, upiTipAmount: 30 }),
      txnRow({ method: 'MIXED', grandTotal: 1000, cashAmount: 400, cardAmount: 400, upiAmount: 200, cardTipAmount: 50 }),
      txnRow({ method: 'OTHER', grandTotal: 100 }),
    ]);
    const r = await computePaymentBreakdownFromTransactions('r1', '2026-08-03');
    // Pass 1: cash=900, card=700, upi=400, other=100
    // Pass 2: MIXED has cash → not eligible. Direct CARD eligible (20), direct UPI eligible (30).
    // totalCardTip=20, totalUpiTip=30
    // Cash: 900 - 20 - 30 = 850
    // Card: 700 + 20 = 720
    // UPI: 400 + 30 = 430
    // Other: 100
    // Sum: 850 + 720 + 430 + 100 = 2100
    expect(r.cashSales).toBe(850);
    expect(r.cardSales).toBe(720);
    expect(r.upiSales).toBe(430);
    expect(r.otherSales).toBe(100);
    expect(r.cashSales + r.cardSales + r.upiSales + r.otherSales).toBe(2100);
  });
});

describe('computeTipsFromTransactions — tip split accumulation', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
  });

  it('totalTips = card + upi only (cash tips excluded)', async () => {
    mockFindMany.mockResolvedValue([
      { tipAmount: 20, cashTipAmount: 20, cardTipAmount: 0, upiTipAmount: 0, method: 'CASH' },
      { tipAmount: 30, cashTipAmount: 0, cardTipAmount: 30, upiTipAmount: 0, method: 'CARD' },
      { tipAmount: 50, cashTipAmount: 0, cardTipAmount: 0, upiTipAmount: 50, method: 'UPI' },
    ]);
    const r = await computeTipsFromTransactions('r1', '2026-08-03');
    // totalTips = 30 (card) + 50 (upi) = 80. Cash tip 20 is excluded.
    expect(r.totalTips).toBe(80);
    expect(r.cashTips).toBe(20);
    expect(r.cardTips).toBe(30);
    expect(r.upiTips).toBe(50);
  });

  it('MIXED tips: card/upi counted in totalTips regardless of combination', async () => {
    // CASH+CARD with card tip 20, CARD+UPI with card tip 30 + upi tip 25
    mockFindMany.mockResolvedValue([
      { tipAmount: 20, cashTipAmount: 0, cardTipAmount: 20, upiTipAmount: 0, method: 'MIXED' },
      { tipAmount: 55, cashTipAmount: 0, cardTipAmount: 30, upiTipAmount: 25, method: 'MIXED' },
    ]);
    const r = await computeTipsFromTransactions('r1', '2026-08-03');
    // totalTips = (20 + 0) + (30 + 25) = 75. No cash tips.
    expect(r.totalTips).toBe(75);
    expect(r.cashTips).toBe(0);
    expect(r.cardTips).toBe(50);
    expect(r.upiTips).toBe(25);
  });

  it('falls back to method-based split for legacy rows without split fields', async () => {
    mockFindMany.mockResolvedValue([
      { tipAmount: 15, cashTipAmount: 0, cardTipAmount: 0, upiTipAmount: 0, method: 'CASH' },
      { tipAmount: 25, cashTipAmount: 0, cardTipAmount: 0, upiTipAmount: 0, method: 'CARD' },
      { tipAmount: 40, cashTipAmount: 0, cardTipAmount: 0, upiTipAmount: 0, method: 'UPI' },
    ]);
    const r = await computeTipsFromTransactions('r1', '2026-08-03');
    // Legacy: CASH → cashTips, CARD → cardTips, UPI → upiTips
    // totalTips = 25 + 40 = 65 (cash excluded)
    expect(r.totalTips).toBe(65);
    expect(r.cashTips).toBe(15);
    expect(r.cardTips).toBe(25);
    expect(r.upiTips).toBe(40);
  });

  it('legacy CASH-only tip: excluded from totalTips', async () => {
    mockFindMany.mockResolvedValue([
      { tipAmount: 20, cashTipAmount: 0, cardTipAmount: 0, upiTipAmount: 0, method: 'CASH' },
    ]);
    const r = await computeTipsFromTransactions('r1', '2026-08-03');
    expect(r.totalTips).toBe(0); // cash tip excluded
    expect(r.cashTips).toBe(20); // but tracked separately
  });

  it('no transactions: all tips zero', async () => {
    mockFindMany.mockResolvedValue([]);
    const r = await computeTipsFromTransactions('r1', '2026-08-03');
    expect(r.totalTips).toBe(0);
    expect(r.cashTips).toBe(0);
    expect(r.cardTips).toBe(0);
    expect(r.upiTips).toBe(0);
  });
});
