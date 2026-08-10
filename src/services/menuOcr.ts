// ─────────────────────────────────────────────────────────────────────────────
// Menu OCR Service — Tesseract.js OCR for menu images and PDF page renders
// ─────────────────────────────────────────────────────────────────────────────
// Provides OCR text extraction for menu images and rendered PDF pages.
// Used alongside the Groq vision API to give the AI model both visual and
// textual signal, improving accuracy on scanned menus and poor-quality photos.
//
// Flow:
//   1. Image is preprocessed (grayscale + contrast stretch) via @napi-rs/canvas
//   2. Tesseract.js runs OCR on the preprocessed image
//   3. Returns raw text + word-level bounding boxes (for layout-aware parsing)
//
// Reuses the vendored Tesseract assets from src/assets/tesseract/ (same as
// payrollImport.ts). Lazy-loads tesseract.js so the server can start even if
// OCR assets are missing.
// ─────────────────────────────────────────────────────────────────────────────

import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import logger from '../lib/logger';

// Lazy-load tesseract.js so the server can start even if OCR assets are missing.
let tesseractModule: typeof import('tesseract.js') | null = null;
async function getTesseract() {
  if (tesseractModule) return tesseractModule;
  try {
    tesseractModule = await import('tesseract.js');
  } catch (err: any) {
    logger.warn({ err: err.message }, '[menuOcr] tesseract.js not available');
    throw new Error('OCR library not installed');
  }
  return tesseractModule;
}

function tesseractLangPath(): string {
  return require('path').resolve(__dirname, '../assets/tesseract');
}

export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
  confidence: number;
}

/**
 * Preprocess an image for better OCR accuracy:
 *   - Grayscale conversion
 *   - Contrast stretch (simple threshold)
 *   - Upscale small images (min 1000px wide)
 * Returns a PNG buffer.
 */
export async function preprocessImageForOcr(buffer: Buffer): Promise<Buffer> {
  try {
    const img = await loadImage(buffer);
    // Upscale if the image is small — Tesseract performs better on larger images
    const scale = img.width < 1000 ? 1000 / img.width : 1;
    const targetW = Math.round(img.width * scale);
    const targetH = Math.round(img.height * scale);

    const canvas: Canvas = createCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const imageData = ctx.getImageData(0, 0, targetW, targetH);
    const data = imageData.data;

    // Grayscale
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      data[i] = data[i + 1] = data[i + 2] = gray;
    }

    // Contrast stretch using min/max
    let min = 255, max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;
    for (let i = 0; i < data.length; i += 4) {
      const v = ((data[i] - min) / range) * 255;
      data[i] = data[i + 1] = data[i + 2] = v;
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas.toBuffer('image/png');
  } catch (err: any) {
    logger.warn({ err: err.message }, '[menuOcr] Image preprocessing failed, using original');
    return buffer;
  }
}

/**
 * Run Tesseract OCR on an image buffer (PNG/JPEG or any format @napi-rs/canvas can load).
 * Returns the full text, word-level bounding boxes, and average confidence.
 */
export async function ocrImage(buffer: Buffer): Promise<OcrResult> {
  let tesseract: typeof import('tesseract.js');
  try {
    tesseract = await getTesseract();
  } catch (err: any) {
    throw new Error('OCR library not available. Run npm install in the backend and vendor Tesseract assets.');
  }

  const preprocessed = await preprocessImageForOcr(buffer);

  let result: Awaited<ReturnType<typeof tesseract.recognize>>;
  try {
    result = await tesseract.recognize(preprocessed, 'eng', {
      langPath: tesseractLangPath(),
      logger: (m: any) => {
        if (m.status === 'recognizing text') {
          logger.debug({ progress: m.progress }, '[menuOcr] tesseract recognizing');
        }
      },
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, '[menuOcr] Tesseract recognition failed');
    throw new Error(`OCR failed: ${err.message}`);
  }

  const words: OcrWord[] = (result.data.words || []).map((w: any) => ({
    text: w.text,
    bbox: w.bbox,
    confidence: w.confidence,
  }));

  const text = result.data.text || '';
  // Compute average confidence from word-level confidences
  const confidence = words.length > 0
    ? words.reduce((sum, w) => sum + (w.confidence || 0), 0) / words.length
    : 0;

  logger.info(
    { wordCount: words.length, confidence: confidence.toFixed(1), textLength: text.length },
    '[menuOcr] OCR complete',
  );

  return { text, words, confidence };
}

/**
 * Run OCR on multiple image buffers in parallel and return combined text.
 * Used for multi-page PDF renders and multi-photo uploads.
 */
export async function ocrImages(buffers: Buffer[]): Promise<OcrResult[]> {
  return Promise.all(
    buffers.map(async (buf, i) => {
      try {
        return await ocrImage(buf);
      } catch (err: any) {
        logger.warn({ page: i + 1, err: err.message }, '[menuOcr] Page OCR failed');
        return { text: '', words: [], confidence: 0 };
      }
    }),
  );
}
