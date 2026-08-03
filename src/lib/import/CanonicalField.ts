// ─────────────────────────────────────────────────────────────────────────────
// CanonicalField — the canonical schema fields every import maps into.
// ─────────────────────────────────────────────────────────────────────────────
// Every parser, normalizer, validator, and importer references this enum.
// No hardcoded field strings anywhere outside this file.
//
// To support a new import domain (inventory, vendors, customers, ...), add
// new enum values here. The pipeline itself is domain-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

export enum CanonicalField {
  // Required for menu
  NAME = 'name',
  PRICE = 'price',

  // Common optional
  CATEGORY = 'category',
  IS_VEG = 'isVeg',
  DESCRIPTION = 'description',
  GST = 'gst',
  HSN = 'hsn',
  IMAGE = 'image',
  SKU = 'sku',
  KITCHEN = 'kitchen',
  PRINTER = 'printer',
  PREPARATION_TIME = 'preparationTime',
  IS_AVAILABLE = 'isAvailable',
  MENU_TYPE = 'menuType',
  UNIT = 'unit',
}

/**
 * All canonical fields supported by the menu importer.
 * Used by the frontend to populate the column-mapping dropdown.
 * Order matters — required fields first, then common optional, then rare.
 */
export const MENU_CANONICAL_FIELDS: CanonicalField[] = [
  CanonicalField.NAME,
  CanonicalField.PRICE,
  CanonicalField.CATEGORY,
  CanonicalField.IS_VEG,
  CanonicalField.DESCRIPTION,
  CanonicalField.GST,
  CanonicalField.HSN,
  CanonicalField.IMAGE,
  CanonicalField.SKU,
  CanonicalField.KITCHEN,
  CanonicalField.PRINTER,
  CanonicalField.PREPARATION_TIME,
  CanonicalField.IS_AVAILABLE,
  CanonicalField.MENU_TYPE,
  CanonicalField.UNIT,
];

/** Human-readable label for each canonical field, for the mapping UI. */
export const CANONICAL_FIELD_LABELS: Record<CanonicalField, string> = {
  [CanonicalField.NAME]: 'Name',
  [CanonicalField.PRICE]: 'Price',
  [CanonicalField.CATEGORY]: 'Category',
  [CanonicalField.IS_VEG]: 'Veg / Non-Veg',
  [CanonicalField.DESCRIPTION]: 'Description',
  [CanonicalField.GST]: 'GST %',
  [CanonicalField.HSN]: 'HSN Code',
  [CanonicalField.IMAGE]: 'Image URL',
  [CanonicalField.SKU]: 'SKU / Code',
  [CanonicalField.KITCHEN]: 'Kitchen Station',
  [CanonicalField.PRINTER]: 'Printer',
  [CanonicalField.PREPARATION_TIME]: 'Preparation Time',
  [CanonicalField.IS_AVAILABLE]: 'Available',
  [CanonicalField.MENU_TYPE]: 'Menu Type (FOOD/LIQUOR)',
  [CanonicalField.UNIT]: 'Unit',
};

/** Required fields for a menu row to be importable. */
export const REQUIRED_FIELDS: CanonicalField[] = [CanonicalField.NAME];

const CANONICAL_FIELD_VALUES = new Set<string>(Object.values(CanonicalField));

/**
 * Type guard for untrusted field strings (client request bodies, persisted
 * MenuColumnMapping rows, AI responses). Anything that is not an exact
 * CanonicalField value must be treated as "ignore this column" rather than
 * being cast, otherwise unknown keys silently reach the normalizer.
 */
export function isCanonicalField(value: unknown): value is CanonicalField {
  return typeof value === 'string' && CANONICAL_FIELD_VALUES.has(value);
}
