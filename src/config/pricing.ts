// ─────────────────────────────────────────────────────────────────────────────
// Subscription Plan Configuration
// ─────────────────────────────────────────────────────────────────────────────
// Defines the pricing tiers for SoftShape AI SaaS subscriptions.
// Three plans are available: 'starter', 'pro', and 'enterprise'.
// Each plan has a base monthly price that includes a certain number of outlets,
// plus a per-outlet price for additional outlets beyond the included amount.
// The 'enterprise' plan requires a custom quote (no self-serve pricing).
// ─────────────────────────────────────────────────────────────────────────────

import { basePrisma } from "../lib/prisma";

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
// Used as fallback when DB PlanConfig table is empty or unreachable.
export const PLAN_CONFIG: Record<string, PlanConfig> = {
  starter: { id: 'starter', name: 'Starter', basePrice: 1, perExtraOutletPrice: 0, includedOutlets: 1, isCustomQuote: false },
  pro: { id: 'pro', name: 'Pro', basePrice: 99, perExtraOutletPrice: 0, includedOutlets: 1, isCustomQuote: false },
  enterprise: { id: 'enterprise', name: 'Enterprise', basePrice: 0, perExtraOutletPrice: 0, includedOutlets: 0, isCustomQuote: true },
};

// ── DB-backed plan config with in-memory cache ───────────────────────────────
// Reads from the PlanConfig table with a 60s TTL in-memory cache.
// Falls back to hardcoded PLAN_CONFIG if the DB is unreachable or the table
// hasn't been seeded yet. This ensures the onboarding flow always works, even
// during initial deployment before the migration runs.

let planConfigCache: Record<string, PlanConfig> | null = null;
let planConfigCacheExpiry = 0;
const PLAN_CONFIG_CACHE_TTL_MS = 60_000; // 60 seconds

export function invalidatePlanConfigCache(): void {
  planConfigCache = null;
  planConfigCacheExpiry = 0;
}

export async function getPlanConfig(): Promise<Record<string, PlanConfig>> {
  const now = Date.now();
  if (planConfigCache && now < planConfigCacheExpiry) {
    return planConfigCache;
  }

  try {
    const dbPlans = await basePrisma.planConfig.findMany({
      where: { isActive: true },
    });

    if (dbPlans.length > 0) {
      const config: Record<string, PlanConfig> = {};
      for (const p of dbPlans) {
        config[p.planId] = {
          id: p.planId as PlanConfig['id'],
          name: p.name,
          basePrice: p.basePrice,
          perExtraOutletPrice: p.perExtraOutletPrice,
          includedOutlets: p.includedOutlets,
          isCustomQuote: p.isCustomQuote,
        };
      }
      planConfigCache = config;
      planConfigCacheExpiry = now + PLAN_CONFIG_CACHE_TTL_MS;
      return config;
    }
  } catch {
    // DB not reachable or table doesn't exist — fall back to hardcoded values
  }

  planConfigCache = PLAN_CONFIG;
  planConfigCacheExpiry = now + PLAN_CONFIG_CACHE_TTL_MS;
  return PLAN_CONFIG;
}

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
// Uses the DB-backed getPlanConfig() with in-memory cache, falling back to
// hardcoded PLAN_CONFIG if the DB is unreachable.
// Throws if planId is not found in the plan config.
export async function computePlanPrice(planId: string, numberOfOutlets: number): Promise<PriceQuote> {
  const config = await getPlanConfig();
  const plan = config[planId];
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

// Synchronous version that uses the hardcoded PLAN_CONFIG directly.
// Use this only in contexts where async is not possible (e.g. module-level
// initialization). Prefer computePlanPrice() for all user-facing flows.
export function computePlanPriceSync(planId: string, numberOfOutlets: number): PriceQuote {
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
