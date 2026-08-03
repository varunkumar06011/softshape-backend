// ─────────────────────────────────────────────────────────────────────────────
// pdfParser — parses .pdf files into RawImportData.
// ─────────────────────────────────────────────────────────────────────────────
// Strategy:
//   1. Extract text via pdf-parse.
//   2. Run the line-by-line rule-based extractor (category headers, prices,
//      dotted leaders, half/full variants).
//   3. If the rule-based result is low-confidence (few items, many warnings),
//      fall back to the AI provider's vision parser (renders PDF pages to
//      images and sends them to the LLM).
//
// Output is always RawImportData with requiresMapping=false — the AI already
// produced structured rows, so no column-mapping screen is needed.
// ─────────────────────────────────────────────────────────────────────────────

import type { NormalizedRow } from '../../../lib/import/NormalizedRow';
import type { RawImportData } from '../../../lib/import/RawImportData';
import { hasAIProvider, parseMenuImageWithAI } from '../../ai';
import {
  extractItemName,
  extractPrices,
  extractVariantPrices,
  inferCategoryFromName,
  inferMenuTypeFromCategory,
  inferVeg,
  isCategoryHeader,
  isGarbageLine,
} from '../menuHelpers';

/** Rule-based text extraction → NormalizedRow[]. */
function extractRowsFromText(text: string, restaurantType?: string): { rows: NormalizedRow[]; warnings: string[]; confidence: 'HIGH' | 'MEDIUM' | 'LOW' } {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const warnings: string[] = [];
  const rows: NormalizedRow[] = [];
  let currentCategory = 'Uncategorized';
  let rowIndex = 1;

  for (const line of lines) {
    if (isGarbageLine(line)) continue;

    if (isCategoryHeader(line)) {
      currentCategory = line.replace(/:$/, '').trim();
      continue;
    }

    // Half/full variant pricing (e.g. "Paneer Tikka .... 120/140")
    const variantPrices = extractVariantPrices(line);
    if (variantPrices) {
      const name = extractItemName(line, variantPrices.half);
      if (name && name.length >= 2) {
        rows.push({
          index: rowIndex++,
          category: currentCategory,
          name,
          price: variantPrices.half,
          isVeg: inferVeg(name),
          description: '',
          menuType: inferMenuTypeFromCategory(currentCategory),
          variants: [
            { name: 'Half', price: variantPrices.half, isDefault: true },
            { name: 'Full', price: variantPrices.full, isDefault: false },
          ],
        });
      }
      continue;
    }

    const prices = extractPrices(line);
    if (prices.length === 0) continue;

    if (prices.length > 1) {
      warnings.push(`Line "${line.slice(0, 80)}" contained multiple prices — please verify extracted items manually.`);
      const parts = line.split(/(?=\d{2,5})/).filter(p => p.trim().length > 0);
      for (const part of parts) {
        const partPrices = extractPrices(part);
        if (partPrices.length === 0) continue;
        const price = partPrices[partPrices.length - 1];
        const name = extractItemName(part, price);
        if (name && name.length >= 2 && price > 0) {
          rows.push({
            index: rowIndex++,
            category: currentCategory,
            name,
            price,
            isVeg: inferVeg(name),
            description: '',
            menuType: inferMenuTypeFromCategory(currentCategory),
          });
        }
      }
      continue;
    }

    const price = prices[0];
    const name = extractItemName(line, price);
    if (name && name.length >= 2 && price > 0) {
      rows.push({
        index: rowIndex++,
        category: currentCategory,
        name,
        price,
        isVeg: inferVeg(name),
        description: '',
        menuType: inferMenuTypeFromCategory(currentCategory),
      });
    }
  }

  // Category inference for uncategorized rows
  for (const row of rows) {
    if (row.category === 'Uncategorized' || !row.category) {
      row.category = inferCategoryFromName(row.name, restaurantType);
      row.categoryInferred = true;
    }
  }

  // Flag categories with only 1 item (possible false-positive category detection)
  const categoryCounts = new Map<string, number>();
  for (const row of rows) {
    const cat = row.category || 'Uncategorized';
    categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
  }
  for (const [catName, count] of categoryCounts.entries()) {
    if (count === 1) {
      warnings.push(`"${catName}" was detected as a category but only has 1 item — please verify it is not an item name.`);
    }
  }

  if (rows.length === 0) {
    warnings.push('No menu items detected in PDF. Please verify the file format.');
  }

  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
    rows.length === 0 ? 'LOW' :
    rows.length >= 10 && warnings.length <= 2 ? 'HIGH' :
    rows.length >= 3 && warnings.length <= 5 ? 'MEDIUM' : 'LOW';

  if (confidence === 'LOW' && rows.length > 0) {
    warnings.push('Only a few items were detected — confidence is LOW. Please review the output.');
  }

  return { rows, warnings, confidence };
}

/** Convert AI parse result into NormalizedRow[]. */
function aiResultToRows(
  rows: Array<{ category: string; name: string; price: number; isVeg: boolean; menuType: string; description: string; variants?: Array<{ name: string; price: number; isDefault: boolean }> }>,
  warnings: string[],
): NormalizedRow[] {
  return rows.map((r, i) => ({
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
}

/**
 * Parse a PDF buffer into RawImportData.
 * Tries text extraction first, falls back to AI vision when confidence is low.
 */
export async function parsePdf(buffer: Buffer, restaurantType?: string): Promise<RawImportData> {
  const warnings: string[] = [];

  // Step 1: text extraction
  let textRows: NormalizedRow[] = [];
  let textWarnings: string[] = [];
  let textConfidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';

  try {
    const pdfParseModule: any = await import('pdf-parse');
    const PDFParseClass = pdfParseModule.PDFParse || pdfParseModule.default || pdfParseModule;
    const parser = new PDFParseClass({ data: buffer, verbosity: 0 });
    const result = await parser.getText();
    const text = result.text || '';
    const extracted = extractRowsFromText(text, restaurantType);
    textRows = extracted.rows;
    textWarnings = extracted.warnings;
    textConfidence = extracted.confidence;
  } catch (err: any) {
    textWarnings.push(`Text extraction failed: ${err.message}`);
  }

  // Step 2: AI fallback when text extraction is weak
  if (textConfidence === 'LOW' && hasAIProvider()) {
    try {
      const aiResult = await parseMenuImageWithAI(buffer, 'application/pdf', restaurantType);
      const aiRows = aiResultToRows(aiResult.rows, aiResult.warnings);
      // Use AI result if it found more items than text extraction
      if (aiRows.length > textRows.length) {
        return {
          fileType: 'pdf',
          columns: [],
          suggestedMapping: [],
          rows: [],
          normalizedRows: aiRows,
          requiresMapping: false,
          warnings: [...textWarnings, ...aiResult.warnings],
        };
      }
    } catch (err: any) {
      textWarnings.push(`AI parsing failed: ${err.message}`);
    }
  }

  return {
    fileType: 'pdf',
    columns: [],
    suggestedMapping: [],
    rows: [],
    normalizedRows: textRows,
    requiresMapping: false,
    warnings: textWarnings,
  };
}
