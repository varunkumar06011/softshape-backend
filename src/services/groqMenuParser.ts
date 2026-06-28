// ─────────────────────────────────────────────────────────────────────────────
// Groq Menu Parser Service — AI-powered menu image parsing via Groq API
// ─────────────────────────────────────────────────────────────────────────────
// Uses the Groq multimodal LLM API to parse menu images (photos or scans)
// and extract structured menu data: categories, item names, prices, veg/non-veg,
// variants, and descriptions.
//
// Flow:
//   1. Image is loaded and preprocessed via @napi-rs/canvas (resize, enhance)
//   2. Image is sent to Groq API with a structured prompt
//   3. LLM response is parsed into ParsedRow[] with confidence scoring
//   4. Categories are matched against predefined category list
//   5. Variants (e.g. 30ml/60ml/full) are detected for liquor items
//
// Returns: ParseResult { rows, warnings, confidence }
// Confidence levels: HIGH (clear image, well-structured), MEDIUM (some ambiguity),
// LOW (poor image quality or unusual format).
// ─────────────────────────────────────────────────────────────────────────────

import { createCanvas, type Canvas } from '@napi-rs/canvas';
import logger from '../lib/logger';
import { buildCategoryListForPrompt } from '../lib/predefinedCategories';

// Represents a single parsed menu item from the AI response
export interface ParsedRow {
  category: string;
  name: string;
  price: number;
  isVeg: boolean;
  menuType: string;
  description: string;
  categoryInferred?: boolean;
  variants?: Array<{ name: string; price: number; isDefault: boolean }>;
}

export interface ParseResult {
  rows: ParsedRow[];
  warnings: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const MAX_PAGES = 10;
const RENDER_SCALE = 2.0;
const JPEG_QUALITY = 0.85;

function buildMenuPrompt(restaurantType?: string): string {
  const categoryList = buildCategoryListForPrompt(restaurantType);
  const isBarType = restaurantType === 'BAR_LOUNGE' || restaurantType === 'BAR_WITH_DINING';

  return `You are a restaurant menu parser. Extract ALL menu items visible on this menu page image.

Return a JSON object with this exact structure:
{
  "categories": [
    {
      "name": "Category name",
      "items": [
        {
          "name": "Item name",
          "price": 0,
          "isVeg": true,
          "menuType": "FOOD",
          "variants": [
            { "name": "Half", "price": 120, "isDefault": true },
            { "name": "Full", "price": 240, "isDefault": false }
          ]
        }
      ]
    }
  ]
}

Rules:
- Use ONLY these predefined ${isBarType ? 'FOOD and LIQUOR' : ''} categories:
${categoryList}
- If an item doesn't match any predefined category, pick the closest one
- For food items with Half/Full pricing shown, create variants with names "Half" and "Full"
- For liquor items with size-based pricing (30ml, 90ml, 180ml, 750ml/Full Bottle), create variants with those exact names
- If a single price is shown, set price to that value and create one variant: { "name": "Regular", "price": X, "isDefault": true }
- Set isVeg: true for vegetarian items (paneer, dal, mushroom, vegetable, cheese, gobi, aloo, corn, kheema), false for non-veg (chicken, mutton, fish, prawn, egg, beef, pork, crab, biryani)
- Set menuType: "LIQUOR" for alcohol (beer, whisky, vodka, rum, gin, brandy, wine, cocktail, mocktail, shot, liquor, spirit, draught, draft), "FOOD" for everything else
- Ignore page numbers, phone numbers, addresses, FSSAI numbers, GST numbers, social media handles, website URLs
- Ignore decorative text, restaurant names, logos, watermarks
- If a category header is visible, use it as the category name but map it to the closest predefined category from the list above
- For items with "B/L" (boneless) suffix, keep it in the name
- If prices are shown in Indian Rupees (₹), extract the numeric value only
- If an item has multiple prices for different sizes/portions, create variants for each size
- Return empty categories array if no menu items are visible on this page
- Do NOT include any explanation text outside the JSON object`;
}

async function renderPdfToImages(pdfBuffer: Buffer): Promise<Buffer[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { GlobalWorkerOptions } = pdfjs;

  // Disable worker — run in main thread (simpler for Node.js)
  GlobalWorkerOptions.workerSrc = '';

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    useSystemFonts: true,
  } as any);

  const doc = await loadingTask.promise;
  const numPages = Math.min(doc.numPages, MAX_PAGES);
  const images: Buffer[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas: Canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');

    // @napi-rs/canvas context is compatible with what pdfjs expects
    await page.render({
      canvasContext: ctx as any,
      viewport,
    } as any).promise;

    const jpegBuffer = canvas.toBuffer('image/jpeg', JPEG_QUALITY);
    images.push(jpegBuffer);
  }

  await (doc as any).destroy();
  return images;
}

interface GroqCategoryResponse {
  categories: Array<{
    name: string;
    items: Array<{
      name: string;
      price: number;
      isVeg?: boolean;
      menuType?: string;
      variants?: Array<{ name: string; price: number; isDefault?: boolean }>;
    }>;
  }>;
}

async function callGroqVision(
  imageBase64: string,
  restaurantType?: string,
): Promise<GroqCategoryResponse> {
  const prompt = buildMenuPrompt(restaurantType);

  const body = {
    model: GROQ_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`,
            },
          },
        ],
      },
    ],
    temperature: 0.1,
    max_completion_tokens: 4000,
    response_format: { type: 'json_object' },
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

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
    if (!content) {
      throw new Error('Groq API returned empty content');
    }

    const parsed = JSON.parse(content) as GroqCategoryResponse;
    if (!parsed.categories || !Array.isArray(parsed.categories)) {
      throw new Error('Groq API returned invalid structure — missing categories array');
    }

    return parsed;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('Groq API request timed out after 60s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeGroqResponse(
  pageResults: GroqCategoryResponse[],
  warnings: string[],
): ParseResult {
  const rows: ParsedRow[] = [];

  for (const page of pageResults) {
    for (const cat of page.categories || []) {
      for (const item of cat.items || []) {
        if (!item.name || typeof item.name !== 'string') continue;

        const price = Number(item.price) || 0;
        const variants = Array.isArray(item.variants) && item.variants.length > 0
          ? item.variants.map((v, i) => ({
              name: String(v.name || 'Regular'),
              price: Number(v.price) || 0,
              isDefault: v.isDefault ?? i === 0,
            }))
          : undefined;

        rows.push({
          category: String(cat.name || 'Uncategorized').trim(),
          name: String(item.name).trim(),
          price,
          isVeg: item.isVeg ?? true,
          menuType: item.menuType || 'FOOD',
          description: '',
          categoryInferred: true,
          ...(variants ? { variants } : {}),
        });
      }
    }
  }

  if (rows.length === 0) {
    warnings.push('AI parser did not detect any menu items. Try the text parser or upload a clearer image.');
  }

  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
    rows.length === 0 ? 'LOW' :
    rows.length >= 10 && warnings.length <= 2 ? 'HIGH' :
    rows.length >= 3 && warnings.length <= 5 ? 'MEDIUM' : 'LOW';

  return { rows, warnings, confidence };
}

export async function parseMenuWithGroq(
  pdfBuffer: Buffer,
  restaurantType?: string,
): Promise<ParseResult> {
  if (!process.env.GROQ_API_KEY) {
    return {
      rows: [],
      warnings: ['GROQ_API_KEY is not set — AI parsing unavailable'],
      confidence: 'LOW',
    };
  }

  const warnings: string[] = [];
  logger.info('[groqMenuParser] Starting AI PDF parsing');

  // Step 1: Render PDF pages to JPEG images
  let images: Buffer[];
  try {
    images = await renderPdfToImages(pdfBuffer);
    logger.info({ pageCount: images.length }, '[groqMenuParser] PDF rendered to images');
  } catch (err: any) {
    logger.error({ err }, '[groqMenuParser] PDF rendering failed');
    return {
      rows: [],
      warnings: [`PDF rendering failed: ${err.message}`],
      confidence: 'LOW',
    };
  }

  if (images.length === 0) {
    return {
      rows: [],
      warnings: ['PDF has no pages to parse'],
      confidence: 'LOW',
    };
  }

  // Step 2: Send each page to Groq in parallel
  const pageResults = await Promise.all(
    images.map(async (img, i) => {
      try {
        const base64 = img.toString('base64');
        const result = await callGroqVision(base64, restaurantType);
        logger.info({ page: i + 1, categories: result.categories?.length || 0 }, '[groqMenuParser] Page parsed');
        return result;
      } catch (err: any) {
        warnings.push(`Page ${i + 1}: AI parsing failed — ${err.message}`);
        logger.warn({ page: i + 1, err: err.message }, '[groqMenuParser] Page failed');
        return { categories: [] } as GroqCategoryResponse;
      }
    }),
  );

  // Step 3: Merge results
  const result = normalizeGroqResponse(pageResults, warnings);
  logger.info(
    { totalRows: result.rows.length, confidence: result.confidence },
    '[groqMenuParser] AI parsing complete',
  );

  return result;
}
