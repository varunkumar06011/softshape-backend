import { describe, it, expect } from 'vitest';
import { normalize } from './normalizer';
import { validate } from './validator';
import { CanonicalField } from '../../lib/import/CanonicalField';
import { MappingSource } from '../../lib/import/MappingSource';
import type { ColumnMapping, RawImportData } from '../../lib/import/RawImportData';

// ─────────────────────────────────────────────────────────────────────────────
// Tests for menuType resolution in the standard Excel/CSV normalizer path.
//
// Regression guard: the normalizer must not guess LIQUOR from the category
// name. LIQUOR_KEYWORDS contains generic tokens ("bottle", "half", "full",
// "ltr") that legitimately appear in food categories, and a row classified
// LIQUOR is rejected outright by the validator for non-bar outlets — silently
// dropping those items from the import.
//
// menuType therefore comes from an explicit menuType column only, defaulting
// to FOOD. This matches the behaviour of the pre-pipeline importer.
// ─────────────────────────────────────────────────────────────────────────────

/** Build RawImportData for the standard (mapping-required) Excel path. */
function buildData(
  columns: string[],
  fields: (CanonicalField | null)[],
  rows: any[][],
): { data: RawImportData; mapping: ColumnMapping[] } {
  const mapping: ColumnMapping[] = fields.map((field) => ({
    field,
    source: MappingSource.MANUAL,
  }));
  return {
    data: {
      fileType: 'excel',
      columns,
      suggestedMapping: mapping,
      rows: rows.map((cells, i) => ({ index: i + 2, cells })),
      requiresMapping: true,
      warnings: [],
    },
    mapping,
  };
}

const CATEGORY_NAME_PRICE = [
  CanonicalField.CATEGORY,
  CanonicalField.NAME,
  CanonicalField.PRICE,
];

describe('normalizer — menuType resolution', () => {
  it('does not classify food categories containing liquor-adjacent words as LIQUOR', () => {
    const { data, mapping } = buildData(
      ['Category', 'Item Name', 'Price'],
      CATEGORY_NAME_PRICE,
      [
        ['Water Bottles', 'Mineral Water 1L', '20'],
        ['Half Plate Specials', 'Half Plate Biryani', '150'],
        ['Full Meals', 'Veg Full Meal', '180'],
        ['Beverages', 'Fresh Lime Soda', '80'],
      ],
    );

    const result = normalize(data, mapping);

    expect(result).toHaveLength(4);
    expect(result.map((r) => r.menuType)).toEqual(['FOOD', 'FOOD', 'FOOD', 'FOOD']);
  });

  it('honours an explicit menuType column', () => {
    const { data, mapping } = buildData(
      ['Category', 'Item Name', 'Price', 'Type'],
      [...CATEGORY_NAME_PRICE, CanonicalField.MENU_TYPE],
      [
        ['Spirits', 'Old Monk 90ml', '120', 'LIQUOR'],
        ['Starters', 'Paneer Tikka', '250', 'FOOD'],
        ['Spirits', 'Beer Pint', '180', 'BAR'],
      ],
    );

    const result = normalize(data, mapping);

    expect(result.map((r) => r.menuType)).toEqual(['LIQUOR', 'FOOD', 'LIQUOR']);
  });

  it('defaults to FOOD when no menuType column is mapped', () => {
    const { data, mapping } = buildData(
      ['Category', 'Item Name', 'Price'],
      CATEGORY_NAME_PRICE,
      [['Whisky', 'Royal Stag', '150']],
    );

    const result = normalize(data, mapping);

    expect(result[0].menuType).toBe('FOOD');
  });

  it('keeps food rows importable into a non-bar outlet', () => {
    const { data, mapping } = buildData(
      ['Category', 'Item Name', 'Price'],
      CATEGORY_NAME_PRICE,
      [
        ['Water Bottles', 'Mineral Water 1L', '20'],
        ['Half Plate Specials', 'Half Plate Biryani', '150'],
      ],
    );

    const rows = normalize(data, mapping);
    const { errors, invalidRowIndices } = validate(rows, {
      isBarOutlet: false,
      existingItemNames: new Set<string>(),
    });

    expect(errors.filter((e) => e.code === 'LIQUOR_IN_NON_BAR')).toHaveLength(0);
    expect(invalidRowIndices.size).toBe(0);
  });
});
