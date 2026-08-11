// ─────────────────────────────────────────────────────────────────────────────
// Unit Conversion Utility — converts entered quantities to base unit for stock
// ─────────────────────────────────────────────────────────────────────────────
// Supports common Indian kitchen units: kg, gm, litre, ml, dozen, piece, etc.
// The base unit is the unit stored on the KitchenInventoryItem.
// When a user enters a quantity in a different unit, convertToBaseUnit()
// returns the equivalent quantity in the base unit.
// ─────────────────────────────────────────────────────────────────────────────

const UNIT_ALIASES: Record<string, string> = {
  kg: "kg", kilogram: "kg", kilograms: "kg",
  g: "gm", gm: "gm", gram: "gm", grams: "gm",
  l: "litre", litre: "litre", liter: "litre", litres: "litre", liters: "litre",
  ml: "ml", millilitre: "ml", milliliter: "ml", millilitres: "ml", milliliters: "ml",
  dozen: "dozen", dz: "dozen", dzn: "dozen",
  piece: "piece", pieces: "piece", pc: "piece", pcs: "piece", nos: "piece", no: "piece",
  packet: "piece", packets: "piece", pack: "piece", packs: "piece",
  box: "piece", boxes: "piece",
  bunch: "piece", bunches: "piece",
  bundle: "piece", bundles: "piece",
  tray: "piece", trays: "piece",
};

const CONVERSIONS: Record<string, { from: string; to: string; factor: number }[]> = {
  kg: [
    { from: "gm", to: "kg", factor: 0.001 },
    { from: "kg", to: "kg", factor: 1 },
  ],
  gm: [
    { from: "kg", to: "gm", factor: 1000 },
    { from: "gm", to: "gm", factor: 1 },
  ],
  litre: [
    { from: "ml", to: "litre", factor: 0.001 },
    { from: "litre", to: "litre", factor: 1 },
  ],
  ml: [
    { from: "litre", to: "ml", factor: 1000 },
    { from: "ml", to: "ml", factor: 1 },
  ],
  dozen: [
    { from: "piece", to: "dozen", factor: 1 / 12 },
    { from: "dozen", to: "dozen", factor: 1 },
  ],
  piece: [
    { from: "dozen", to: "piece", factor: 12 },
    { from: "piece", to: "piece", factor: 1 },
  ],
};

export function normalizeUnit(unit: string): string {
  const lower = (unit || "").trim().toLowerCase();
  return UNIT_ALIASES[lower] || lower;
}

export function convertToBaseUnit(
  quantity: number,
  enteredUnit: string,
  baseUnit: string
): { effectiveQty: number; converted: boolean } {
  const fromUnit = normalizeUnit(enteredUnit);
  const toUnit = normalizeUnit(baseUnit);

  if (fromUnit === toUnit) {
    return { effectiveQty: quantity, converted: false };
  }

  const conversions = CONVERSIONS[toUnit];
  if (conversions) {
    const conv = conversions.find((c) => c.from === fromUnit);
    if (conv) {
      return { effectiveQty: Math.round(quantity * conv.factor * 10000) / 10000, converted: true };
    }
  }

  // No conversion found — return as-is
  return { effectiveQty: quantity, converted: false };
}

export const COMMON_UNITS = [
  "kg", "gm", "litre", "ml", "dozen", "piece",
  "packet", "box", "bunch", "bundle", "tray",
];
