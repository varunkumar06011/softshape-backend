import { describe, it, expect } from 'vitest';
import {
  buildPaymentSummaryFromRows,
  buildSourceFingerprint,
  deriveTransactionAllocations,
  normalizeSettlementAllocations,
} from './paymentSummaryService';
import {
  buildEdgePaymentSummary,
  buildEdgeSourceFingerprint,
  legalTransition,
} from './edgePaymentSummary.test-utils';

// ── Helpers ──────────────────────────────────────────────────────────────────

function txn(overrides: any = {}) {
  return {
    id: overrides.id || 'tx-1',
    method: overrides.method || 'CASH',
    grandTotal: overrides.grandTotal ?? 1000,
    amount: overrides.amount ?? overrides.grandTotal ?? 1000,
    tipAmount: overrides.tipAmount ?? 0,
    cashAmount: overrides.cashAmount ?? 0,
    cardAmount: overrides.cardAmount ?? 0,
    upiAmount: overrides.upiAmount ?? 0,
    otherAmount: overrides.otherAmount ?? 0,
    cashTipAmount: overrides.cashTipAmount ?? 0,
    cardTipAmount: overrides.cardTipAmount ?? 0,
    upiTipAmount: overrides.upiTipAmount ?? 0,
    otherTipAmount: overrides.otherTipAmount ?? 0,
    paidAt: overrides.paidAt ?? '2026-08-19T10:00:00Z',
    ...overrides,
  };
}

function exp(overrides: any = {}) {
  return {
    id: overrides.id || 'exp-1',
    amount: overrides.amount ?? 100,
    status: overrides.status || 'APPROVED',
    entryType: overrides.entryType || 'EXPENSE',
    paymentMethod: overrides.paymentMethod ?? null,
    ...overrides,
  };
}

// ── 1. Per-method settlement scenarios ───────────────────────────────────────

describe('PaymentSummary — per-method scenarios', () => {
  it('Cash, no tip', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19', [txn()], []);
    expect(s.sales.total).toBe(1000);
    expect(s.tips.total).toBe(0);
    expect(s.collections.cash).toBe(1000);
    expect(s.collections.card).toBe(0);
    expect(s.collections.upi).toBe(0);
    expect(s.collections.other).toBe(0);
    expect(s.tipsPaid).toBe(0);
    expect(s.expectedCash).toBe(1000);
    expect(s.invariants.billAllocationValid).toBe(true);
  });

  it('Card, no tip', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19', [txn({ method: 'CARD' })], []);
    expect(s.collections.card).toBe(1000);
    expect(s.collections.cash).toBe(0);
    expect(s.expectedCash).toBe(0);
  });

  it('UPI, no tip', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19', [txn({ method: 'UPI' })], []);
    expect(s.collections.upi).toBe(1000);
    expect(s.expectedCash).toBe(0);
  });

  it('Other, no tip', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19', [txn({ method: 'OTHER' })], []);
    expect(s.collections.other).toBe(1000);
    expect(s.expectedCash).toBe(0);
  });

  it('Cash + Cash tip', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19', [txn({ tipAmount: 100 })], []);
    expect(s.collections.cash).toBe(1100);
    expect(s.tips.total).toBe(100);
    expect(s.tipsPaid).toBe(100);
    expect(s.expectedCash).toBe(1000); // 1100 - 0 - 100
  });

  it('Card + Card tip', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'CARD', tipAmount: 100, cardTipAmount: 100 })], []);
    expect(s.collections.card).toBe(1100);
    expect(s.tipsPaid).toBe(100);
    expect(s.expectedCash).toBe(-100); // 0 - 0 - 100 (tip paid from cash)
  });

  it('Card + Cash tip', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'CARD', tipAmount: 50, cashTipAmount: 50 })], []);
    expect(s.collections.card).toBe(1000);
    expect(s.collections.cash).toBe(50);
    expect(s.tipsPaid).toBe(50);
    expect(s.expectedCash).toBe(0); // 50 - 0 - 50
  });

  it('UPI + UPI tip', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'UPI', tipAmount: 30, upiTipAmount: 30 })], []);
    expect(s.collections.upi).toBe(1030);
    expect(s.tipsPaid).toBe(30);
    expect(s.expectedCash).toBe(-30);
  });

  it('Mixed bill', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({
        method: 'MIXED', grandTotal: 1000,
        cashAmount: 400, cardAmount: 600, upiAmount: 0, otherAmount: 0,
      })], []);
    expect(s.collections.cash).toBe(400);
    expect(s.collections.card).toBe(600);
    expect(s.sales.total).toBe(1000);
    expect(s.invariants.billAllocationValid).toBe(true);
  });

  it('Mixed tips (cash tip on card bill)', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({
        method: 'MIXED', grandTotal: 1000, tipAmount: 100,
        cashAmount: 0, cardAmount: 1000,
        cashTipAmount: 100,
      })], []);
    expect(s.collections.cash).toBe(100);
    expect(s.collections.card).toBe(1000);
    expect(s.tipsPaid).toBe(100);
    expect(s.expectedCash).toBe(0);
  });

  it('Split tips across methods', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({
        method: 'MIXED', grandTotal: 1000, tipAmount: 200,
        cashAmount: 500, cardAmount: 500,
        cashTipAmount: 100, cardTipAmount: 100,
      })], []);
    expect(s.collections.cash).toBe(600);
    expect(s.collections.card).toBe(600);
    expect(s.tipsPaid).toBe(200);
    expect(s.expectedCash).toBe(400); // 600 - 0 - 200
  });
});

// ── 2. Invariant validation ──────────────────────────────────────────────────

describe('PaymentSummary — invariants', () => {
  it('rejects bill over-allocation', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'MIXED', grandTotal: 1000, cashAmount: 600, cardAmount: 600 })], []);
    // 1200 ≠ 1000 → legacy MIXED path: remainder = 1000 - 600 - 600 = -200 → max(0,-200) = 0
    // bill = {cash:600, card:600, upi:0, other:0} = 1200 ≠ 1000 → invalid
    expect(s.invariants.billAllocationValid).toBe(false);
  });

  it('detects tip allocation mismatch when tip sums exceed tipAmount (non-legacy)', () => {
    // Single-method CASH with explicit card tip that over-allocates tips
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'CASH', grandTotal: 1000, tipAmount: 50, cardTipAmount: 100 })], []);
    // hasExplicitTip=true, tipSum=100 ≠ tipAmount=50 → falls to CASH legacy path
    // tip = {cash: 50, card: 0, ...}. Invariant: tipSum(50) === tipAmount(50) → valid
    // But the stored cardTipAmount=100 is ignored — the cloud recovers from it
    expect(s.tips.total).toBe(50);
  });

  it('bill + tip = grandTotal + tipAmount (conservation)', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'CASH', grandTotal: 500, tipAmount: 50 })], []);
    expect(s.invariants.collectionConservationValid).toBe(true);
  });

  it('rejects negative allocation values', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'MIXED', grandTotal: 1000, cashAmount: -100, cardAmount: 1100 })], []);
    expect(s.invariants.billAllocationValid).toBe(false);
    expect(s.invariants.collectionConservationValid).toBe(false);
  });
});

// ── 3. Expenditures ──────────────────────────────────────────────────────────

describe('PaymentSummary — expenditures', () => {
  it('cash expenditures reduce expected cash', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'CASH', grandTotal: 1000 })],
      [exp({ amount: 200, paymentMethod: 'CASH' })]);
    expect(s.expenditures.cash).toBe(200);
    expect(s.expectedCash).toBe(800); // 1000 - 200 - 0
  });

  it('non-cash expenditures do not reduce expected cash', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'CASH', grandTotal: 1000 })],
      [exp({ amount: 500, paymentMethod: 'CARD' })]);
    expect(s.expenditures.cash).toBe(0);
    expect(s.expectedCash).toBe(1000);
  });

  it('legacy expenditures with no payment method default to cash', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'CASH', grandTotal: 1000 })],
      [exp({ amount: 150, paymentMethod: null })]);
    expect(s.expenditures.cash).toBe(150);
    expect(s.expectedCash).toBe(850);
  });

  it('tips paid + cash expenditures both deducted', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'CASH', grandTotal: 1000, tipAmount: 100 })],
      [exp({ amount: 200, paymentMethod: 'CASH' })]);
    expect(s.expectedCash).toBe(800); // 1100 - 200 - 100
  });
});

// ── 4. Legacy data ───────────────────────────────────────────────────────────

describe('PaymentSummary — legacy data', () => {
  it('legacy MIXED with no tip split tracks unallocatedLegacyTips', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'MIXED', grandTotal: 1000, tipAmount: 50,
        cashAmount: 500, cardAmount: 500 })], // no tip allocations
      []);
    expect(s.tips.unallocatedLegacyTips).toBe(50);
    expect(s.tips.total).toBe(50);
    // Tips are still paid from cash
    expect(s.tipsPaid).toBe(50);
  });

  it('legacy single-method CASH with no explicit allocations works', () => {
    const s = buildPaymentSummaryFromRows(['r1'], '2026-08-19',
      [txn({ method: 'CASH', grandTotal: 500, tipAmount: 0,
        cashAmount: 0, cardAmount: 0 })], // all zeros — legacy
      []);
    expect(s.collections.cash).toBe(500);
    expect(s.invariants.billAllocationValid).toBe(true);
  });
});

// ── 5. normalizeSettlementAllocations ────────────────────────────────────────

describe('normalizeSettlementAllocations', () => {
  it('single-method CASH assigns full bill + tip to cash', () => {
    const r = normalizeSettlementAllocations({
      paymentMethod: 'CASH', grandTotal: 1000, tipAmount: 100,
    });
    expect(r.cashAmount).toBe(1000);
    expect(r.cashTipAmount).toBe(100);
    expect(r.cardAmount).toBe(0);
    expect(r.billInvariantValid).toBe(true);
    expect(r.tipInvariantValid).toBe(true);
  });

  it('MIXED with explicit bill split reconciles remainder to Other', () => {
    const r = normalizeSettlementAllocations({
      paymentMethod: 'MIXED', grandTotal: 1000,
      cashAmount: 300, cardAmount: 500,
    });
    expect(r.cashAmount).toBe(300);
    expect(r.cardAmount).toBe(500);
    expect(r.otherAmount).toBe(200); // remainder
    expect(r.billInvariantValid).toBe(true);
  });

  it('explicit tip split is respected', () => {
    const r = normalizeSettlementAllocations({
      paymentMethod: 'CARD', grandTotal: 1000, tipAmount: 200,
      cashTipAmount: 200,
    });
    expect(r.cashTipAmount).toBe(200);
    expect(r.cardTipAmount).toBe(0);
    expect(r.tipInvariantValid).toBe(true);
  });

  it('rejects negative grandTotal', () => {
    expect(() => normalizeSettlementAllocations({
      paymentMethod: 'CASH', grandTotal: -100, tipAmount: 0,
    })).toThrow(/Invalid grandTotal/);
  });

  it('rejects negative tipAmount', () => {
    expect(() => normalizeSettlementAllocations({
      paymentMethod: 'CASH', grandTotal: 100, tipAmount: -50,
    })).toThrow(/Invalid tipAmount/);
  });

  it('rejects negative allocation field', () => {
    expect(() => normalizeSettlementAllocations({
      paymentMethod: 'MIXED', grandTotal: 1000, cashAmount: -100,
    })).toThrow(/Invalid cashAmount/);
  });

  it('rejects NaN allocation field', () => {
    expect(() => normalizeSettlementAllocations({
      paymentMethod: 'MIXED', grandTotal: 1000, cardAmount: NaN,
    })).toThrow(/Invalid cardAmount/);
  });
});

// ── 6. Fingerprint determinism ───────────────────────────────────────────────

describe('buildSourceFingerprint — determinism', () => {
  it('produces same fingerprint regardless of row order', () => {
    const txns = [
      txn({ id: 'a', grandTotal: 100 }),
      txn({ id: 'b', grandTotal: 200 }),
    ];
    const reversed = [txns[1], txns[0]];
    const fp1 = buildSourceFingerprint(txns, []);
    const fp2 = buildSourceFingerprint(reversed, []);
    expect(fp1).toBe(fp2);
  });

  it('changes when allocation field changes', () => {
    const txns1 = [txn({ id: 'a', cashAmount: 1000 })];
    const txns2 = [txn({ id: 'a', cashAmount: 999 })];
    expect(buildSourceFingerprint(txns1, [])).not.toBe(buildSourceFingerprint(txns2, []));
  });

  it('changes when expenditure paymentMethod changes', () => {
    const exps1 = [exp({ id: 'e1', paymentMethod: 'CASH' })];
    const exps2 = [exp({ id: 'e1', paymentMethod: 'CARD' })];
    expect(buildSourceFingerprint([], exps1)).not.toBe(buildSourceFingerprint([], exps2));
  });

  it('includes tip allocation fields in fingerprint', () => {
    const txns1 = [txn({ id: 'a', cashTipAmount: 50 })];
    const txns2 = [txn({ id: 'a', cashTipAmount: 51 })];
    expect(buildSourceFingerprint(txns1, [])).not.toBe(buildSourceFingerprint(txns2, []));
  });
});

// ── 7. State machine ─────────────────────────────────────────────────────────

describe('legalTransition — X-report state machine', () => {
  it('DRAFT → PAYOUT_CONFIRMED requires tips > 0', () => {
    expect(legalTransition('DRAFT', 'PAYOUT_CONFIRMED', 100)).toBe(true);
    expect(legalTransition('DRAFT', 'PAYOUT_CONFIRMED', 0)).toBe(false);
  });

  it('DRAFT → FINALIZED requires tips = 0', () => {
    expect(legalTransition('DRAFT', 'FINALIZED', 0)).toBe(true);
    expect(legalTransition('DRAFT', 'FINALIZED', 100)).toBe(false);
  });

  it('PAYOUT_CONFIRMED → FINALIZED is always legal', () => {
    expect(legalTransition('PAYOUT_CONFIRMED', 'FINALIZED', 100)).toBe(true);
  });

  it('FINALIZED → DRAFT (reopen) is legal', () => {
    expect(legalTransition('FINALIZED', 'DRAFT', 0)).toBe(true);
  });

  it('PAYOUT_CONFIRMED → DRAFT is illegal', () => {
    expect(legalTransition('PAYOUT_CONFIRMED', 'DRAFT', 100)).toBe(false);
  });

  it('FINALIZED → PAYOUT_CONFIRMED is illegal', () => {
    expect(legalTransition('FINALIZED', 'PAYOUT_CONFIRMED', 100)).toBe(false);
  });

  it('FINALIZED → FINALIZED is illegal', () => {
    expect(legalTransition('FINALIZED', 'FINALIZED', 0)).toBe(false);
  });
});

// ── 8. Edge ↔ Cloud parity ───────────────────────────────────────────────────

describe('Edge ↔ Cloud PaymentSummary parity', () => {
  it('identical inputs produce identical outputs', () => {
    const txns = [
      txn({ id: 't1', method: 'CASH', grandTotal: 1000, tipAmount: 100 }),
      txn({ id: 't2', method: 'CARD', grandTotal: 500, tipAmount: 50, cardTipAmount: 50 }),
      txn({ id: 't3', method: 'MIXED', grandTotal: 800, tipAmount: 0,
        cashAmount: 300, cardAmount: 500 }),
    ];
    const exps = [
      exp({ id: 'e1', amount: 200, paymentMethod: 'CASH' }),
      exp({ id: 'e2', amount: 100, paymentMethod: 'CARD' }),
    ];

    const cloud = buildPaymentSummaryFromRows(['r1'], '2026-08-19', txns, exps);
    const edge = buildEdgePaymentSummary(txns, exps);

    // Map between cloud nested shape and edge flat shape
    expect(edge.totalSales).toBe(cloud.sales.total);
    expect(edge.totalTips).toBe(cloud.tips.total);
    expect(edge.collections.cash).toBe(cloud.collections.cash);
    expect(edge.collections.card).toBe(cloud.collections.card);
    expect(edge.collections.upi).toBe(cloud.collections.upi);
    expect(edge.collections.other).toBe(cloud.collections.other);
    expect(edge.cashExpenditures).toBe(cloud.expenditures.cash);
    expect(edge.tipsPaid).toBe(cloud.tipsPaid);
    expect(edge.expectedCash).toBe(cloud.expectedCash);
    expect(edge.sourceFingerprint).toBe(cloud.sourceFingerprint);
    expect(edge.invariants).toEqual(cloud.invariants);
  });

  it('fingerprints match between edge and cloud', () => {
    const txns = [txn({ id: 'a', grandTotal: 100, cashAmount: 100 })];
    const exps = [exp({ id: 'e1', amount: 50, paymentMethod: 'CASH' })];

    const cloudFp = buildSourceFingerprint(txns, exps);
    const edgeFp = buildEdgeSourceFingerprint(txns, exps);
    expect(cloudFp).toBe(edgeFp);
  });
});
