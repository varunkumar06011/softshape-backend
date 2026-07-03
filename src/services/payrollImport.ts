// ─────────────────────────────────────────────────────────────────────────────
// Payroll Import Service — Excel/CSV and photo OCR staff import
// ─────────────────────────────────────────────────────────────────────────────
// Parses payroll sheets (Excel or photo) into staff rows, then resolves
// identity against existing employees for the active restaurant.
//
// Output shape:
//   {
//     rows: [{ staffCode?, name, role, baseSalary, source: 'excel'|'photo' }],
//     warnings: string[],
//     confidence: 'HIGH' | 'MEDIUM' | 'LOW'
//   }
// ─────────────────────────────────────────────────────────────────────────────

import xlsx from 'xlsx';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

// Lazy-load tesseract.js so the server can start even if OCR assets are missing.
let tesseractModule: typeof import('tesseract.js') | null = null;
async function getTesseract() {
  if (tesseractModule) return tesseractModule;
  try {
    tesseractModule = await import('tesseract.js');
  } catch (err: any) {
    logger.warn({ err: err.message }, '[payrollImport] tesseract.js not available');
    throw new Error('OCR library not installed');
  }
  return tesseractModule;
}

function tesseractLangPath(): string {
  return require('path').resolve(__dirname, '../assets/tesseract');
}

export interface ParsedStaffRow {
  staffCode?: string;
  name: string;
  role: string;
  baseSalary: number;
  source: 'excel' | 'photo';
  ocrConfidence?: number;
}

export interface ParseStaffResult {
  rows: ParsedStaffRow[];
  warnings: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface ProposedStaffRow extends ParsedStaffRow {
  action: 'create' | 'update' | 'ambiguous' | 'needsReview';
  matchId?: string;
  oldBaseSalary?: number;
  oldRole?: string;
  newBaseSalary: number;
  newRole: string;
}

export interface ImportCommitResult {
  created: number;
  updated: number;
  errors: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Excel / CSV parsing
// ─────────────────────────────────────────────────────────────────────────────

export function parseExcelPayroll(buffer: Buffer): ParseStaffResult {
  const warnings: string[] = [];
  const workbook = xlsx.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false });
  const rows: ParsedStaffRow[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const json = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' }) as any[][];

    for (const rawRow of json) {
      const row = rawRow.map((c) => String(c || '').trim()).filter(Boolean);
      if (row.length < 2) continue;

      const parsed = parseRowCells(row);
      if (parsed) rows.push({ ...parsed, source: 'excel' });
    }
  }

  const confidence = computeConfidence(rows, warnings);
  return { rows, warnings, confidence };
}

function parseRowCells(cells: string[]): Omit<ParsedStaffRow, 'source'> | null {
  // Try to find a row that looks like: [S.NO?, NAME, DESIGNATION?, SALARY]
  // Skip headers and totals.
  const text = cells.join(' ').toLowerCase();
  if (/total|s\.no|name|designation|salary|family|staff/.test(text) && cells.length <= 4) {
    // Likely a header/total row, but we still check below for salary.
  }
  if (text.includes('total') && text.includes('amount')) return null;
  if (text.includes('totals') && cells.length <= 4) return null;

  let staffCode: string | undefined;
  let name = '';
  let role = '';
  let salary: number | null = null;

  // Salary is usually the last numeric cell.
  for (let i = cells.length - 1; i >= 0; i--) {
    const s = parseSalary(cells[i]);
    if (s !== null && s > 0) {
      salary = s;
      break;
    }
  }
  if (salary === null) return null;

  // Name is the first remaining non-empty text cell that isn't a number or S.NO.
  for (const cell of cells) {
    const norm = cell.toLowerCase().replace(/\s+/g, '');
    if (isNumericCell(cell)) continue;
    if (/^s\.?no\.?$|^no\.?$|^\d+$/.test(norm)) {
      if (!staffCode && /^\d+$/.test(cell)) staffCode = cell;
      continue;
    }
    if (/total/.test(norm)) continue;
    if (!name) {
      name = cell;
      continue;
    }
    if (!role) {
      role = cell;
    }
  }

  if (!name) return null;
  return { staffCode, name, role: role || 'Staff', baseSalary: salary };
}

// ─────────────────────────────────────────────────────────────────────────────
// Photo OCR parsing
// ─────────────────────────────────────────────────────────────────────────────

export async function parsePhotoPayroll(buffer: Buffer): Promise<ParseStaffResult> {
  const warnings: string[] = [];

  let tesseract: typeof import('tesseract.js');
  try {
    tesseract = await getTesseract();
  } catch (err: any) {
    return {
      rows: [],
      warnings: ['OCR library not available. Run npm install in the backend and vendor Tesseract assets.'],
      confidence: 'LOW',
    };
  }

  const preprocessed = await preprocessImage(buffer);

  let result: Awaited<ReturnType<typeof tesseract.recognize>>;
  try {
    result = await tesseract.recognize(preprocessed, 'eng', {
      langPath: tesseractLangPath(),
      logger: (m: any) => logger.debug(m, '[payrollImport] tesseract'),
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, '[payrollImport] Tesseract recognition failed');
    return {
      rows: [],
      warnings: [`OCR failed: ${err.message}`],
      confidence: 'LOW',
    };
  }

  const words = result.data.words || [];
  if (words.length === 0) {
    return { rows: [], warnings: ['No text detected in the image'], confidence: 'LOW' };
  }

  const blocks = clusterWordsIntoBlocks(words);
  const rows: ParsedStaffRow[] = [];

  for (const block of blocks) {
    const blockRows = extractRowsFromBlock(block);
    rows.push(...blockRows);
  }

  const confidence = computeConfidence(rows, warnings);
  return { rows, warnings, confidence };
}

async function preprocessImage(buffer: Buffer): Promise<Buffer> {
  try {
    const img = await loadImage(buffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const data = imageData.data;

    // Grayscale + contrast stretch
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      data[i] = data[i + 1] = data[i + 2] = gray;
    }

    // Simple threshold
    const threshold = 128;
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i] > threshold ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas.toBuffer('image/png');
  } catch (err: any) {
    logger.warn({ err: err.message }, '[payrollImport] Image preprocessing failed, using original');
    return buffer;
  }
}

interface OcrWord {
  text: string;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  confidence: number;
}

function clusterWordsIntoBlocks(words: OcrWord[]): OcrWord[][] {
  if (words.length === 0) return [];
  // Sort by x0, then cluster words into vertical blocks using a gap threshold.
  const sorted = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const gapThreshold = medianWordWidth(sorted) * 3;
  const blocks: OcrWord[][] = [];
  let current: OcrWord[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = curr.bbox.x0 - prev.bbox.x1;
    if (gap > gapThreshold) {
      blocks.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  if (current.length) blocks.push(current);

  return blocks.filter((b) => b.length > 1);
}

function medianWordWidth(words: OcrWord[]): number {
  const widths = words.map((w) => w.bbox.x1 - w.bbox.x0).sort((a, b) => a - b);
  const mid = Math.floor(widths.length / 2);
  return widths.length ? widths[mid] : 30;
}

function extractRowsFromBlock(words: OcrWord[]): ParsedStaffRow[] {
  // Sort words in block by y-coordinate, then cluster into rows.
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const lineThreshold = 15; // px
  const lines: OcrWord[][] = [];
  let current: OcrWord[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (Math.abs(curr.bbox.y0 - prev.bbox.y0) > lineThreshold) {
      lines.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  if (current.length) lines.push(current);

  const rows: ParsedStaffRow[] = [];
  for (const line of lines) {
    const cells = line.sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text);
    const parsed = parseRowCells(cells);
    if (parsed) {
      const avgConfidence = line.reduce((sum, w) => sum + w.confidence, 0) / line.length;
      rows.push({
        ...parsed,
        source: 'photo',
        ocrConfidence: avgConfidence,
      });
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function isNumericCell(v: string): boolean {
  return /^[\d\s,\.₹$]+$/.test(v) && /\d/.test(v);
}

export function parseSalary(v: string): number | null {
  const raw = String(v || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[\s₹$]/g, '');

  // Indian grouping: 2,18,500 or 12,34,567
  if (/^\d{1,2}(,\d{2})*(,\d{3})$/.test(cleaned)) {
    const n = parseFloat(cleaned.replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  // Western grouping: 218,500 or 1,000,000
  if (/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(cleaned)) {
    const n = parseFloat(cleaned.replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  // Plain number
  const n = parseFloat(cleaned.replace(/,/g, ''));
  if (!isNaN(n) && n >= 0) return n;

  return null;
}

function computeConfidence(rows: ParsedStaffRow[], warnings: string[]): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (rows.length === 0) return 'LOW';
  const lowConf = rows.filter((r) => (r.ocrConfidence ?? 100) < 80).length;
  if (rows.length >= 10 && lowConf === 0 && warnings.length <= 2) return 'HIGH';
  if (rows.length >= 3 && lowConf <= 2 && warnings.length <= 5) return 'MEDIUM';
  return 'LOW';
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity resolution and commit
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveImportMatches(
  rows: ParsedStaffRow[],
  restaurantId: string
): Promise<{ proposed: ProposedStaffRow[]; warnings: string[] }> {
  const warnings: string[] = [];

  // Load existing active employees for this restaurant.
  const existing = await prisma.employee.findMany({
    where: { restaurantId, isActive: true },
    select: { id: true, staffCode: true, name: true, role: true, baseSalary: true },
  });

  // Detect duplicate keys within the imported rows.
  const staffCodeCounts = new Map<string, number>();
  const nameRoleCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.staffCode) {
      const key = row.staffCode.toLowerCase().trim();
      staffCodeCounts.set(key, (staffCodeCounts.get(key) || 0) + 1);
    }
    const nrKey = `${row.name.toLowerCase().trim()}|${row.role.toLowerCase().trim()}`;
    nameRoleCounts.set(nrKey, (nameRoleCounts.get(nrKey) || 0) + 1);
  }

  const proposed: ProposedStaffRow[] = [];
  const seenExistingMatches = new Map<string, string[]>();

  for (const row of rows) {
    const p: ProposedStaffRow = {
      ...row,
      action: 'create',
      newBaseSalary: row.baseSalary,
      newRole: row.role,
    };

    // Low-confidence OCR forces review.
    if (row.source === 'photo' && (row.ocrConfidence ?? 0) < 80) {
      p.action = 'needsReview';
      proposed.push(p);
      continue;
    }

    // Find matches by staffCode first.
    let matches: Array<{ id: string; staffCode: string | null; name: string; role: string | null; baseSalary: Prisma.Decimal }> = [];
    if (row.staffCode) {
      const code = row.staffCode.toLowerCase().trim();
      matches = existing.filter((e) => e.staffCode?.toLowerCase().trim() === code);
    }

    // Fallback to name+role.
    if (matches.length === 0) {
      const nrKey = `${row.name.toLowerCase().trim()}|${row.role.toLowerCase().trim()}`;
      matches = existing.filter(
        (e) =>
          e.name.toLowerCase().trim() === row.name.toLowerCase().trim() &&
          (e.role || '').toLowerCase().trim() === row.role.toLowerCase().trim()
      );

      // Imported duplicate key triggers ambiguity.
      if (nameRoleCounts.get(nrKey)! > 1) {
        p.action = 'ambiguous';
        proposed.push(p);
        continue;
      }
    }

    if (matches.length === 1) {
      const m = matches[0];
      p.action = 'update';
      p.matchId = m.id;
      p.oldBaseSalary = Number(m.baseSalary);
      p.oldRole = m.role || '';

      // Track how many imported rows point to the same employee.
      const arr = seenExistingMatches.get(m.id) || [];
      arr.push(row.name);
      seenExistingMatches.set(m.id, arr);
    } else if (matches.length > 1) {
      p.action = 'ambiguous';
    }

    proposed.push(p);
  }

  // Any employee matched by more than one imported row is ambiguous.
  for (const [empId, names] of seenExistingMatches.entries()) {
    if (names.length > 1) {
      for (const p of proposed) {
        if (p.matchId === empId) p.action = 'ambiguous';
      }
      warnings.push(`Multiple imported rows matched the same employee (${names.join(', ')}).`);
    }
  }

  return { proposed, warnings };
}

export async function commitImport(
  rows: ProposedStaffRow[],
  restaurantId: string,
  userId: string
): Promise<ImportCommitResult> {
  const result: ImportCommitResult = { created: 0, updated: 0, errors: [] };

  for (const row of rows) {
    if (row.action === 'ambiguous' || row.action === 'needsReview') {
      result.errors.push(`Skipped ${row.name}: requires review`);
      continue;
    }

    try {
      const employee = await prisma.$transaction(async (tx) => {
        let emp = row.matchId
          ? await tx.employee.findFirst({
              where: { id: row.matchId, restaurantId, isActive: true },
            })
          : null;

        const data = {
          name: row.name,
          role: row.role || null,
          baseSalary: new Prisma.Decimal(row.baseSalary),
          ...(row.staffCode ? { staffCode: row.staffCode } : {}),
        };

        if (emp) {
          emp = await tx.employee.update({
            where: { id: emp.id },
            data,
          });
        } else {
          emp = await tx.employee.create({
            data: { ...data, restaurantId },
          });
        }

        // Seed current-month payroll record
        const now = new Date();
        const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        await tx.payrollRecord.upsert({
          where: { employeeId_monthYear: { employeeId: emp.id, monthYear } },
          update: { baseSalary: new Prisma.Decimal(row.baseSalary) },
          create: {
            restaurantId,
            employeeId: emp.id,
            monthYear,
            baseSalary: new Prisma.Decimal(row.baseSalary),
            presentDays: 0,
            absentDays: 0,
            otDays: 0,
            advanceAmount: new Prisma.Decimal(0),
            manualAdvanceAmount: new Prisma.Decimal(0),
            otAmount: new Prisma.Decimal(0),
            netPayable: new Prisma.Decimal(0),
            paidAmount: new Prisma.Decimal(0),
            periodStart: `${monthYear}-01`,
            periodEnd: `${monthYear}-${String(daysInMonth).padStart(2, '0')}`,
            status: 'PENDING',
          },
        });

        await tx.auditLog.create({
          data: {
            userId,
            restaurantId,
            action: emp ? 'PAYROLL_IMPORT_EMPLOYEE_UPDATED' : 'PAYROLL_IMPORT_EMPLOYEE_CREATED',
            entityType: 'Employee',
            entityId: emp.id,
            metadata: {
              name: row.name,
              role: row.role,
              oldBaseSalary: row.oldBaseSalary,
              newBaseSalary: row.baseSalary,
              oldRole: row.oldRole,
              newRole: row.role,
              staffCode: row.staffCode,
            },
          },
        });

        return emp;
      });

      if (row.action === 'update') result.updated++;
      else result.created++;
    } catch (err: any) {
      logger.error({ err, row }, '[payrollImport] Commit row failed');
      result.errors.push(`Failed to import ${row.name}: ${err.message}`);
    }
  }

  return result;
}

