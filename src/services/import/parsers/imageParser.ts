// ─────────────────────────────────────────────────────────────────────────────
// imageParser — parses .jpg / .jpeg / .png files into RawImportData.
// ─────────────────────────────────────────────────────────────────────────────
// Delegates entirely to the active AI provider's vision parser. The AI
// extracts structured menu rows directly, so requiresMapping is always false
// and the user goes straight to the preview screen.
//
// If no AI provider is configured, returns an empty result with a warning.
// ─────────────────────────────────────────────────────────────────────────────

import type { NormalizedRow } from '../../../lib/import/NormalizedRow';
import type { RawImportData } from '../../../lib/import/RawImportData';
import { hasAIProvider, parseMenuImageWithAI } from '../../ai';

/**
 * Parse an image buffer into RawImportData via the AI vision provider.
 * `mimeType` should be 'image/jpeg' or 'image/png'.
 */
export async function parseImage(
  buffer: Buffer,
  mimeType: string,
  restaurantType?: string,
): Promise<RawImportData> {
  if (!hasAIProvider()) {
    return {
      fileType: 'image',
      columns: [],
      suggestedMapping: [],
      rows: [],
      normalizedRows: [],
      requiresMapping: false,
      warnings: ['No AI provider configured — image parsing requires GROQ_API_KEY or another AI provider key.'],
    };
  }

  try {
    const aiResult = await parseMenuImageWithAI(buffer, mimeType, restaurantType);
    const normalizedRows: NormalizedRow[] = aiResult.rows.map((r, i) => ({
      index: i + 1,
      category: r.category || 'Uncategorized',
      name: r.name,
      price: r.price,
      isVeg: r.isVeg ?? true,
      description: r.description || '',
      menuType: r.menuType || 'FOOD',
      categoryInferred: true,
      ...(r.variants ? { variants: r.variants } : {}),
    }));

    return {
      fileType: 'image',
      columns: [],
      suggestedMapping: [],
      rows: [],
      normalizedRows,
      requiresMapping: false,
      warnings: aiResult.warnings,
    };
  } catch (err: any) {
    return {
      fileType: 'image',
      columns: [],
      suggestedMapping: [],
      rows: [],
      normalizedRows: [],
      requiresMapping: false,
      warnings: [`Image parsing failed: ${err.message}`],
    };
  }
}
