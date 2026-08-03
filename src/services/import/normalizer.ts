// ─────────────────────────────────────────────────────────────────────────────
// normalizer — converts RawImportData + confirmed ColumnMapping[] into
// NormalizedRow[]. Shared by every file type.
// ─────────────────────────────────────────────────────────────────────────────
// For excel/csv: applies the user-confirmed column mapping to each raw row.
// For pdf/image: the parser already produced normalizedRows — the normalizer
// is a no-op pass-through (no mapping to apply).
//
// Responsibilities:
//   - Map raw cells to canonical fields via the column mapping
//   - Infer isVeg from name when not provided
//   - Infer category from name when blank
//   - Infer menuType from category
//   - Detect half/full variants from price-cell format (e.g. "120/140")
//   - Merge rows that differ only by Half/Full suffix
//   - Apply defaults: category="Uncategorized", price=0, isVeg=true
//
// Does NOT validate — that's the validator's job.
// ─────────────────────────────────────────────────────────────────────────────

import { CanonicalField } from '../../lib/import/CanonicalField';
import { MappingSource } from '../../lib/import/MappingSource';
import type { ColumnMapping, RawImportData, RawRow } from '../../lib/import/RawImportData';
import type { NormalizedRow, NormalizedVariant } from '../../lib/import/NormalizedRow';
import {
  inferCategoryFromName,
  inferVeg,
  parsePrice,
} from './menuHelpers';

/** Build a column-index → CanonicalField lookup from the mapping array. */
function buildFieldIndexMap(mapping: ColumnMapping[]): Map<number, CanonicalField> {
  const m = new Map<number, CanonicalField>();
  mapping.forEach((entry, i) => {
    if (entry.field) m.set(i, entry.field);
  });
  return m;
}

/** Parse a veg/non-veg cell value into a boolean. */
function parseIsVeg(value: any): boolean | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const v = String(value).trim().toLowerCase();
  if (['veg', 'true', '1', 'yes', 'v', 'vegetarian'].includes(v)) return true;
  if (['non-veg', 'nonveg', 'false', '0', 'no', 'nv', 'nonvegetarian', 'non vegetarian'].includes(v)) return false;
  return null;
}

/** Parse a menu-type cell value into FOOD or LIQUOR. */
function parseMenuType(value: any): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const v = String(value).trim().toUpperCase();
  if (v === 'LIQUOR' || v === 'BAR') return 'LIQUOR';
  if (v === 'FOOD') return 'FOOD';
  return null;
}

/** Parse an availability cell value into a boolean. */
function parseAvailable(value: any): boolean | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'available', 'active', 'instock', 'y'].includes(v)) return true;
  if (['false', '0', 'no', 'unavailable', 'inactive', 'outofstock', 'n'].includes(v)) return false;
  return null;
}

/** Detect half/full variant pricing from a price cell like "120/140" or "₹120/140". */
function detectVariantsFromPriceCell(priceStr: string): { half: number; full: number } | null {
  const m = priceStr.match(/^\s*₹?\s*(\d{2,5})\s*\/\s*(\d{2,5})\s*$/);
  if (!m) return null;
  const p1 = parseInt(m[1], 10);
  const p2 = parseInt(m[2], 10);
  if (isNaN(p1) || isNaN(p2) || p1 <= 0 || p2 <= 0) return null;
  return { half: Math.min(p1, p2), full: Math.max(p1, p2) };
}

/** Merge rows that differ only by " Half" / " Full" suffix within the same category. */
function mergeHalfFullRows(rows: NormalizedRow[]): NormalizedRow[] {
  const halfSuffix = /\s+half$/i;
  const fullSuffix = /\s+full$/i;
  const merged: NormalizedRow[] = [];
  const usedIndices = new Set<number>();

  for (let i = 0; i < rows.length; i++) {
    if (usedIndices.has(i)) continue;
    const row = rows[i];
    const nameLower = row.name.toLowerCase();

    if (halfSuffix.test(nameLower)) {
      const baseName = row.name.replace(/\s+half$/i, '').trim();
      let fullIdx = -1;
      for (let j = 0; j < rows.length; j++) {
        if (j === i || usedIndices.has(j)) continue;
        const other = rows[j];
        if (other.category !== row.category) continue;
        const otherLower = other.name.toLowerCase();
        if (fullSuffix.test(otherLower) && other.name.replace(/\s+full$/i, '').trim().toLowerCase() === baseName.toLowerCase()) {
          fullIdx = j;
          break;
        }
      }
      if (fullIdx >= 0) {
        usedIndices.add(i);
        usedIndices.add(fullIdx);
        const fullRow = rows[fullIdx];
        const variants: NormalizedVariant[] = [
          { name: 'Half', price: row.price, isDefault: true },
          { name: 'Full', price: fullRow.price, isDefault: false },
        ];
        merged.push({
          ...row,
          name: baseName,
          price: Math.min(row.price, fullRow.price),
          variants,
        });
        continue;
      }
    }

    if (fullSuffix.test(nameLower)) {
      const baseName = row.name.replace(/\s+full$/i, '').trim();
      let halfIdx = -1;
      for (let j = 0; j < rows.length; j++) {
        if (j === i || usedIndices.has(j)) continue;
        const other = rows[j];
        if (other.category !== row.category) continue;
        const otherLower = other.name.toLowerCase();
        if (halfSuffix.test(otherLower) && other.name.replace(/\s+half$/i, '').trim().toLowerCase() === baseName.toLowerCase()) {
          halfIdx = j;
          break;
        }
      }
      if (halfIdx >= 0) {
        // The Half row will handle the merge — skip this Full row
        usedIndices.add(i);
        continue;
      }
    }

    merged.push(row);
  }

  return merged;
}

/** Normalize a single raw row using the field-index map. */
function normalizeRow(rawRow: RawRow, fieldIndexMap: Map<number, CanonicalField>, restaurantType?: string): NormalizedRow {
  const fields: Partial<Record<CanonicalField, any>> = {};
  for (const [colIdx, field] of fieldIndexMap.entries()) {
    fields[field] = rawRow.cells[colIdx];
  }

  const name = String(fields[CanonicalField.NAME] || '').trim();

  // Price + variant detection
  let price: number;
  let variants: NormalizedVariant[] | undefined;
  const priceRaw = String(fields[CanonicalField.PRICE] || '').trim();
  const variantMatch = detectVariantsFromPriceCell(priceRaw);
  if (variantMatch) {
    price = variantMatch.half;
    variants = [
      { name: 'Half', price: variantMatch.half, isDefault: true },
      { name: 'Full', price: variantMatch.full, isDefault: false },
    ];
  } else {
    price = parsePrice(fields[CanonicalField.PRICE]);
  }

  // Category
  let category = String(fields[CanonicalField.CATEGORY] || '').trim();
  let categoryInferred = false;
  if (!category) {
    category = inferCategoryFromName(name, restaurantType);
    categoryInferred = true;
  }

  // isVeg
  const parsedVeg = parseIsVeg(fields[CanonicalField.IS_VEG]);
  const isVeg: boolean = parsedVeg !== null ? parsedVeg : inferVeg(name);

  // menuType — taken from an explicit menuType column only, defaulting to FOOD.
  // Category-name inference is deliberately not used: LIQUOR_KEYWORDS matches
  // generic words such as "half", "full", "bottle" and "ltr", so food categories
  // like "Half Plate Specials" would be classified LIQUOR — and the validator
  // rejects LIQUOR rows outright for non-bar outlets, silently dropping them.
  const menuType: string = parseMenuType(fields[CanonicalField.MENU_TYPE]) || 'FOOD';

  // Optional fields
  const description = String(fields[CanonicalField.DESCRIPTION] || '').trim();
  const gstRaw = fields[CanonicalField.GST];
  const gst = gstRaw !== undefined && gstRaw !== null && String(gstRaw).trim() !== '' ? parsePrice(gstRaw) : undefined;
  const hsn = fields[CanonicalField.HSN] ? String(fields[CanonicalField.HSN]).trim() : undefined;
  const image = fields[CanonicalField.IMAGE] ? String(fields[CanonicalField.IMAGE]).trim() : undefined;
  const sku = fields[CanonicalField.SKU] ? String(fields[CanonicalField.SKU]).trim() : undefined;
  const kitchen = fields[CanonicalField.KITCHEN] ? String(fields[CanonicalField.KITCHEN]).trim() : undefined;
  const printer = fields[CanonicalField.PRINTER] ? String(fields[CanonicalField.PRINTER]).trim() : undefined;
  const prepTimeRaw = fields[CanonicalField.PREPARATION_TIME];
  const preparationTime = prepTimeRaw !== undefined && prepTimeRaw !== null && String(prepTimeRaw).trim() !== '' ? parsePrice(prepTimeRaw) : undefined;
  const isAvailable = parseAvailable(fields[CanonicalField.IS_AVAILABLE]);
  const unit = fields[CanonicalField.UNIT] ? String(fields[CanonicalField.UNIT]).trim() : undefined;

  return {
    index: rawRow.index,
    name,
    price,
    category: category || 'Uncategorized',
    isVeg,
    description,
    ...(gst !== undefined ? { gst } : {}),
    ...(hsn ? { hsn } : {}),
    ...(image ? { image } : {}),
    ...(sku ? { sku } : {}),
    ...(kitchen ? { kitchen } : {}),
    ...(printer ? { printer } : {}),
    ...(preparationTime !== undefined ? { preparationTime } : {}),
    ...(isAvailable !== null ? { isAvailable } : {}),
    ...(menuType ? { menuType } : {}),
    ...(unit ? { unit } : {}),
    ...(variants ? { variants } : {}),
    ...(categoryInferred ? { categoryInferred } : {}),
  };
}

/**
 * Normalize RawImportData into NormalizedRow[].
 *
 * For excel/csv: applies the confirmed `mapping` to each raw row.
 * For pdf/image: returns the parser's pre-normalized rows directly (mapping
 * is ignored — those parsers set requiresMapping=false).
 *
 * `mapping` should be the user-confirmed ColumnMapping[] (source=MANUAL) or
 * the auto-suggested one if the user accepted it as-is.
 */
export function normalize(
  data: RawImportData,
  mapping: ColumnMapping[],
  restaurantType?: string,
): NormalizedRow[] {
  // PDF / image: rows are already normalized by the parser
  if (!data.requiresMapping && data.normalizedRows) {
    return data.normalizedRows;
  }

  // Excel / CSV: apply the column mapping
  const fieldIndexMap = buildFieldIndexMap(mapping);
  const rows: NormalizedRow[] = [];

  for (const rawRow of data.rows) {
    const normalized = normalizeRow(rawRow, fieldIndexMap, restaurantType);
    rows.push(normalized);
  }

  // Merge Half/Full suffix rows
  const merged = mergeHalfFullRows(rows);

  return merged;
}
