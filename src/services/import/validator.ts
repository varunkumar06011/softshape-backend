// ─────────────────────────────────────────────────────────────────────────────
// validator — 3-layer validation for NormalizedRow[].
// ─────────────────────────────────────────────────────────────────────────────
// Layers:
//   1. Structure validation  — per row, checks data integrity (name, price)
//   2. Business validation   — per row, checks business rules (price range, GST)
//   3. Restaurant validation — cross-row + DB, checks duplicates and outlet type
//
// Never rejects the whole file. Valid rows proceed to import; invalid rows
// go to the error report with severity-colored entries.
//
// ERROR   → row will NOT be imported
// WARNING → row WILL be imported but needs review
// INFO    → informational (e.g. duplicate of existing item)
// ─────────────────────────────────────────────────────────────────────────────

import { ImportErrorCode, type ImportError } from '../../lib/import/ImportError';
import type { NormalizedRow } from '../../lib/import/NormalizedRow';

// ── Layer 1: Structure validation ────────────────────────────────────────────

function validateStructure(rows: NormalizedRow[]): ImportError[] {
  const errors: ImportError[] = [];
  for (const row of rows) {
    if (!row.name || row.name.trim() === '') {
      errors.push({
        rowIndex: row.index,
        severity: 'ERROR',
        code: ImportErrorCode.MISSING_NAME,
        message: `Row ${row.index}: missing item name — row will be skipped`,
        data: row,
      });
      continue; // no point checking further on a nameless row
    }
    if (row.name.trim().length < 2) {
      errors.push({
        rowIndex: row.index,
        severity: 'INFO',
        code: ImportErrorCode.NAME_TOO_SHORT,
        message: `Row ${row.index}: item name "${row.name}" is very short — please verify`,
        data: row,
      });
    }
    if (isNaN(row.price) || row.price < 0) {
      errors.push({
        rowIndex: row.index,
        severity: 'WARNING',
        code: ImportErrorCode.INVALID_PRICE,
        message: `Row ${row.index}: invalid price for "${row.name}" — set to 0, please review`,
        data: row,
      });
    }
  }
  return errors;
}

// ── Layer 2: Business validation ─────────────────────────────────────────────

function validateBusiness(rows: NormalizedRow[]): ImportError[] {
  const errors: ImportError[] = [];
  const seenNames = new Map<string, number[]>(); // nameLower → [rowIndex, ...]

  for (const row of rows) {
    if (!row.name) continue;

    // Price zero warning
    if (row.price === 0) {
      errors.push({
        rowIndex: row.index,
        severity: 'WARNING',
        code: ImportErrorCode.PRICE_ZERO,
        message: `Row ${row.index}: "${row.name}" has price 0 — will be imported but hidden until price is set`,
        data: row,
      });
    }

    // GST range check
    if (row.gst !== undefined && (row.gst < 0 || row.gst > 28)) {
      errors.push({
        rowIndex: row.index,
        severity: 'WARNING',
        code: ImportErrorCode.INVALID_GST,
        message: `Row ${row.index}: GST ${row.gst}% for "${row.name}" is outside valid range (0–28%)`,
        data: row,
      });
    }

    // Duplicate name within the same category
    const key = `${row.name.toLowerCase().trim()}|${row.category.toLowerCase().trim()}`;
    const prior = seenNames.get(key);
    if (prior && prior.length > 0) {
      errors.push({
        rowIndex: row.index,
        severity: 'WARNING',
        code: ImportErrorCode.DUPLICATE_NAME,
        message: `Row ${row.index}: "${row.name}" in category "${row.category}" is a duplicate of row ${prior[0]} — will update existing on import`,
        data: row,
      });
    }
    if (!seenNames.has(key)) seenNames.set(key, []);
    seenNames.get(key)!.push(row.index);
  }

  return errors;
}

// ── Layer 3: Restaurant validation (cross-row + DB) ──────────────────────────

export interface RestaurantValidationContext {
  /** True when the target outlet is a bar-type (BAR_LOUNGE or BAR_WITH_DINING). */
  isBarOutlet: boolean;
  /** Set of lowercase existing item names for duplicate detection. */
  existingItemNames: Set<string>;
}

function validateRestaurant(rows: NormalizedRow[], ctx: RestaurantValidationContext): ImportError[] {
  const errors: ImportError[] = [];
  for (const row of rows) {
    if (!row.name) continue;

    // LIQUOR items cannot be imported into non-bar outlets
    if (row.menuType === 'LIQUOR' && !ctx.isBarOutlet) {
      errors.push({
        rowIndex: row.index,
        severity: 'ERROR',
        code: ImportErrorCode.LIQUOR_IN_NON_BAR,
        message: `Row ${row.index}: "${row.name}" is a LIQUOR item but the outlet is not a bar — row will be skipped`,
        data: row,
      });
    }

    // Duplicate of existing item in the restaurant
    if (ctx.existingItemNames.has(row.name.toLowerCase().trim())) {
      errors.push({
        rowIndex: row.index,
        severity: 'INFO',
        code: ImportErrorCode.DUPLICATE_EXISTING,
        message: `Row ${row.index}: "${row.name}" already exists in your menu — will be updated on import`,
        data: row,
      });
    }
  }
  return errors;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  errors: ImportError[];
  /** Row indices (1-based) that are ERROR-severity and should be skipped at import. */
  invalidRowIndices: Set<number>;
}

/**
 * Run the validation layers.
 * `ctx` is optional — when omitted, layer 3 (restaurant validation) is skipped
 * entirely, because outlet type and existing item names are unknown during
 * onboarding. Skipping is deliberate: guessing an outlet type here would either
 * reject every LIQUOR row or hide real duplicates.
 */
export function validate(rows: NormalizedRow[], ctx?: RestaurantValidationContext): ValidationResult {
  const errors: ImportError[] = [
    ...validateStructure(rows),
    ...validateBusiness(rows),
    ...(ctx ? validateRestaurant(rows, ctx) : []),
  ];

  const invalidRowIndices = new Set<number>();
  for (const e of errors) {
    if (e.severity === 'ERROR') invalidRowIndices.add(e.rowIndex);
  }

  return { errors, invalidRowIndices };
}
