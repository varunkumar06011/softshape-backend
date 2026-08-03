// ─────────────────────────────────────────────────────────────────────────────
// excelParser — parses .xlsx / .xls / .csv files into RawImportData.
// ─────────────────────────────────────────────────────────────────────────────
// One responsibility: convert a spreadsheet file into the canonical
// RawImportData shape. Does NOT normalize, validate, or import — that's the
// shared pipeline's job.
//
// Handles three layouts:
//   1. Rate-card (items × venue price matrix) — detected via detectRateCardLayout
//   2. Multi-block (header row preceded by a category row)
//   3. Standard (header row on row 0, items below)
//
// For layouts 1 and 2, normalizedRows are produced directly (requiresMapping=false).
// For layout 3, the columns + suggestedMapping are returned (requiresMapping=true)
// and the user confirms the mapping in the UI before normalization.
// ─────────────────────────────────────────────────────────────────────────────

import xlsx from 'xlsx';
import logger from '../../../lib/logger';
import { CanonicalField } from '../../../lib/import/CanonicalField';
import { MappingSource } from '../../../lib/import/MappingSource';
import type { ColumnMapping, RawImportData, RawRow } from '../../../lib/import/RawImportData';
import type { NormalizedRow } from '../../../lib/import/NormalizedRow';
import { matchHeaders, mergeAIMappings, normalizeHeader } from '../headerSynonyms';
import { mapHeadersWithAI, hasAIProvider } from '../../ai';
import {
  detectItemHeaderRow,
  detectRateCardLayout,
  inferCategoryFromName,
  inferMenuTypeFromCategory,
  inferVeg,
  isHeaderKeyword,
  isPureNumber,
  parseMultiBlockLayout,
  parsePrice,
  parseRateCardMatrix,
} from '../menuHelpers';

/** Read a spreadsheet buffer into a 2D matrix (header: 1 = raw rows). */
function readMatrix(buffer: Buffer): any[][] {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json<any[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: true,
  });
}

/** Find the first non-empty row to use as the header row. */
function findHeaderRowIndex(rawMatrix: any[][]): number {
  for (let r = 0; r < Math.min(20, rawMatrix.length); r++) {
    const row = rawMatrix[r] || [];
    const nonEmpty = row.filter(c => String(c || '').trim() !== '').length;
    if (nonEmpty >= 2) return r;
  }
  return 0;
}

/** Auto-detect the name column when no header matched: text-heavy, low numeric ratio. */
function autoDetectNameColumn(rawMatrix: any[][], headerRowIndex: number, colMap: Map<number, CanonicalField>): number {
  const headerRow = rawMatrix[headerRowIndex] || [];
  for (let c = 0; c < headerRow.length; c++) {
    if (colMap.has(c)) continue;
    let textCount = 0;
    let numericCount = 0;
    let sampleCount = 0;
    for (let r = headerRowIndex + 1; r < Math.min(headerRowIndex + 16, rawMatrix.length); r++) {
      const val = rawMatrix[r]?.[c];
      if (val === undefined || val === null || String(val).trim() === '') continue;
      sampleCount++;
      if (isPureNumber(val)) {
        numericCount++;
      } else {
        textCount++;
      }
    }
    if (sampleCount >= 3 && textCount / sampleCount >= 0.8) {
      return c;
    }
  }
  return -1;
}

/** Auto-detect the price column when no header matched: numeric-heavy. */
function autoDetectPriceColumn(rawMatrix: any[][], headerRowIndex: number, colMap: Map<number, CanonicalField>, nameCol: number): number {
  const headerRow = rawMatrix[headerRowIndex] || [];
  const startCol = nameCol >= 0 ? nameCol + 1 : 0;
  for (let c = startCol; c < headerRow.length; c++) {
    if (colMap.has(c)) continue;
    let numericCount = 0;
    let sampleCount = 0;
    for (let r = headerRowIndex + 1; r < Math.min(headerRowIndex + 16, rawMatrix.length); r++) {
      const val = rawMatrix[r]?.[c];
      if (val === undefined || val === null || String(val).trim() === '') continue;
      sampleCount++;
      if (isPureNumber(val) || parsePrice(val) > 0) numericCount++;
    }
    if (sampleCount >= 3 && numericCount / sampleCount >= 0.8) {
      return c;
    }
  }
  return -1;
}

/** Build suggestedMapping from rule-based matching + AI fallback for unmapped columns. */
async function buildSuggestedMapping(
  columns: string[],
  rawMatrix: any[][],
  headerRowIndex: number,
): Promise<ColumnMapping[]> {
  const ruleMatches = matchHeaders(columns);
  const colMap = new Map<number, CanonicalField>();
  ruleMatches.forEach((m, i) => {
    if (m.field) colMap.set(i, m.field);
  });

  // Auto-detect name and price columns if rules didn't find them
  if (!colMapHas(ruleMatches, CanonicalField.NAME)) {
    const nameCol = autoDetectNameColumn(rawMatrix, headerRowIndex, colMap);
    if (nameCol >= 0) {
      ruleMatches[nameCol] = { field: CanonicalField.NAME, source: MappingSource.FUZZY };
      colMap.set(nameCol, CanonicalField.NAME);
    }
  }
  if (!colMapHas(ruleMatches, CanonicalField.PRICE)) {
    const nameCol = colMapHas(ruleMatches, CanonicalField.NAME)
      ? ruleMatches.findIndex(m => m.field === CanonicalField.NAME)
      : -1;
    const priceCol = autoDetectPriceColumn(rawMatrix, headerRowIndex, colMap, nameCol);
    if (priceCol >= 0) {
      ruleMatches[priceCol] = { field: CanonicalField.PRICE, source: MappingSource.FUZZY };
    }
  }

  // AI fallback for any remaining unmapped columns
  const unmappedIndices = ruleMatches
    .map((m, i) => (m.field === null ? i : -1))
    .filter(i => i >= 0);

  if (unmappedIndices.length > 0 && hasAIProvider()) {
    try {
      const aiMappings = await mapHeadersWithAI(columns);
      return mergeAIMappings(ruleMatches, aiMappings);
    } catch (err: any) {
      // Non-fatal: keep rule-based results (unmapped columns stay null and the
      // user maps them by hand), but surface why AI assistance was unavailable.
      logger.warn(
        { err: err?.message, unmappedColumns: unmappedIndices.length },
        '[excelParser] AI header mapping failed — falling back to rule-based mapping',
      );
    }
  }

  return ruleMatches;
}

function colMapHas(matches: { field: CanonicalField | null }[], field: CanonicalField): boolean {
  return matches.some(m => m.field === field);
}

/** Convert a standard-layout matrix into RawImportData with mapping required. */
async function parseStandardLayout(
  rawMatrix: any[][],
  warnings: string[],
): Promise<RawImportData> {
  const headerRowIndex = findHeaderRowIndex(rawMatrix);
  const headerRow = rawMatrix[headerRowIndex] || [];

  if (rawMatrix.length < 2 || headerRow.length === 0) {
    return {
      fileType: 'excel',
      columns: [],
      suggestedMapping: [],
      rows: [],
      requiresMapping: true,
      warnings: ['Empty sheet — no rows found'],
    };
  }

  const columns = headerRow.map(c => String(c || '').trim());
  const suggestedMapping = await buildSuggestedMapping(columns, rawMatrix, headerRowIndex);

  const rows: RawRow[] = [];
  for (let r = headerRowIndex + 1; r < rawMatrix.length; r++) {
    const rawRow = rawMatrix[r] || [];
    // Skip completely empty rows
    const nonEmpty = rawRow.filter(c => String(c || '').trim() !== '').length;
    if (nonEmpty === 0) continue;
    rows.push({ index: r + 1, cells: rawRow });
  }

  return {
    fileType: 'excel',
    columns,
    suggestedMapping,
    rows,
    requiresMapping: true,
    warnings,
  };
}

/** Convert a multi-block layout result into RawImportData (no mapping needed). */
function parseMultiBlockResult(
  rawMatrix: any[][],
  headerRowIndex: number,
  warnings: string[],
): RawImportData {
  const result = parseMultiBlockLayout(rawMatrix, headerRowIndex, warnings);
  const normalizedRows: NormalizedRow[] = result.rows.map((r, i) => ({
    index: i + 1,
    name: r.name,
    price: r.price,
    category: r.category || 'Uncategorized',
    isVeg: r.isVeg ?? true,
    description: r.description || '',
    menuType: r.menuType,
    categoryInferred: r.category === 'Uncategorized',
  }));
  return {
    fileType: 'excel',
    columns: [],
    suggestedMapping: [],
    rows: [],
    normalizedRows,
    requiresMapping: false,
    warnings: result.warnings,
  };
}

/** Convert a rate-card result into RawImportData (no mapping needed). */
function parseRateCardResult(
  rawMatrix: any[][],
  layout: ReturnType<typeof detectRateCardLayout>,
  warnings: string[],
  restaurantType?: string,
): RawImportData {
  const result = parseRateCardMatrix(rawMatrix, layout, warnings, restaurantType);
  const normalizedRows: NormalizedRow[] = result.rows.map((r, i) => ({
    index: i + 1,
    name: r.name,
    price: r.price,
    category: r.category || 'Uncategorized',
    isVeg: r.isVeg ?? true,
    description: r.description || '',
    menuType: r.menuType,
    unit: r.unit,
    isAvailable: r.isAvailable,
    venuePrices: r.venuePrices,
    categoryInferred: r.categoryInferred,
  }));
  return {
    fileType: 'excel',
    columns: [],
    suggestedMapping: [],
    rows: [],
    normalizedRows,
    requiresMapping: false,
    isRateCard: true,
    venueHeaders: result.venueHeaders,
    warnings: result.warnings,
  };
}

/**
 * Parse an Excel/CSV buffer into RawImportData.
 * The `savedMappings` parameter (originalHeader → CanonicalField) is applied
 * on top of auto-detected mappings for columns the restaurant has mapped before.
 */
export async function parseExcelOrCsv(
  buffer: Buffer,
  restaurantType?: string,
  savedMappings?: Record<string, CanonicalField>,
): Promise<RawImportData> {
  const rawMatrix = readMatrix(buffer);
  const warnings: string[] = [];

  // 1. Rate-card layout?
  const rateCardLayout = detectRateCardLayout(rawMatrix);
  if (rateCardLayout.isRateCard) {
    return parseRateCardResult(rawMatrix, rateCardLayout, warnings, restaurantType);
  }

  // 2. Multi-block layout? (header row preceded by a category row)
  const headerRowIndex = detectItemHeaderRow(rawMatrix);
  if (headerRowIndex > 0) {
    return parseMultiBlockResult(rawMatrix, headerRowIndex, warnings);
  }

  // 3. Standard layout — user confirms column mapping
  const result = await parseStandardLayout(rawMatrix, warnings);

  // Apply saved mappings on top of auto-detected ones
  if (savedMappings && Object.keys(savedMappings).length > 0) {
    result.suggestedMapping = result.suggestedMapping.map((m, i) => {
      const original = result.columns[i];
      const savedField = savedMappings[original] || savedMappings[original.trim().toLowerCase()];
      if (savedField) {
        return { field: savedField, source: MappingSource.SAVED };
      }
      return m;
    });
  }

  return result;
}
