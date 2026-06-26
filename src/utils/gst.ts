export type GstCategory = 'NON_AC' | 'AC' | 'TAKEAWAY';

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
    const cgst = Math.round(baseAmount * halfRate * 100) / 100;
    const sgst = Math.round(baseAmount * halfRate * 100) / 100;
    const tax = cgst + sgst;
    return { cgst, sgst, tax, baseAmount };
  }

  const cgst = Math.round(amount * halfRate * 100) / 100;
  const sgst = Math.round(amount * halfRate * 100) / 100;
  const tax = cgst + sgst;
  return { cgst, sgst, tax, baseAmount: amount };
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
