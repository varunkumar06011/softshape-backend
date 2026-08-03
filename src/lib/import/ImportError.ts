// ─────────────────────────────────────────────────────────────────────────────
// ImportError — a single validation finding for one row.
// ─────────────────────────────────────────────────────────────────────────────
// `severity` drives frontend coloring:
//   ERROR   → red, row will NOT be imported
//   WARNING → yellow, row WILL be imported but needs review
//   INFO    → blue, informational (e.g. duplicate of existing item)
//
// `code` is a stable machine-readable identifier so the frontend can group
// or filter errors without parsing the message string.
// ─────────────────────────────────────────────────────────────────────────────

import type { NormalizedRow } from './NormalizedRow';

export type ImportSeverity = 'ERROR' | 'WARNING' | 'INFO';

export interface ImportError {
  /** 1-based original row number in the source file. */
  rowIndex: number;
  severity: ImportSeverity;
  /** Stable code, e.g. MISSING_NAME, INVALID_PRICE, DUPLICATE_NAME. */
  code: string;
  /** Human-readable explanation. */
  message: string;
  /** The row that failed, when available, for inline display. */
  data?: NormalizedRow;
}

/** Stable error codes used throughout the validator and importer. */
export const ImportErrorCode = {
  MISSING_NAME: 'MISSING_NAME',
  NAME_TOO_SHORT: 'NAME_TOO_SHORT',
  INVALID_PRICE: 'INVALID_PRICE',
  PRICE_ZERO: 'PRICE_ZERO',
  PRICE_NEGATIVE: 'PRICE_NEGATIVE',
  INVALID_GST: 'INVALID_GST',
  DUPLICATE_NAME: 'DUPLICATE_NAME',
  DUPLICATE_EXISTING: 'DUPLICATE_EXISTING',
  LIQUOR_IN_NON_BAR: 'LIQUOR_IN_NON_BAR',
} as const;

export type ImportErrorCodeValue = typeof ImportErrorCode[keyof typeof ImportErrorCode];
