// ─────────────────────────────────────────────────────────────────────────────
// UploadResult — the single unified return type from every upload endpoint.
// ─────────────────────────────────────────────────────────────────────────────
// Every parser, the apply-mapping endpoint, and the bulk-import endpoint
// return this shape. The frontend stores it as one `ImportJob` state object
// and renders stages based on `requiresMapping` and which fields are populated.
//
// This is the only type the frontend needs to know about.
// ─────────────────────────────────────────────────────────────────────────────

import type { ColumnMapping, ImportFileType, RawRow } from './RawImportData';
import type { NormalizedRow } from './NormalizedRow';
import type { ImportError } from './ImportError';

export interface UploadResult {
  fileType: ImportFileType;
  /** Raw column header names (excel/csv). Empty for pdf/image. */
  columns: string[];
  /** Per-column mapping suggestion, aligned by index with `columns`. */
  suggestedMapping: ColumnMapping[];
  /** Raw rows (excel/csv). Empty when requiresMapping is false. */
  rows: RawRow[];
  /**
   * Normalized rows. Populated immediately for pdf/image, or after the
   * apply-mapping step for excel/csv.
   */
  normalizedRows: NormalizedRow[];
  /** True when the user must confirm column mapping (excel/csv). */
  requiresMapping: boolean;
  /** Non-fatal warnings from parser/normalizer. */
  warnings: string[];
  /** Per-row validation findings. */
  errors: ImportError[];
  /** Rate-card mode bypasses the mapping screen. */
  isRateCard?: boolean;
  /** Venue header names, only when isRateCard is true. */
  venueHeaders?: string[];
  /** Resolved venueId map (rate-card only, populated by importer). */
  venueMap?: Record<string, string>;
  /** Unmatched venue headers (rate-card only). */
  unmatchedVenues?: string[];
}
