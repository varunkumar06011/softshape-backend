// ─────────────────────────────────────────────────────────────────────────────
// MappingSource — how a column→field mapping was derived.
// ─────────────────────────────────────────────────────────────────────────────
// Replaces invented confidence percentages. The frontend colors badges by
// source; the backend never invents numeric confidence scores because AI
// providers do not reliably produce calibrated probabilities.
// ─────────────────────────────────────────────────────────────────────────────

export enum MappingSource {
  /** Header text exactly matches a canonical field name (e.g. "Name" → NAME). */
  EXACT = 'exact',
  /** Header text is a known synonym (e.g. "MRP" → PRICE). */
  SYNONYM = 'synonym',
  /** Header text is within Levenshtein distance ≤ 2 of a synonym. */
  FUZZY = 'fuzzy',
  /** AI provider mapped the column when rules + fuzzy failed. */
  AI = 'ai',
  /** Restaurant's previously-saved mapping for this header. Overrides auto-detection. */
  SAVED = 'saved',
  /** User manually selected the mapping in the dropdown. */
  MANUAL = 'manual',
}
