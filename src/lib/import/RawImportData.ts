// ─────────────────────────────────────────────────────────────────────────────
// RawImportData — the output of every parser, before normalization.
// ─────────────────────────────────────────────────────────────────────────────
// Every file type (excel, csv, pdf, image) produces this same shape. The
// downstream normalizer / validator / importer never know which file type
// produced the data.
//
// `requiresMapping` is the only signal the frontend needs:
//   true  → show the column-mapping screen (excel/csv)
//   false → skip straight to preview (pdf/image — AI already structured it)
//
// The parser does NOT know what screen the frontend will show. It only
// reports whether mapping is required.
// ─────────────────────────────────────────────────────────────────────────────

import { CanonicalField } from './CanonicalField';
import { MappingSource } from './MappingSource';

/** A single raw row from the file, preserving its original line number. */
export interface RawRow {
  /** 1-based original row number in the source file (for error reporting). */
  index: number;
  /** Raw cell values, aligned by index with `columns` in the parent RawImportData. */
  cells: any[];
}

/** Per-column mapping suggestion produced by header detection. */
export interface ColumnMapping {
  /** Canonical field this column maps to, or null = ignored. */
  field: CanonicalField | null;
  /** How the mapping was derived. */
  source: MappingSource;
}

export type ImportFileType = 'excel' | 'csv' | 'pdf' | 'image';

export interface RawImportData {
  fileType: ImportFileType;
  /** Raw column header names from the file (empty for pdf/image). */
  columns: string[];
  /** Per-column suggested mapping, aligned by index with `columns`. */
  suggestedMapping: ColumnMapping[];
  /** Raw rows (excel/csv). Empty when `requiresMapping` is false. */
  rows: RawRow[];
  /**
   * Pre-normalized rows (pdf/image). Populated when the parser already
   * produced structured data and no mapping step is needed. Empty for
   * excel/csv until the normalizer runs.
   */
  normalizedRows?: import('./NormalizedRow').NormalizedRow[];
  /** True for excel/csv (user must confirm column mapping). False for pdf/image. */
  requiresMapping: boolean;
  /** Non-fatal parser warnings (e.g. "skipped 3 blank rows"). */
  warnings: string[];
  /** Rate-card mode bypasses the mapping screen — venue columns are special. */
  isRateCard?: boolean;
  /** Venue header names, only when isRateCard is true. */
  venueHeaders?: string[];
}
