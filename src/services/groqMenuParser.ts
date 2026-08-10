// ─────────────────────────────────────────────────────────────────────────────
// Groq Menu Parser Service — AI-powered menu parsing via Groq API + OCR
// ─────────────────────────────────────────────────────────────────────────────
// Uses the Groq multimodal LLM API to parse menu images (photos, scans, or
// PDF page renders) and extract structured menu data: categories, item names,
// prices, veg/non-veg, variants, and descriptions.
//
// Flow:
//   1. PDF pages are rendered to JPEG images via pdfjs-dist + @napi-rs/canvas
//      (for raw image uploads, the image is preprocessed directly)
//   2. Tesseract OCR runs on each image in parallel with the Groq call
//   3. Both the image AND OCR text are sent to Groq (multimodal = better accuracy)
//   4. LLM response is parsed into ParsedRow[] with confidence scoring
//   5. Categories are inferred from the item name itself (not forced into a
//      predefined list — the AI picks the most natural category for each item)
//   6. Variants (e.g. 30ml/60ml/full, Half/Full) are detected
//
// Returns: ParseResult { rows, warnings, confidence }
// Confidence levels: HIGH (clear image, well-structured), MEDIUM (some ambiguity),
// LOW (poor image quality or unusual format).
// ─────────────────────────────────────────────────────────────────────────────

import { createCanvas, type Canvas } from '@napi-rs/canvas';
import logger from '../lib/logger';
import { FOOD_CATEGORIES, LIQUOR_CATEGORIES } from '../lib/predefinedCategories';
import { ocrImage, type OcrResult } from './menuOcr';

// Represents a single parsed menu item from the AI response
export interface ParsedRow {
  category: string;
  originalCategory?: string; // verbatim category as printed on the menu (if a header was visible)
  name: string;
  price: number;
  isVeg: boolean;
  menuType: string;
  description: string;
  categoryInferred?: boolean; // true only if AI guessed the category from the item name
  itemConfidence?: 'high' | 'medium' | 'low'; // per-item confidence from AI
  variants?: Array<{ name: string; price: number; isDefault: boolean }>;
}

export interface ParseResult {
  rows: ParsedRow[];
  warnings: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  source?: 'ai' | 'ocr' | 'text' | 'ai+ocr';
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const MAX_PAGES = 10;
const RENDER_SCALE = 2.0;
const JPEG_QUALITY = 0.85;
const MAX_COMPLETION_TOKENS = 8000;
const GROQ_TIMEOUT_MS = 90_000;
const MAX_RETRIES = 2;

function buildMenuPrompt(restaurantType?: string, ocrText?: string): string {
  const isBarType = restaurantType === 'BAR_LOUNGE' || restaurantType === 'BAR_WITH_DINING';
  const foodList = FOOD_CATEGORIES.join(', ');
  const liquorList = LIQUOR_CATEGORIES.join(', ');

  // Predefined categories are provided as REFERENCE only — the AI should use
  // natural category names and infer the best category from the item name itself.
  const referenceCategories = isBarType
    ? `Common FOOD categories (use as reference): ${foodList}\nCommon LIQUOR categories (use as reference): ${liquorList}`
    : `Common categories (use as reference): ${foodList}`;

  const ocrSection = ocrText && ocrText.trim().length > 0
    ? `\n\n--- OCR TEXT (extracted via Tesseract — use to cross-check the image, may contain errors) ---\n${ocrText.trim()}\n--- END OCR TEXT ---\n`
    : '';

  return `You are a restaurant menu parser. Extract ALL menu items visible on this menu page image.${ocrSection}

Return a JSON object with this exact structure:
{
  "categories": [
    {
      "name": "Category name as printed on the menu (or inferred from items)",
      "inferred": false,
      "items": [
        {
          "name": "Item name exactly as printed",
          "price": 0,
          "isVeg": true,
          "menuType": "FOOD",
          "description": "",
          "confidence": "high",
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
- ${referenceCategories}
- If a category header is visible on the menu, use it as the category "name" and set "inferred": false
- If NO category header is visible for an item, INFER the most appropriate category from the item name itself (e.g. "Paneer Tikka" → "Starters", "Dal Makhani" → "Main Course", "Kingfisher Beer" → "Beer", "Chocolate Cake" → "Desserts"). Set "inferred": true.
- Do NOT force items into the reference category list if a better natural category name exists. Use sensible, common restaurant category names.
- For food items with Half/Full pricing shown, create variants with names "Half" and "Full"
- For liquor items with size-based pricing (30ml, 90ml, 180ml, 750ml/Full Bottle), create variants with those exact names
- If a single price is shown, set price to that value and create one variant: { "name": "Regular", "price": X, "isDefault": true }
- Set isVeg: true for vegetarian items (paneer, dal, mushroom, vegetable, cheese, gobi, aloo, corn, kheema), false for non-veg (chicken, mutton, fish, prawn, egg, beef, pork, crab, biryani)
- Set menuType: "LIQUOR" for alcohol (beer, whisky, vodka, rum, gin, brandy, wine, cocktail, mocktail, shot, liquor, spirit, draught, draft), "FOOD" for everything else
- Extract descriptions if they are printed on the menu (short text under item names). If no description, use empty string "".
- Set per-item "confidence": "high" (clearly readable), "medium" (partially unclear), "low" (guessed or hard to read)
- Ignore page numbers, phone numbers, addresses, FSSAI numbers, GST numbers, social media handles, website URLs
- Ignore decorative text, restaurant names, logos, watermarks
- For items with "B/L" (boneless) suffix, keep it in the name
- If prices are shown in Indian Rupees (₹), extract the numeric value only
- If an item has multiple prices for different sizes/portions, create variants for each size
- Return empty categories array if no menu items are visible on this page
- Use the OCR text to verify item names and prices, but trust the image if there is a conflict
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
    inferred?: boolean;
    items: Array<{
      name: string;
      price: number;
      isVeg?: boolean;
      menuType?: string;
      description?: string;
      confidence?: string;
      variants?: Array<{ name: string; price: number; isDefault?: boolean }>;
    }>;
  }>;
}

async function callGroqVisionWithRetry(
  imageBase64: string,
  restaurantType?: string,
  ocrText?: string,
): Promise<GroqCategoryResponse> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callGroqVision(imageBase64, restaurantType, ocrText);
    } catch (err: any) {
      lastErr = err;
      // Retry on timeout and rate-limit/server errors
      const isRetryable = err.name === 'AbortError' ||
        err.message.includes('timed out') ||
        err.message.includes('429') ||
        err.message.includes('503') ||
        err.message.includes('502');
      if (!isRetryable || attempt === MAX_RETRIES) {
        throw err;
      }
      const delayMs = 2000 * Math.pow(2, attempt); // 2s, 4s
      logger.warn({ attempt: attempt + 1, delayMs, err: err.message }, '[groqMenuParser] Retrying after error');
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr || new Error('Groq API failed after retries');
}

async function callGroqVision(
  imageBase64: string,
  restaurantType?: string,
  ocrText?: string,
): Promise<GroqCategoryResponse> {
  const prompt = buildMenuPrompt(restaurantType, ocrText);

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
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    response_format: { type: 'json_object' },
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

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
      throw new Error(`Groq API request timed out after ${GROQ_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeGroqResponse(
  pageResults: GroqCategoryResponse[],
  warnings: string[],
  source: 'ai' | 'ai+ocr' = 'ai',
): ParseResult {
  const rows: ParsedRow[] = [];

  for (const page of pageResults) {
    for (const cat of page.categories || []) {
      const categoryName = String(cat.name || 'Uncategorized').trim();
      const categoryInferred = cat.inferred === true;

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

        const itemConfidence = item.confidence === 'high' || item.confidence === 'medium' || item.confidence === 'low'
          ? (item.confidence as 'high' | 'medium' | 'low')
          : undefined;

        rows.push({
          category: categoryName,
          originalCategory: categoryInferred ? undefined : categoryName,
          name: String(item.name).trim(),
          price,
          isVeg: item.isVeg ?? true,
          menuType: item.menuType || 'FOOD',
          description: String(item.description || '').trim(),
          categoryInferred,
          ...(itemConfidence ? { itemConfidence } : {}),
          ...(variants ? { variants } : {}),
        });
      }
    }
  }

  if (rows.length === 0) {
    warnings.push('AI parser did not detect any menu items. Try uploading a clearer image or use Excel/CSV format.');
  }

  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
    rows.length === 0 ? 'LOW' :
    rows.length >= 10 && warnings.length <= 2 ? 'HIGH' :
    rows.length >= 3 && warnings.length <= 5 ? 'MEDIUM' : 'LOW';

  return { rows, warnings, confidence, source };
}

/**
 * Parse a PDF buffer using AI vision + OCR.
 * Each page is rendered to an image, OCR'd, and sent to Groq with both
 * the image and OCR text.
 */
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
  logger.info('[groqMenuParser] Starting AI PDF parsing with OCR');

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

  // Step 2: For each page, run OCR + Groq vision in parallel
  const pageResults = await Promise.all(
    images.map(async (img, i) => {
      try {
        const base64 = img.toString('base64');

        // Run OCR in parallel with Groq — OCR text is injected into the prompt
        let ocrResult: OcrResult | null = null;
        try {
          ocrResult = await ocrImage(img);
        } catch (ocrErr: any) {
          logger.warn({ page: i + 1, err: ocrErr.message }, '[groqMenuParser] OCR failed for page, continuing with image only');
        }

        const ocrText = ocrResult?.text || undefined;
        const result = await callGroqVisionWithRetry(base64, restaurantType, ocrText);
        logger.info(
          { page: i + 1, categories: result.categories?.length || 0, hasOcr: !!ocrResult },
          '[groqMenuParser] Page parsed',
        );
        return result;
      } catch (err: any) {
        warnings.push(`Page ${i + 1}: AI parsing failed — ${err.message}`);
        logger.warn({ page: i + 1, err: err.message }, '[groqMenuParser] Page failed');
        return { categories: [] } as GroqCategoryResponse;
      }
    }),
  );

  // Step 3: Merge results
  const result = normalizeGroqResponse(pageResults, warnings, 'ai+ocr');
  logger.info(
    { totalRows: result.rows.length, confidence: result.confidence },
    '[groqMenuParser] AI parsing complete',
  );

  return result;
}

/**
 * Parse a single image (photo/scan) using AI vision + OCR.
 * Used for JPG/PNG/WebP uploads.
 */
export async function parseImageWithGroq(
  imageBuffer: Buffer,
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
  logger.info('[groqMenuParser] Starting AI image parsing with OCR');

  // Convert image to JPEG for consistent processing
  let jpegBuffer: Buffer;
  try {
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(imageBuffer);
    const canvas: Canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    jpegBuffer = canvas.toBuffer('image/jpeg', JPEG_QUALITY);
  } catch (err: any) {
    logger.error({ err }, '[groqMenuParser] Image preprocessing failed');
    return {
      rows: [],
      warnings: [`Image preprocessing failed: ${err.message}`],
      confidence: 'LOW',
    };
  }

  // Run OCR + Groq in parallel
  let ocrResult: OcrResult | null = null;
  try {
    ocrResult = await ocrImage(jpegBuffer);
  } catch (ocrErr: any) {
    logger.warn({ err: ocrErr.message }, '[groqMenuParser] OCR failed, continuing with image only');
  }

  const ocrText = ocrResult?.text || undefined;
  const base64 = jpegBuffer.toString('base64');

  try {
    const result = await callGroqVisionWithRetry(base64, restaurantType, ocrText);
    logger.info(
      { categories: result.categories?.length || 0, hasOcr: !!ocrResult },
      '[groqMenuParser] Image parsed',
    );
    return normalizeGroqResponse([result], warnings, 'ai+ocr');
  } catch (err: any) {
    warnings.push(`AI parsing failed — ${err.message}`);
    logger.warn({ err: err.message }, '[groqMenuParser] Image parsing failed');
    return { rows: [], warnings, confidence: 'LOW', source: 'ai+ocr' };
  }
}

/**
 * Parse multiple images (multi-photo menu) using AI vision + OCR.
 * Each image is processed in parallel and results are merged.
 */
export async function parseImagesWithGroq(
  imageBuffers: Buffer[],
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
  logger.info({ imageCount: imageBuffers.length }, '[groqMenuParser] Starting multi-image AI parsing with OCR');

  const { loadImage } = await import('@napi-rs/canvas');

  const pageResults = await Promise.all(
    imageBuffers.map(async (buf, i) => {
      try {
        // Convert to JPEG
        const img = await loadImage(buf);
        const canvas: Canvas = createCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const jpegBuffer = canvas.toBuffer('image/jpeg', JPEG_QUALITY);

        // OCR + Groq in parallel
        let ocrResult: OcrResult | null = null;
        try {
          ocrResult = await ocrImage(jpegBuffer);
        } catch (ocrErr: any) {
          logger.warn({ image: i + 1, err: ocrErr.message }, '[groqMenuParser] OCR failed for image, continuing');
        }

        const ocrText = ocrResult?.text || undefined;
        const base64 = jpegBuffer.toString('base64');
        const result = await callGroqVisionWithRetry(base64, restaurantType, ocrText);
        logger.info(
          { image: i + 1, categories: result.categories?.length || 0, hasOcr: !!ocrResult },
          '[groqMenuParser] Image parsed',
        );
        return result;
      } catch (err: any) {
        warnings.push(`Image ${i + 1}: AI parsing failed — ${err.message}`);
        logger.warn({ image: i + 1, err: err.message }, '[groqMenuParser] Image failed');
        return { categories: [] } as GroqCategoryResponse;
      }
    }),
  );

  const result = normalizeGroqResponse(pageResults, warnings, 'ai+ocr');
  logger.info(
    { totalRows: result.rows.length, confidence: result.confidence },
    '[groqMenuParser] Multi-image parsing complete',
  );

  return result;
}
