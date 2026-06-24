export interface PlanConfig {
  id: 'starter' | 'pro' | 'enterprise';
  name: string;
  basePrice: number;            // ₹/month, includes `includedOutlets`
  perExtraOutletPrice: number;  // ₹/month per outlet beyond includedOutlets
  includedOutlets: number;
  isCustomQuote: boolean;       // true for enterprise — no self-serve price
}

export const PLAN_CONFIG: Record<string, PlanConfig> = {
  starter: { id: 'starter', name: 'Starter', basePrice: 999, perExtraOutletPrice: 499, includedOutlets: 1, isCustomQuote: false },
  pro: { id: 'pro', name: 'Pro', basePrice: 2499, perExtraOutletPrice: 999, includedOutlets: 1, isCustomQuote: false },
  enterprise: { id: 'enterprise', name: 'Enterprise', basePrice: 0, perExtraOutletPrice: 0, includedOutlets: 0, isCustomQuote: true },
};

export interface PriceQuote {
  planId: string;
  numberOfOutlets: number;
  basePrice: number;
  extraOutlets: number;
  extraOutletCost: number;
  totalMonthly: number;
  isCustomQuote: boolean;
}

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
