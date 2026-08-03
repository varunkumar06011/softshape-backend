// ─────────────────────────────────────────────────────────────────────────────
// AIProvider — provider-agnostic interface for AI-assisted import operations.
// ─────────────────────────────────────────────────────────────────────────────
// Every consumer calls `mapHeadersWithAI(...)` or `parseMenuImageWithAI(...)`.
// No consumer imports a specific provider (Groq, OpenAI, Gemini, ...).
//
// To swap providers, implement AIProvider and call registerAIProvider() at
// startup. The active provider is selected by which API key is present in env.
// ─────────────────────────────────────────────────────────────────────────────

import type { CanonicalField } from '../../lib/import/CanonicalField';
import { MappingSource } from '../../lib/import/MappingSource';

/** Result of AI-mapping a single column header to a canonical field. */
export interface AIHeaderMapping {
  field: CanonicalField | null;
  source: MappingSource.AI;
}

/** Result of AI-parsing a menu image/PDF into structured rows. */
export interface AIMenuParseResult {
  rows: Array<{
    category: string;
    name: string;
    price: number;
    isVeg: boolean;
    menuType: string;
    description: string;
    variants?: Array<{ name: string; price: number; isDefault: boolean }>;
  }>;
  warnings: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface AIProvider {
  /** Name used for logging only (e.g. "groq", "openai"). */
  readonly name: string;

  /**
   * Map a list of column header strings to canonical fields.
   * Returns one AIHeaderMapping per input column, in the same order.
   * Use null for columns that should be ignored.
   */
  mapHeaders(columns: string[]): Promise<AIHeaderMapping[]>;

  /**
   * Parse a menu image (JPEG/PNG buffer) or PDF buffer into structured rows.
   * Used by the image and PDF parsers when rule-based extraction is weak.
   */
  parseMenuImage(buffer: Buffer, mimeType: string, restaurantType?: string): Promise<AIMenuParseResult>;
}

// ── Active-provider registry ──────────────────────────────────────────────────

let activeProvider: AIProvider | null = null;

/** Register the active AI provider. Called once at startup. */
export function registerAIProvider(provider: AIProvider): void {
  activeProvider = provider;
}

/** True when an AI provider is registered (i.e. an API key was configured). */
export function hasAIProvider(): boolean {
  return activeProvider !== null;
}

/**
 * Map headers via the active AI provider.
 * Throws if no provider is registered — callers should check hasAIProvider().
 */
export async function mapHeadersWithAI(columns: string[]): Promise<AIHeaderMapping[]> {
  if (!activeProvider) throw new Error('No AI provider configured');
  return activeProvider.mapHeaders(columns);
}

/**
 * Parse a menu image/PDF via the active AI provider.
 * Throws if no provider is registered — callers should check hasAIProvider().
 */
export async function parseMenuImageWithAI(
  buffer: Buffer,
  mimeType: string,
  restaurantType?: string,
): Promise<AIMenuParseResult> {
  if (!activeProvider) throw new Error('No AI provider configured');
  return activeProvider.parseMenuImage(buffer, mimeType, restaurantType);
}
