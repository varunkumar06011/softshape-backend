export type GstCategory = 'NON_AC' | 'AC' | 'TAKEAWAY';

export interface GstRates {
  totalRate: number;
  cgstRate: number;
  sgstRate: number;
}

export function getGstRates(gstCategory: string | null | undefined): GstRates {
  const category = (gstCategory || 'NON_AC').toUpperCase() as GstCategory;
  switch (category) {
    case 'AC':
      return { totalRate: 0.18, cgstRate: 0.09, sgstRate: 0.09 };
    case 'NON_AC':
    case 'TAKEAWAY':
    default:
      return { totalRate: 0.05, cgstRate: 0.025, sgstRate: 0.025 };
  }
}

export function getGstBreakdown(
  taxableAmount: number,
  gstCategory: string | null | undefined,
  pricesIncludeGst: boolean
): { cgst: number; sgst: number; tax: number; baseAmount: number } {
  const { cgstRate, sgstRate } = getGstRates(gstCategory);
  const totalRate = cgstRate + sgstRate;
  const amount = Math.max(0, Number(taxableAmount) || 0);

  if (pricesIncludeGst) {
    // Prices are inclusive of GST: extract the base amount, then split tax evenly.
    // base = total / (1 + rate); tax = total - base; cgst/sgst from base * rate.
    const baseAmount = Math.round((amount / (1 + totalRate)) * 100) / 100;
    const cgst = Math.round(baseAmount * cgstRate * 100) / 100;
    const sgst = Math.round(baseAmount * sgstRate * 100) / 100;
    const tax = cgst + sgst;
    return { cgst, sgst, tax, baseAmount };
  }

  // Prices are exclusive of GST: add tax on top.
  const cgst = Math.round(amount * cgstRate * 100) / 100;
  const sgst = Math.round(amount * sgstRate * 100) / 100;
  const tax = cgst + sgst;
  return { cgst, sgst, tax, baseAmount: amount };
}
