// ─────────────────────────────────────────────────────────────────────────────
// GroqProvider — AIProvider implementation backed by the Groq API.
// ─────────────────────────────────────────────────────────────────────────────
// This is the ONLY file in the codebase that knows about Groq. Every other
// consumer calls mapHeadersWithAI() / parseMenuImageWithAI() from AIProvider.
//
// To add an OpenAI or Gemini provider, implement AIProvider in a new file and
// register it in index.ts instead of (or alongside) this one.
// ─────────────────────────────────────────────────────────────────────────────

import logger from '../../lib/logger';
import { CANONICAL_FIELD_LABELS, MENU_CANONICAL_FIELDS, isCanonicalField } from '../../lib/import/CanonicalField';
import { MappingSource } from '../../lib/import/MappingSource';
import type { AIHeaderMapping, AIProvider, AIMenuParseResult } from './AIProvider';
import { parseMenuWithGroq } from '../groqMenuParser';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

function buildHeaderMappingPrompt(columns: string[]): string {
  const fieldList = MENU_CANONICAL_FIELDS
    .map(f => `  - "${f}": ${CANONICAL_FIELD_LABELS[f]}`)
    .join('\n');

  const columnList = columns
    .map((c, i) => `  ${i}: "${c}"`)
    .join('\n');

  return `You are a spreadsheet column mapper for a restaurant POS menu import.

Given these spreadsheet column headers (by index):
${columnList}

Map each column to exactly ONE of these canonical fields, or null if it should be ignored:
${fieldList}

Return a JSON object with this exact shape:
{
  "mappings": [
    { "index": 0, "field": "name" },
    { "index": 1, "field": "price" },
    { "index": 2, "field": null }
  ]
}

Rules:
- Return one entry per input column, in any order, but every column index must appear exactly once.
- "field" must be one of the canonical field strings listed above, or null.
- Use null for columns that are not relevant to a menu (e.g. row numbers, internal IDs, dates, totals).
- Common mappings: "Dish Name"/"Item"/"Product" → "name"; "MRP"/"Rate"/"Amount"/"Price" → "price"; "Category"/"Section"/"Department"/"Food Group" → "category"; "Veg"/"Veg/Non-Veg" → "isVeg"; "GST"/"Tax" → "gst"; "HSN" → "hsn"; "Description"/"Details" → "description"; "Image"/"Photo" → "image"; "SKU"/"Code" → "sku".
- Do NOT include any text outside the JSON object.`;
}

interface GroqMappingResponse {
  mappings: Array<{ index: number; field: string | null }>;
}

async function callGroqText(prompt: string): Promise<string> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set');
  }

  const body = {
    model: GROQ_TEXT_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_completion_tokens: 2000,
    response_format: { type: 'json_object' },
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API error ${response.status}: ${errText.slice(0, 500)}`);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Groq API returned empty content');
    return content;
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error('Groq API request timed out after 30s');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function parseMappingResponse(content: string, columnCount: number): GroqMappingResponse {
  const parsed = JSON.parse(content) as GroqMappingResponse;
  if (!parsed.mappings || !Array.isArray(parsed.mappings)) {
    throw new Error('Groq returned invalid mapping structure');
  }
  // Validate every column index is present
  const seen = new Set<number>();
  for (const m of parsed.mappings) {
    if (typeof m.index !== 'number' || m.index < 0 || m.index >= columnCount) {
      throw new Error(`Groq returned invalid column index: ${m.index}`);
    }
    seen.add(m.index);
  }
  if (seen.size !== columnCount) {
    // Fill missing indices with null — partial mapping is acceptable
    for (let i = 0; i < columnCount; i++) {
      if (!seen.has(i)) parsed.mappings.push({ index: i, field: null });
    }
  }
  return parsed;
}

export class GroqProvider implements AIProvider {
  readonly name = 'groq';

  async mapHeaders(columns: string[]): Promise<AIHeaderMapping[]> {
    if (columns.length === 0) return [];

    const prompt = buildHeaderMappingPrompt(columns);
    const content = await callGroqText(prompt);
    const parsed = parseMappingResponse(content, columns.length);

    // Build result aligned with input column order
    const byIndex = new Map<number, string | null>();
    for (const m of parsed.mappings) byIndex.set(m.index, m.field);

    const result: AIHeaderMapping[] = columns.map((_, i) => {
      const field = byIndex.get(i);
      return {
        field: isCanonicalField(field) ? field : null,
        source: MappingSource.AI,
      };
    });

    logger.info({ provider: this.name, mapped: result.filter(r => r.field).length, total: columns.length }, '[ai] header mapping complete');
    return result;
  }

  async parseMenuImage(buffer: Buffer, mimeType: string, restaurantType?: string): Promise<AIMenuParseResult> {
    // Reuse the existing Groq vision parser — it already handles PDF rendering
    // and image preprocessing. The buffer is treated as a PDF or image buffer.
    const result = await parseMenuWithGroq(buffer, restaurantType);
    return {
      rows: result.rows.map(r => ({
        category: r.category,
        name: r.name,
        price: r.price,
        isVeg: r.isVeg,
        menuType: r.menuType,
        description: r.description,
        ...(r.variants ? { variants: r.variants } : {}),
      })),
      warnings: result.warnings,
      confidence: result.confidence,
    };
  }
}
