// Rule-based intent classifier for the Spire AI agent.
// Matches the user's message against common business intents.
// Returns NEEDS_LLM when the intent is unclear, ambiguous, or not covered.
//
// Classification strategy:
//   1. Compound intents (e.g. "compare AOV this month vs last month") are
//      detected first via priority rules so they don't tie with single intents.
//   2. Single intents are scored by keyword matches; the highest unique score
//      wins. Ties at the top fall back to NEEDS_LLM.

export const INTENT = {
  SALES_SUMMARY: 'SALES_SUMMARY',
  AOV: 'AOV',
  AOV_COMPARISON: 'AOV_COMPARISON',
  REVENUE: 'REVENUE',
  ORDERS: 'ORDERS',
  ITEM_SALES: 'ITEM_SALES',
  CATEGORY_SALES: 'CATEGORY_SALES',
  SPECIALS: 'SPECIALS',
  DISCOUNTS: 'DISCOUNTS',
  ATTENDANCE: 'ATTENDANCE',
  PURCHASES: 'PURCHASES',
  TOP_SELLING: 'TOP_SELLING',
  FLOOR_STATUS: 'FLOOR_STATUS',
  PAYMENT_BREAKDOWN: 'PAYMENT_BREAKDOWN',
  WASTAGE: 'WASTAGE',
  LOW_STOCK: 'LOW_STOCK',
  OUTLET_WISE: 'OUTLET_WISE',
  PERIOD_COMPARISON: 'PERIOD_COMPARISON',
  NEEDS_LLM: 'NEEDS_LLM',
} as const;

export type Intent = typeof INTENT[keyof typeof INTENT];

export interface IntentResult {
  intent: Intent;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  limit?: number;
  // Optional category name extracted for CATEGORY_SALES (e.g. "desserts").
  categoryName?: string;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasAny(text: string, words: string[]): boolean {
  const t = normalize(text);
  return words.some(w => t.includes(w.toLowerCase()));
}

function countMatches(text: string, words: string[]): number {
  const t = normalize(text);
  return words.reduce((count, w) => count + (t.includes(w.toLowerCase()) ? 1 : 0), 0);
}

const SALES_TRIGGERS = ['sales', 'revenue', 'turnover', 'total collection', 'collection', 'amount collected', 'how much did we make', 'how much money'];
const AOV_TRIGGERS = ['aov', 'average order value', 'average bill value', 'average bill', 'avg order value', 'avg bill', 'average ticket', 'avg ticket'];
const REVENUE_TRIGGERS = ['total revenue', 'revenue', 'total income', 'income', 'gross sales'];
const ORDERS_TRIGGERS = ['how many bills', 'bill count', 'number of bills', 'how many orders', 'order count', 'number of orders', 'total bills', 'total orders', 'bills today', 'orders today', 'how many bills today', 'how many sales'];
const ITEM_SALES_TRIGGERS = ['sold', 'sold quantity', 'item sales', 'how many', 'quantity of', 'sales of'];
const CATEGORY_TRIGGERS = ['dessert', 'desserts', 'beverage', 'beverages', 'liquor sales', 'food sales', 'regular items', 'regular item', 'starters', 'main course', 'category sales'];
const SPECIALS_TRIGGERS = ['special', 'specials', "today's special", "todays special", 'today special', 'special items', 'specials today', 'today specials', 'special menu'];
const DISCOUNT_TRIGGERS = ['discount', 'discounts', 'discount applied', 'total discount', 'discounted'];
const ATTENDANCE_TRIGGERS = ['attendance', 'present', 'absent', 'staff', 'employees', 'who came', 'who did not come', 'how many staff'];
const PURCHASE_TRIGGERS = ['purchase', 'purchased', 'bought', 'stock', 'procurement', 'inventory bought', 'purchase quantity'];
const TOP_SELLING_TRIGGERS = ['top selling', 'best selling', 'most sold', 'highest selling', 'top item', 'most popular'];
const FLOOR_STATUS_TRIGGERS = ['tables', 'floor', 'occupied', 'available tables', 'how many tables', 'table status', 'billing requested', 'busy tables', 'empty tables', 'live status'];
const PAYMENT_BREAKDOWN_TRIGGERS = ['payment method', 'upi', 'cash', 'card', 'payment breakdown', 'payment mode', 'payment type', 'how was payment', 'payment summary'];
const WASTAGE_TRIGGERS = ['wastage', 'waste', 'spoiled', 'damaged', 'expired', 'thrown away', 'food waste', 'wastage report'];
const LOW_STOCK_TRIGGERS = ['low stock', 'running low', 'out of stock', 'reorder', 'stock alert', 'below reorder', 'insufficient stock', 'stock low'];
const OUTLET_WISE_TRIGGERS = ['outlet wise', 'outlet-wise', 'outlet wise performance', 'outlet breakdown', 'by outlet', 'outlet wise sales', 'outlet wise revenue', 'each outlet', 'per outlet', 'outlet comparison'];
const COMPARISON_TRIGGERS = ['vs', 'versus', 'compared to', 'compare', 'difference', 'growth', 'decline', 'increase or decrease', 'better or worse', 'today vs yesterday', 'this week vs last week', 'this month vs last month'];

// Category keyword → canonical category name mapping for CATEGORY_SALES.
const CATEGORY_KEYWORD_MAP: { keywords: string[]; category: string }[] = [
  { keywords: ['dessert', 'desserts'], category: 'Desserts' },
  { keywords: ['beverage', 'beverages', 'drink', 'drinks'], category: 'Beverages' },
  { keywords: ['liquor', 'alcohol', 'bar sales'], category: 'Liquor' },
  { keywords: ['food', 'food sales', 'regular food'], category: 'Food' },
  { keywords: ['starter', 'starters'], category: 'Starters' },
  { keywords: ['main course', 'mains'], category: 'Main Course' },
];

function detectCategory(message: string): string | undefined {
  const t = normalize(message);
  for (const entry of CATEGORY_KEYWORD_MAP) {
    if (entry.keywords.some(k => t.includes(k))) return entry.category;
  }
  return undefined;
}

// Detects compound intents that combine a metric with a comparison operator.
// Checked before single-intent scoring to avoid ties.
function detectCompoundIntent(message: string): IntentResult | null {
  const hasComparison = hasAny(message, COMPARISON_TRIGGERS);
  if (!hasComparison) return null;

  const hasAov = hasAny(message, AOV_TRIGGERS);
  if (hasAov) {
    return { intent: INTENT.AOV_COMPARISON, confidence: 'HIGH' };
  }

  // Default comparison → revenue/period comparison
  return { intent: INTENT.PERIOD_COMPARISON, confidence: 'HIGH' };
}

export function classifyIntent(message: string): IntentResult {
  const text = message;

  // 1. Compound intents (comparison + metric) take priority.
  const compound = detectCompoundIntent(text);
  if (compound) return compound;

  // 2. Specials is highly specific — check before generic sales to avoid ties.
  if (hasAny(text, SPECIALS_TRIGGERS)) {
    return { intent: INTENT.SPECIALS, confidence: 'HIGH' };
  }

  // 3. Outlet-wise modifier — check before generic sales/revenue.
  if (hasAny(text, OUTLET_WISE_TRIGGERS)) {
    return { intent: INTENT.OUTLET_WISE, confidence: 'HIGH' };
  }

  // 4. AOV is specific enough to check before sales summary.
  if (hasAny(text, AOV_TRIGGERS)) {
    return { intent: INTENT.AOV, confidence: 'HIGH' };
  }

  // 4b. Revenue — check before scoring to avoid ties with SALES_SUMMARY
  // (both share the "revenue" and "gross sales" trigger words).
  if (hasAny(text, REVENUE_TRIGGERS)) {
    return { intent: INTENT.REVENUE, confidence: 'HIGH' };
  }

  // 5. Category sales (desserts, beverages, etc.) — check before item sales.
  const categoryName = detectCategory(text);
  if (categoryName && hasAny(text, CATEGORY_TRIGGERS)) {
    return { intent: INTENT.CATEGORY_SALES, confidence: 'HIGH', categoryName };
  }

  // 6. Orders/bills count — specific triggers, check before sales summary.
  if (hasAny(text, ORDERS_TRIGGERS)) {
    return { intent: INTENT.ORDERS, confidence: 'HIGH' };
  }

  // 6b. Top-selling — handle "top N selling" (with a number) explicitly since
  // the phrase "top 10 selling" doesn't substring-match "top selling".
  const topNMatch = text.match(/top\s+(\d+)\s*selling/i);
  if (topNMatch || hasAny(text, TOP_SELLING_TRIGGERS)) {
    const limit = topNMatch ? Number(topNMatch[1]) : undefined;
    // Re-extract limit for the "top N" pattern even when matched via triggers.
    const limitFromTriggers = text.match(/top\s+(\d+)/i);
    return { intent: INTENT.TOP_SELLING, confidence: 'HIGH', limit: limit ?? (limitFromTriggers ? Number(limitFromTriggers[1]) : undefined) };
  }

  // 6c. Low stock — check before scoring to avoid ties with PURCHASES
  // (both share the "stock" substring: "low stock" contains "stock").
  if (hasAny(text, LOW_STOCK_TRIGGERS)) {
    return { intent: INTENT.LOW_STOCK, confidence: 'HIGH' };
  }

  // 7. Single-intent scoring for the remaining intents.
  // REVENUE, TOP_SELLING, and LOW_STOCK are excluded — they are handled by
  // priority checks above to avoid ties with SALES_SUMMARY / PURCHASES.
  const scores: { intent: Intent; score: number; keywords: string[] }[] = [
    { intent: INTENT.SALES_SUMMARY, score: countMatches(text, SALES_TRIGGERS), keywords: SALES_TRIGGERS },
    { intent: INTENT.ITEM_SALES, score: countMatches(text, ITEM_SALES_TRIGGERS), keywords: ITEM_SALES_TRIGGERS },
    { intent: INTENT.DISCOUNTS, score: countMatches(text, DISCOUNT_TRIGGERS), keywords: DISCOUNT_TRIGGERS },
    { intent: INTENT.ATTENDANCE, score: countMatches(text, ATTENDANCE_TRIGGERS), keywords: ATTENDANCE_TRIGGERS },
    { intent: INTENT.PURCHASES, score: countMatches(text, PURCHASE_TRIGGERS), keywords: PURCHASE_TRIGGERS },
    { intent: INTENT.FLOOR_STATUS, score: countMatches(text, FLOOR_STATUS_TRIGGERS), keywords: FLOOR_STATUS_TRIGGERS },
    { intent: INTENT.PAYMENT_BREAKDOWN, score: countMatches(text, PAYMENT_BREAKDOWN_TRIGGERS), keywords: PAYMENT_BREAKDOWN_TRIGGERS },
    { intent: INTENT.WASTAGE, score: countMatches(text, WASTAGE_TRIGGERS), keywords: WASTAGE_TRIGGERS },
  ];

  const positive = scores.filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (positive.length === 0) {
    return { intent: INTENT.NEEDS_LLM, confidence: 'LOW' };
  }

  // If two or more intents tie at the top score, treat as ambiguous.
  if (positive.length >= 2 && positive[0].score === positive[1].score) {
    return { intent: INTENT.NEEDS_LLM, confidence: 'LOW' };
  }

  const winner = positive[0];
  let limit: number | undefined;

  if (winner.intent === INTENT.TOP_SELLING) {
    const m = text.match(/top\s+(\d+)/i);
    if (m) limit = Number(m[1]);
  }

  return { intent: winner.intent, confidence: winner.score >= 2 ? 'HIGH' : 'MEDIUM', limit };
}

export function isBusinessQuestion(message: string): boolean {
  const t = normalize(message);
  // Lightweight guard for business-advice style questions that are outside the rule set.
  const adviceWords = ['grow', 'improve', 'strategy', 'business', 'marketing', 'should i', 'what should', 'how can i increase', 'tips', 'advice'];
  return adviceWords.some(w => t.includes(w));
}

export default classifyIntent;
