// ─────────────────────────────────────────────────────────────────────────────
// importPipeline — orchestrates Parser → Normalizer → Validator.
// ─────────────────────────────────────────────────────────────────────────────
// This is the shared pipeline that every file type feeds into. The route
// handlers call these functions; they do not call parsers/normalizer/validator
// directly.
//
// The importer (DB writes) stays in menu.ts because it needs prisma and the
// rate-card venue-resolution logic that's coupled to the route layer.
// ─────────────────────────────────────────────────────────────────────────────

import { CanonicalField, isCanonicalField } from '../../lib/import/CanonicalField';
import { MappingSource } from '../../lib/import/MappingSource';
import type { ColumnMapping, RawImportData } from '../../lib/import/RawImportData';
import type { NormalizedRow } from '../../lib/import/NormalizedRow';
import type { UploadResult } from '../../lib/import/UploadResult';
import type { ImportError } from '../../lib/import/ImportError';
import { parseExcelOrCsv } from './parsers/excelParser';
import { parsePdf } from './parsers/pdfParser';
import { parseImage } from './parsers/imageParser';
import { normalize } from './normalizer';
import { validate, type RestaurantValidationContext, type ValidationResult } from './validator';

export type ImportFileType = 'excel' | 'csv' | 'pdf' | 'image';

/** Detect file type from the original filename extension. */
export function detectFileType(filename: string): ImportFileType | null {
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (ext === 'xlsx' || ext === 'xls') return 'excel';
  if (ext === 'csv') return 'csv';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') return 'image';
  return null;
}

/** MIME type for image files (used by the AI vision provider). */
function imageMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (ext === 'png') return 'image/png';
  return 'image/jpeg';
}

/**
 * Stage 1: Parse a file buffer into RawImportData.
 * Routes to the correct parser based on file type.
 */
export async function parseFile(
  buffer: Buffer,
  fileType: ImportFileType,
  filename: string,
  restaurantType?: string,
  savedMappings?: Record<string, CanonicalField>,
): Promise<RawImportData> {
  switch (fileType) {
    case 'excel':
    case 'csv':
      return parseExcelOrCsv(buffer, restaurantType, savedMappings);
    case 'pdf':
      return parsePdf(buffer, restaurantType);
    case 'image':
      return parseImage(buffer, imageMimeType(filename), restaurantType);
    default:
      throw new Error(`Unsupported file type: ${fileType}`);
  }
}

/**
 * Convert a RawImportData into the unified UploadResult for the frontend.
 * For excel/csv: normalizedRows is empty until the user confirms the mapping.
 * For pdf/image: normalizedRows is populated immediately.
 */
export function toUploadResult(data: RawImportData): UploadResult {
  return {
    fileType: data.fileType,
    columns: data.columns,
    suggestedMapping: data.suggestedMapping,
    rows: data.rows,
    normalizedRows: data.normalizedRows || [],
    requiresMapping: data.requiresMapping,
    warnings: data.warnings,
    errors: [],
    ...(data.isRateCard ? { isRateCard: true } : {}),
    ...(data.venueHeaders ? { venueHeaders: data.venueHeaders } : {}),
  };
}

/**
 * Stage 2+3: Apply a confirmed column mapping, normalize, and validate.
 * Used by the /apply-mapping endpoint after the user confirms the mapping UI.
 *
 * For pdf/image (requiresMapping=false): the mapping is ignored and the
 * parser's pre-normalized rows are validated directly.
 */
export function applyMappingAndValidate(
  data: RawImportData,
  mapping: ColumnMapping[],
  restaurantType?: string,
  ctx?: RestaurantValidationContext,
): { normalizedRows: NormalizedRow[]; errors: ImportError[]; invalidRowIndices: Set<number> } {
  const normalizedRows = normalize(data, mapping, restaurantType);
  const validation: ValidationResult = validate(normalizedRows, ctx);
  return {
    normalizedRows,
    errors: validation.errors,
    invalidRowIndices: validation.invalidRowIndices,
  };
}

/**
 * Validate pre-normalized rows (pdf/image) without a mapping step.
 * Used by the /upload endpoint for pdf/image files to return errors immediately.
 */
export function validateNormalized(
  rows: NormalizedRow[],
  ctx?: RestaurantValidationContext,
): { errors: ImportError[]; invalidRowIndices: Set<number> } {
  const validation = validate(rows, ctx);
  return { errors: validation.errors, invalidRowIndices: validation.invalidRowIndices };
}

/**
 * Convert a user-supplied mapping (colIndex → field string) into the
 * ColumnMapping[] shape, with source=MANUAL.
 *
 * The mapping arrives from the client, so each value is validated against the
 * CanonicalField enum. Unknown values are treated as "ignore this column"
 * instead of being cast, so a malformed request can never inject an unknown
 * field key into the normalizer.
 */
export function userMappingToColumnMappings(
  userMapping: Record<number, string | null>,
  length: number,
): ColumnMapping[] {
  const result: ColumnMapping[] = [];
  for (let i = 0; i < length; i++) {
    const fieldStr = userMapping[i];
    result.push({
      field: isCanonicalField(fieldStr) ? fieldStr : null,
      source: MappingSource.MANUAL,
    });
  }
  return result;
}
