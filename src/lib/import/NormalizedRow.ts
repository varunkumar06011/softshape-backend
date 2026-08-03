// ─────────────────────────────────────────────────────────────────────────────
// NormalizedRow — a single menu item after normalization, before validation.
// ─────────────────────────────────────────────────────────────────────────────
// This is the canonical in-memory representation that flows through the
// validator and into the importer. Optional fields are undefined when the
// source file did not provide them — the importer applies sensible defaults.
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalizedVariant {
  name: string;
  price: number;
  isDefault: boolean;
}

export interface NormalizedRow {
  /** 1-based original row number in the source file (for error reporting). */
  index: number;
  name: string;
  price: number;
  category: string;
  isVeg: boolean;
  description: string;
  gst?: number;
  hsn?: string;
  image?: string;
  sku?: string;
  kitchen?: string;
  printer?: string;
  preparationTime?: number;
  isAvailable?: boolean;
  menuType?: string;
  unit?: string;
  variants?: NormalizedVariant[];
  /** True when category was inferred from the item name (not from a column). */
  categoryInferred?: boolean;
  /** Rate-card only: per-venue prices keyed by venue header name. */
  venuePrices?: Record<string, number>;
}
