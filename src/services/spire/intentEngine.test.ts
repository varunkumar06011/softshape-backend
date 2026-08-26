import { describe, it, expect } from 'vitest';
import classifyIntent, { INTENT, isBusinessQuestion } from './intentEngine';

describe('classifyIntent — AOV', () => {
  it('classifies "What is today\'s AOV?" as AOV', () => {
    expect(classifyIntent("What is today's AOV?").intent).toBe(INTENT.AOV);
  });

  it('classifies "AOV this week?" as AOV', () => {
    expect(classifyIntent('AOV this week?').intent).toBe(INTENT.AOV);
  });

  it('classifies "What was our AOV last month?" as AOV', () => {
    expect(classifyIntent('What was our AOV last month?').intent).toBe(INTENT.AOV);
  });

  it('classifies "average order value" as AOV', () => {
    expect(classifyIntent('average order value today').intent).toBe(INTENT.AOV);
  });

  it('classifies "average bill value" as AOV', () => {
    expect(classifyIntent('average bill value this month').intent).toBe(INTENT.AOV);
  });
});

describe('classifyIntent — AOV comparison', () => {
  it('classifies "Compare AOV this month vs last month" as AOV_COMPARISON', () => {
    expect(classifyIntent('Compare AOV this month vs last month').intent).toBe(INTENT.AOV_COMPARISON);
  });

  it('classifies "aov this week vs last week" as AOV_COMPARISON', () => {
    expect(classifyIntent('aov this week vs last week').intent).toBe(INTENT.AOV_COMPARISON);
  });
});

describe('classifyIntent — Specials', () => {
  it('classifies "What are today\'s specials?" as SPECIALS', () => {
    expect(classifyIntent("What are today's specials?").intent).toBe(INTENT.SPECIALS);
  });

  it('classifies "todays special" as SPECIALS', () => {
    expect(classifyIntent('todays special').intent).toBe(INTENT.SPECIALS);
  });

  it('classifies "specials today" as SPECIALS', () => {
    expect(classifyIntent('specials today').intent).toBe(INTENT.SPECIALS);
  });
});

describe('classifyIntent — Orders / Bills', () => {
  it('classifies "how many bills today" as ORDERS', () => {
    expect(classifyIntent('how many bills today').intent).toBe(INTENT.ORDERS);
  });

  it('classifies "total orders this month" as ORDERS', () => {
    expect(classifyIntent('total orders this month').intent).toBe(INTENT.ORDERS);
  });
});

describe('classifyIntent — Outlet-wise', () => {
  it('classifies "outlet wise performance" as OUTLET_WISE', () => {
    expect(classifyIntent('outlet wise performance this month').intent).toBe(INTENT.OUTLET_WISE);
  });

  it('classifies "revenue by outlet" as OUTLET_WISE', () => {
    expect(classifyIntent('revenue by outlet this week').intent).toBe(INTENT.OUTLET_WISE);
  });
});

describe('classifyIntent — Category sales (desserts)', () => {
  it('classifies "dessert sales today" as CATEGORY_SALES with categoryName Desserts', () => {
    const r = classifyIntent('dessert sales today');
    expect(r.intent).toBe(INTENT.CATEGORY_SALES);
    expect(r.categoryName).toBe('Desserts');
  });

  it('classifies "beverages sales this week" as CATEGORY_SALES', () => {
    const r = classifyIntent('beverages sales this week');
    expect(r.intent).toBe(INTENT.CATEGORY_SALES);
    expect(r.categoryName).toBe('Beverages');
  });
});

describe('classifyIntent — existing intents still work', () => {
  it('classifies sales summary', () => {
    expect(classifyIntent('today sales').intent).toBe(INTENT.SALES_SUMMARY);
  });

  it('classifies discounts', () => {
    expect(classifyIntent('discounts today').intent).toBe(INTENT.DISCOUNTS);
  });

  it('classifies attendance', () => {
    expect(classifyIntent('staff attendance today').intent).toBe(INTENT.ATTENDANCE);
  });

  it('classifies top selling with limit', () => {
    const r = classifyIntent('top 10 selling items this week');
    expect(r.intent).toBe(INTENT.TOP_SELLING);
    expect(r.limit).toBe(10);
  });

  it('classifies floor status', () => {
    expect(classifyIntent('floor status').intent).toBe(INTENT.FLOOR_STATUS);
  });

  it('classifies payment breakdown', () => {
    expect(classifyIntent('payment breakdown today').intent).toBe(INTENT.PAYMENT_BREAKDOWN);
  });

  it('classifies wastage', () => {
    expect(classifyIntent('wastage today').intent).toBe(INTENT.WASTAGE);
  });

  it('classifies low stock', () => {
    expect(classifyIntent('low stock alerts').intent).toBe(INTENT.LOW_STOCK);
  });

  it('classifies period comparison (revenue)', () => {
    expect(classifyIntent('compare revenue this month vs last month').intent).toBe(INTENT.PERIOD_COMPARISON);
  });
});

describe('classifyIntent — tie-breaking edge cases', () => {
  it('classifies "what is our revenue today" as REVENUE (not tie with SALES_SUMMARY)', () => {
    expect(classifyIntent('what is our revenue today').intent).toBe(INTENT.REVENUE);
  });

  it('classifies "total revenue today" as REVENUE', () => {
    expect(classifyIntent('total revenue today').intent).toBe(INTENT.REVENUE);
  });

  it('classifies "gross sales today" as REVENUE', () => {
    expect(classifyIntent('gross sales today').intent).toBe(INTENT.REVENUE);
  });

  it('classifies "low stock" as LOW_STOCK (not tie with PURCHASES)', () => {
    expect(classifyIntent('low stock').intent).toBe(INTENT.LOW_STOCK);
  });

  it('classifies "out of stock" as LOW_STOCK (not tie with PURCHASES)', () => {
    expect(classifyIntent('out of stock items').intent).toBe(INTENT.LOW_STOCK);
  });

  it('classifies "insufficient stock" as LOW_STOCK (not tie with PURCHASES)', () => {
    expect(classifyIntent('insufficient stock').intent).toBe(INTENT.LOW_STOCK);
  });

  it('still classifies "stock purchased today" as PURCHASES (stock alone)', () => {
    expect(classifyIntent('stock purchased today').intent).toBe(INTENT.PURCHASES);
  });

  it('still classifies "purchase report" as PURCHASES', () => {
    expect(classifyIntent('purchase report today').intent).toBe(INTENT.PURCHASES);
  });

  it('classifies "sales today" as SALES_SUMMARY (not REVENUE)', () => {
    expect(classifyIntent('sales today').intent).toBe(INTENT.SALES_SUMMARY);
  });

  it('classifies "turnover today" as SALES_SUMMARY', () => {
    expect(classifyIntent('turnover today').intent).toBe(INTENT.SALES_SUMMARY);
  });
});

describe('classifyIntent — fallback', () => {
  it('returns NEEDS_LLM for unknown queries', () => {
    expect(classifyIntent('xyzzy foobar').intent).toBe(INTENT.NEEDS_LLM);
  });
});

describe('isBusinessQuestion', () => {
  it('detects advice-style questions', () => {
    expect(isBusinessQuestion('how can I grow my business?')).toBe(true);
  });

  it('does not flag operational questions', () => {
    expect(isBusinessQuestion('today sales')).toBe(false);
  });
});
