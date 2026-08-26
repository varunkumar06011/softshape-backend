import { describe, it, expect } from 'vitest';
import resolveDateRange from './dateResolver';

// All tests use a fixed "today" of 2026-08-26 (Wednesday) so date math is
// deterministic. August 2026 has 31 days; July 2026 has 31 days.

const TODAY = '2026-08-26';

describe('resolveDateRange — existing behaviour', () => {
  it('resolves "today"', () => {
    const r = resolveDateRange("today's sales", TODAY);
    expect(r.startDate).toBe('2026-08-26');
    expect(r.endDate).toBe('2026-08-26');
  });

  it('resolves "yesterday"', () => {
    const r = resolveDateRange('yesterday sales', TODAY);
    expect(r.startDate).toBe('2026-08-25');
    expect(r.endDate).toBe('2026-08-25');
  });

  it('resolves "this week" (Sunday-start)', () => {
    const r = resolveDateRange('this week sales', TODAY);
    // 2026-08-26 is a Wednesday → week starts Sunday 2026-08-23
    expect(r.startDate).toBe('2026-08-23');
    expect(r.endDate).toBe('2026-08-29');
  });

  it('resolves "last week"', () => {
    const r = resolveDateRange('last week sales', TODAY);
    expect(r.startDate).toBe('2026-08-16');
    expect(r.endDate).toBe('2026-08-22');
  });

  it('resolves "this month"', () => {
    const r = resolveDateRange('this month sales', TODAY);
    expect(r.startDate).toBe('2026-08-01');
    expect(r.endDate).toBe('2026-08-31');
  });

  it('resolves "last month"', () => {
    const r = resolveDateRange('last month sales', TODAY);
    expect(r.startDate).toBe('2026-07-01');
    expect(r.endDate).toBe('2026-07-31');
  });

  it('resolves explicit DD-MM-YYYY', () => {
    const r = resolveDateRange('sales on 15-07-2026', TODAY);
    expect(r.startDate).toBe('2026-07-15');
    expect(r.endDate).toBe('2026-07-15');
  });

  it('defaults to today when no date expression is present', () => {
    const r = resolveDateRange('top selling items', TODAY);
    expect(r.startDate).toBe('2026-08-26');
    expect(r.endDate).toBe('2026-08-26');
  });
});

describe('resolveDateRange — "from X to today" ranges', () => {
  it('resolves "from 27th of last month to today"', () => {
    const r = resolveDateRange('What is the AOV from the 27th of last month to today?', TODAY);
    expect(r.startDate).toBe('2026-07-27');
    expect(r.endDate).toBe('2026-08-26');
  });

  it('resolves "from 27th to today" (bare day rolls back to last month since 27th > today=26th)', () => {
    const r = resolveDateRange('AOV from 27th to today', TODAY);
    expect(r.startDate).toBe('2026-07-27');
    expect(r.endDate).toBe('2026-08-26');
  });

  it('resolves "from 5th to today" (5th already passed this month)', () => {
    const r = resolveDateRange('AOV from 5th to today', TODAY);
    expect(r.startDate).toBe('2026-08-05');
    expect(r.endDate).toBe('2026-08-26');
  });

  it('resolves "27th of last month to today" without leading "from"', () => {
    const r = resolveDateRange('AOV 27th of last month to today', TODAY);
    expect(r.startDate).toBe('2026-07-27');
    expect(r.endDate).toBe('2026-08-26');
  });

  it('resolves "from 27th of this month to today" (swaps since 27th > today)', () => {
    const r = resolveDateRange('AOV from 27th of this month to today', TODAY);
    // start (27th) > end (today=26th) → swapped to 26th→27th
    expect(r.startDate).toBe('2026-08-26');
    expect(r.endDate).toBe('2026-08-27');
  });
});

describe('resolveDateRange — two explicit dates', () => {
  it('resolves "from 01-07-2026 to 15-08-2026"', () => {
    const r = resolveDateRange('sales from 01-07-2026 to 15-08-2026', TODAY);
    expect(r.startDate).toBe('2026-07-01');
    expect(r.endDate).toBe('2026-08-15');
  });

  it('swaps when start is after end', () => {
    const r = resolveDateRange('sales from 15-08-2026 to 01-07-2026', TODAY);
    expect(r.startDate).toBe('2026-07-01');
    expect(r.endDate).toBe('2026-08-15');
  });
});

describe('resolveDateRange — month boundary handling', () => {
  it('clamps day 31 in February (non-leap year)', () => {
    // base 2026-01-15 → "from 31st of last month" → December 2025 has 31 days
    const r = resolveDateRange('from 31st of last month to today', '2026-01-15');
    expect(r.startDate).toBe('2025-12-31');
  });

  it('clamps day 31 in February via last month ref', () => {
    // base 2026-03-10 → "from 31st of last month" → February 2026 (28 days) → 28th
    const r = resolveDateRange('from 31st of last month to today', '2026-03-10');
    expect(r.startDate).toBe('2026-02-28');
  });

  it('handles year boundary for last month (Jan → Dec of prev year)', () => {
    const r = resolveDateRange('last month sales', '2026-01-15');
    expect(r.startDate).toBe('2025-12-01');
    expect(r.endDate).toBe('2025-12-31');
  });
});

describe('resolveDateRange — IST conversion', () => {
  it('produces IST-aware start/end Date objects', () => {
    const r = resolveDateRange('today', TODAY);
    // startIST = 2026-08-26 00:00:00 IST = 2026-08-25 18:30:00 UTC
    expect(r.startIST.toISOString()).toBe('2026-08-25T18:30:00.000Z');
    // endIST = 2026-08-26 23:59:59.999 IST = 2026-08-26 18:29:59.999 UTC
    expect(r.endIST.toISOString()).toBe('2026-08-26T18:29:59.999Z');
  });
});

describe('resolveDateRange — additional NL variations from requirements', () => {
  it('resolves "What is the AOV from the 27th of last month to today?" with trailing ?', () => {
    const r = resolveDateRange('What is the AOV from the 27th of last month to today?', TODAY);
    expect(r.startDate).toBe('2026-07-27');
    expect(r.endDate).toBe('2026-08-26');
  });

  it('resolves "AOV from 27th to today" (no "of last month")', () => {
    const r = resolveDateRange('AOV from 27th to today', TODAY);
    expect(r.startDate).toBe('2026-07-27');
    expect(r.endDate).toBe('2026-08-26');
  });

  it('resolves "from 1st to today" as current month 1st', () => {
    const r = resolveDateRange('from 1st to today', TODAY);
    expect(r.startDate).toBe('2026-08-01');
    expect(r.endDate).toBe('2026-08-26');
  });

  it('resolves "from 31st to today" — 31st > today (26th), rolls to last month', () => {
    const r = resolveDateRange('from 31st to today', TODAY);
    expect(r.startDate).toBe('2026-07-31');
    expect(r.endDate).toBe('2026-08-26');
  });

  it('resolves "from 10th of last month to 20th of last month"', () => {
    const r = resolveDateRange('from 10th of last month to 20th of last month', TODAY);
    expect(r.startDate).toBe('2026-07-10');
    expect(r.endDate).toBe('2026-07-20');
  });

  it('resolves "from 10th of this month to 20th of this month"', () => {
    const r = resolveDateRange('from 10th of this month to 20th of this month', TODAY);
    expect(r.startDate).toBe('2026-08-10');
    expect(r.endDate).toBe('2026-08-20');
  });

  it('resolves "from start of last month to today"', () => {
    const r = resolveDateRange('from start of last month to today', TODAY);
    expect(r.startDate).toBe('2026-07-01');
    expect(r.endDate).toBe('2026-08-26');
  });

  it('resolves "from start of this month to end of this month"', () => {
    const r = resolveDateRange('from start of this month to end of this month', TODAY);
    expect(r.startDate).toBe('2026-08-01');
    expect(r.endDate).toBe('2026-08-31');
  });
});
