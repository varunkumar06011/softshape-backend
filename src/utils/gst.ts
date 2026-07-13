// ─────────────────────────────────────────────────────────────────────────────
// GST Utilities — GST rate resolution and CGST/SGST breakdown calculation
// ─────────────────────────────────────────────────────────────────────────────
// Handles GST (Goods and Services Tax) calculations for Indian restaurants.
// GST is split equally into CGST (Central) and SGST (State) for intra-state sales.
//
// Rate resolution priority:
//   1. Owner override: if gstRate is a non-null number > 0, use it directly
//   2. Category-based: AC = 18%, NON_AC/TAKEAWAY = 5%
//   3. If gstRegistered is false, always returns 0% (unregistered restaurants)
//
// Functions:
//   getEffectiveGstRate(gstRate, gstCategory, gstRegistered) → number (percentage)
//   getGstBreakdown(amount, gstRate, pricesIncludeGst) → { cgst, sgst, totalGst, taxableAmount }
//   getGstBreakdownWithRate(amount, gstRate, pricesIncludeGst) → includes rate in result
// ─────────────────────────────────────────────────────────────────────────────

// GST category types used by restaurants in India
export type GstCategory = 'NON_AC' | 'AC' | 'TAKEAWAY';

// GST rate breakdown: total rate split into CGST and SGST (each is half of total)
export interface GstRates {
  totalRate: number;
  cgstRate: number;
  sgstRate: number;
}

/**
 * Resolve the effective GST rate percentage (e.g. 5, 18, 0) from an optional
 * numeric override and the restaurant's gstCategory.
 *
 * - If `gstRate` is a non-null number > 0, use it directly (owner override).
 * - Otherwise derive from `gstCategory` (AC = 18, NON_AC/TAKEAWAY = 5).
 * - If `gstRegistered` is false, always returns 0.
 */
export function getEffectiveGstRate(
  gstRate: number | null | undefined,
  gstCategory: string | null | undefined,
  gstRegistered: boolean | null | undefined,
): number {
  if (gstRegistered === false) return 0;
  if (gstRate != null && gstRate > 0) return gstRate;
  const category = (gstCategory || 'NON_AC').toUpperCase() as GstCategory;
  return category === 'AC' ? 18 : 5;
}

/**
 * @deprecated Use getEffectiveGstRate + getGstBreakdownWithRate instead.
 * Kept for backward compatibility with callers not yet updated.
 */
export function getGstRates(gstCategory: string | null | undefined): GstRates {
  const category = (gstCategory || 'NON_AC').toUpperCase() as GstCategory;
  const ratePercent = category === 'AC' ? 18 : 5;
  const totalRate = ratePercent / 100;
  const half = totalRate / 2;
  return { totalRate, cgstRate: half, sgstRate: half };
}

/**
 * New canonical GST breakdown function. Accepts the effective rate percentage
 * (e.g. 5, 18, 0) directly, plus inclusive/exclusive flag.
 */
export function getGstBreakdownWithRate(
  taxableAmount: number,
  ratePercent: number,
  pricesIncludeGst: boolean,
): { cgst: number; sgst: number; tax: number; baseAmount: number } {
  const amount = Math.max(0, Number(taxableAmount) || 0);
  const totalRate = ratePercent / 100;
  const halfRate = totalRate / 2;

  if (ratePercent <= 0) {
    return { cgst: 0, sgst: 0, tax: 0, baseAmount: amount };
  }

  if (pricesIncludeGst) {
    const baseAmount = Math.round((amount / (1 + totalRate)) * 100) / 100;
    const rawTax = Math.round(baseAmount * totalRate * 100) / 100;
    const cgst = Math.round(rawTax / 2 * 100) / 100;
    const sgst = Math.round((rawTax - cgst) * 100) / 100;
    return { cgst, sgst, tax: rawTax, baseAmount };
  }

  const rawTax = Math.round(amount * totalRate * 100) / 100;
  const cgst = Math.round(rawTax / 2 * 100) / 100;
  const sgst = Math.round((rawTax - cgst) * 100) / 100;
  return { cgst, sgst, tax: rawTax, baseAmount: amount };
}

/**
 * @deprecated Use getGstBreakdownWithRate + getEffectiveGstRate instead.
 * Kept for backward compatibility — internally delegates to the new functions.
 */
export function getGstBreakdown(
  taxableAmount: number,
  gstCategory: string | null | undefined,
  pricesIncludeGst: boolean,
): { cgst: number; sgst: number; tax: number; baseAmount: number } {
  const ratePercent = getEffectiveGstRate(null, gstCategory, true);
  return getGstBreakdownWithRate(taxableAmount, ratePercent, pricesIncludeGst);
}
