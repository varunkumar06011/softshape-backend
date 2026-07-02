// Rule-based intent classifier for the Spire AI agent.
// Matches the user's message against six common business intents.
// Returns NEEDS_LLM when the intent is unclear, ambiguous, or not covered.

export const INTENT = {
  SALES_SUMMARY: 'SALES_SUMMARY',
  ITEM_SALES: 'ITEM_SALES',
  DISCOUNTS: 'DISCOUNTS',
  ATTENDANCE: 'ATTENDANCE',
  PURCHASES: 'PURCHASES',
  TOP_SELLING: 'TOP_SELLING',
  NEEDS_LLM: 'NEEDS_LLM',
} as const;

export type Intent = typeof INTENT[keyof typeof INTENT];

export interface IntentResult {
  intent: Intent;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  limit?: number;
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
const ITEM_SALES_TRIGGERS = ['sold', 'sold quantity', 'item sales', 'how many', 'quantity of', 'sales of'];
const DISCOUNT_TRIGGERS = ['discount', 'discounts', 'discount applied', 'total discount', 'discounted'];
const ATTENDANCE_TRIGGERS = ['attendance', 'present', 'absent', 'staff', 'employees', 'who came', 'who did not come', 'how many staff'];
const PURCHASE_TRIGGERS = ['purchase', 'purchased', 'bought', 'stock', 'procurement', 'inventory bought', 'purchase quantity'];
const TOP_SELLING_TRIGGERS = ['top selling', 'best selling', 'most sold', 'highest selling', 'top item', 'most popular'];

export function classifyIntent(message: string): IntentResult {
  const text = message;
  const scores: { intent: Intent; score: number; keywords: string[] }[] = [
    { intent: INTENT.SALES_SUMMARY, score: countMatches(text, SALES_TRIGGERS), keywords: SALES_TRIGGERS },
    { intent: INTENT.ITEM_SALES, score: countMatches(text, ITEM_SALES_TRIGGERS), keywords: ITEM_SALES_TRIGGERS },
    { intent: INTENT.DISCOUNTS, score: countMatches(text, DISCOUNT_TRIGGERS), keywords: DISCOUNT_TRIGGERS },
    { intent: INTENT.ATTENDANCE, score: countMatches(text, ATTENDANCE_TRIGGERS), keywords: ATTENDANCE_TRIGGERS },
    { intent: INTENT.PURCHASES, score: countMatches(text, PURCHASE_TRIGGERS), keywords: PURCHASE_TRIGGERS },
    { intent: INTENT.TOP_SELLING, score: countMatches(text, TOP_SELLING_TRIGGERS), keywords: TOP_SELLING_TRIGGERS },
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
