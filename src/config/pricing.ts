// ─────────────────────────────────────────────────────────────────────────────
// Subscription Plan Configuration
// ─────────────────────────────────────────────────────────────────────────────
// Defines the pricing tiers for SoftShape AI SaaS subscriptions.
// Three plans are available: 'starter', 'pro', and 'enterprise'.
// Each plan has a base monthly price that includes a certain number of outlets,
// plus a per-outlet price for additional outlets beyond the included amount.
// The 'enterprise' plan requires a custom quote (no self-serve pricing).
// ─────────────────────────────────────────────────────────────────────────────

// Describes the configuration for a single subscription plan tier.
// Used by the onboarding flow and billing routes to calculate monthly costs.
export interface PlanConfig {
  id: 'starter' | 'pro' | 'enterprise';  // Unique plan identifier
  name: string;                           // Display name shown in UI
  basePrice: number;                      // Base monthly price in ₹, includes `includedOutlets` outlets
  perExtraOutletPrice: number;            // Additional ₹/month for each outlet beyond the included count
  includedOutlets: number;                // Number of outlets covered by the base price
  isCustomQuote: boolean;                 // If true, pricing is negotiated offline (enterprise only)
}

// The master plan catalog. Keyed by plan id.
// - starter: ₹1/mo, 1 outlet included, no extra outlet charge
// - pro:     ₹99/mo, 1 outlet included, no extra outlet charge
// - enterprise: Custom quote — sales team negotiates pricing
// Used by: onboard routes (plan selection), billing routes (invoice generation),
// and the frontend onboarding wizard (StepPlan.jsx) to display pricing.
export const PLAN_CONFIG: Record<string, PlanConfig> = {
  starter: { id: 'starter', name: 'Starter', basePrice: 1, perExtraOutletPrice: 0, includedOutlets: 1, isCustomQuote: false },
  pro: { id: 'pro', name: 'Pro', basePrice: 99, perExtraOutletPrice: 0, includedOutlets: 1, isCustomQuote: false },
  enterprise: { id: 'enterprise', name: 'Enterprise', basePrice: 0, perExtraOutletPrice: 0, includedOutlets: 0, isCustomQuote: true },
};

// Represents a computed price quote for a given plan + outlet count.
// Returned by computePlanPrice() and used in the onboarding/billing flow
// to show the user their total monthly cost before subscribing.
export interface PriceQuote {
  planId: string;
  numberOfOutlets: number;
  basePrice: number;
  extraOutlets: number;
  extraOutletCost: number;
  totalMonthly: number;
  isCustomQuote: boolean;
}

// Computes the monthly subscription cost for a given plan and outlet count.
//
// Parameters:
//   planId         — one of 'starter', 'pro', 'enterprise'
//   numberOfOutlets — total number of outlets the restaurant wants
//
// Returns a PriceQuote with the breakdown:
//   - basePrice:       the plan's base monthly price
//   - extraOutlets:    outlets beyond the included count (0 if within included)
//   - extraOutletCost: extraOutlets × perExtraOutletPrice
//   - totalMonthly:    basePrice + extraOutletCost
//   - isCustomQuote:   true for enterprise (all numeric fields are 0)
//
// Throws if planId is not found in PLAN_CONFIG.
export function computePlanPrice(planId: string, numberOfOutlets: number): PriceQuote {
  const plan = PLAN_CONFIG[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  if (plan.isCustomQuote) {
    return { planId, numberOfOutlets, basePrice: 0, extraOutlets: 0, extraOutletCost: 0, totalMonthly: 0, isCustomQuote: true };
  }
  const extraOutlets = Math.max(0, numberOfOutlets - plan.includedOutlets);
  const extraOutletCost = extraOutlets * plan.perExtraOutletPrice;
  return {
    planId,
    numberOfOutlets,
    basePrice: plan.basePrice,
    extraOutlets,
    extraOutletCost,
    totalMonthly: plan.basePrice + extraOutletCost,
    isCustomQuote: false,
  };
}
