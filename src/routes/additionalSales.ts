// ─────────────────────────────────────────────────────────────────────────────
// Additional / Offline Sales Routes
// ─────────────────────────────────────────────────────────────────────────────
// Manually entered reference figures for outlets without a PC/system.
// NOT included in Total Sales, AOV, POS revenue, billing, or inventory.
// Separate informational ledger only.
//
// Endpoints:
//   GET    /api/additional-sales?date=YYYY-MM-DD&category=Food
//   POST   /api/additional-sales
//   PATCH  /api/additional-sales/:id
//   DELETE /api/additional-sales/:id
//
// Scoping: restaurantId: { in: tenantIds } via resolveOutletFilter (same idiom
// as every other route). Mutations require OWNER/ADMIN/MANAGER role.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { basePrisma } from '../lib/prisma';
import logger from '../lib/logger';
import { requireRole } from '../middleware/auth';
import { resolveOutletFilter } from './reports';
import { getKolkataDateString } from '../utils/date';

const router = Router();

const VALID_CATEGORIES = ['Food', 'Liquor', 'Beverages'] as const;
type Category = typeof VALID_CATEGORIES[number];

function isValidCategory(c: string): c is Category {
  return (VALID_CATEGORIES as readonly string[]).includes(c);
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ── GET /api/additional-sales ────────────────────────────────────────────
// Supports:
//   ?date=YYYY-MM-DD              — single date (legacy)
//   ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD — date range
//   ?category=Food|Liquor|Beverages|All   — category filter (default: All)
//   ?search=text                  — search by outlet name or notes
router.get('/', async (req: any, res) => {
  try {
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const date = req.query.date as string | undefined;
    const fromDate = req.query.fromDate as string | undefined;
    const toDate = req.query.toDate as string | undefined;
    const category = (req.query.category as string | undefined) || 'All';
    const search = (req.query.search as string | undefined)?.trim() || '';

    // Validate date params
    if (date && !DATE_REGEX.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    if (fromDate && !DATE_REGEX.test(fromDate)) {
      return res.status(400).json({ error: 'fromDate must be YYYY-MM-DD' });
    }
    if (toDate && !DATE_REGEX.test(toDate)) {
      return res.status(400).json({ error: 'toDate must be YYYY-MM-DD' });
    }
    if (category !== 'All' && !isValidCategory(category)) {
      return res.status(400).json({ error: `category must be one of: All, ${VALID_CATEGORIES.join(', ')}` });
    }

    // Build date filter: single date OR date range
    let dateFilter: any;
    if (fromDate && toDate) {
      dateFilter = { gte: fromDate, lte: toDate };
    } else if (fromDate) {
      dateFilter = { gte: fromDate };
    } else if (toDate) {
      dateFilter = { lte: toDate };
    } else {
      dateFilter = date || getKolkataDateString();
    }

    const where: any = {
      restaurantId: { in: tenantIds },
      saleDate: dateFilter,
    };
    if (category !== 'All') where.category = category;
    if (search) {
      where.OR = [
        { outletName: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
      ];
    }

    const items = await basePrisma.additionalOutletSale.findMany({
      where,
      orderBy: [{ saleDate: 'desc' }, { category: 'asc' }, { outletName: 'asc' }],
    });

    // Compute totals per category across the same date range (ignoring search/category filter
    // so the category tabs always show the correct totals for the date range)
    const totalsWhere: any = {
      restaurantId: { in: tenantIds },
      saleDate: dateFilter,
    };
    const allItems = await basePrisma.additionalOutletSale.findMany({
      where: totalsWhere,
      select: { category: true, revenue: true },
    });

    const totalByCategory: Record<string, number> = { Food: 0, Liquor: 0, Beverages: 0 };
    let grandTotal = 0;
    for (const it of allItems) {
      const rev = Number(it.revenue);
      if (totalByCategory[it.category] !== undefined) {
        totalByCategory[it.category] += rev;
      }
      grandTotal += rev;
    }

    res.json({
      date: date || null,
      fromDate: fromDate || null,
      toDate: toDate || null,
      category,
      search: search || null,
      items: items.map((it) => ({
        id: it.id,
        saleDate: it.saleDate,
        category: it.category,
        outletName: it.outletName,
        revenue: Number(it.revenue),
        notes: it.notes,
        createdBy: it.createdBy,
        createdAt: it.createdAt,
        updatedBy: it.updatedBy,
        updatedAt: it.updatedAt,
      })),
      totalByCategory,
      grandTotal: Math.round(grandTotal * 100) / 100,
      count: items.length,
    });
  } catch (error: any) {
    logger.error({ err: error }, '[AdditionalSales] GET failed:');
    res.status(500).json({ error: error.message || 'Failed to fetch additional sales' });
  }
});

// ── POST /api/additional-sales ───────────────────────────────────────────
router.post('/', requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req: any, res) => {
  try {
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { saleDate, category, outletName, revenue, notes } = req.body as {
      saleDate?: string;
      category?: string;
      outletName?: string;
      revenue?: number;
      notes?: string;
    };

    // Validation
    if (!saleDate || !DATE_REGEX.test(saleDate)) {
      return res.status(400).json({ error: 'saleDate is required (YYYY-MM-DD)' });
    }
    if (!category || !isValidCategory(category)) {
      return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }
    const trimmedName = String(outletName || '').trim();
    if (!trimmedName) {
      return res.status(400).json({ error: 'outletName is required' });
    }
    const revNum = Number(revenue);
    if (Number.isNaN(revNum) || revNum < 0) {
      return res.status(400).json({ error: 'revenue must be a non-negative number' });
    }

    const restaurantId = req.user.activeRestaurantId ?? req.user.restaurantId;
    if (!restaurantId || !tenantIds.includes(restaurantId)) {
      return res.status(403).json({ error: 'Active outlet not authorized' });
    }

    const created = await basePrisma.additionalOutletSale.create({
      data: {
        restaurantId,
        saleDate,
        category,
        outletName: trimmedName,
        revenue: revNum,
        notes: notes?.trim() || null,
        createdBy: req.user.name || req.user.email || 'Admin',
      },
    });

    res.status(201).json({
      id: created.id,
      saleDate: created.saleDate,
      category: created.category,
      outletName: created.outletName,
      revenue: Number(created.revenue),
      notes: created.notes,
      createdBy: created.createdBy,
      createdAt: created.createdAt,
    });
  } catch (error: any) {
    logger.error({ err: error }, '[AdditionalSales] POST failed:');
    res.status(500).json({ error: error.message || 'Failed to create additional sale' });
  }
});

// ── PATCH /api/additional-sales/:id ──────────────────────────────────────
router.patch('/:id', requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req: any, res) => {
  try {
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;
    const { saleDate, category, outletName, revenue, notes } = req.body as {
      saleDate?: string;
      category?: string;
      outletName?: string;
      revenue?: number;
      notes?: string;
    };

    // Build update data — only fields that are provided
    const updateData: any = {};
    if (saleDate !== undefined) {
      if (!DATE_REGEX.test(saleDate)) {
        return res.status(400).json({ error: 'saleDate must be YYYY-MM-DD' });
      }
      updateData.saleDate = saleDate;
    }
    if (category !== undefined) {
      if (!isValidCategory(category)) {
        return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }
      updateData.category = category;
    }
    if (outletName !== undefined) {
      const trimmedName = String(outletName).trim();
      if (!trimmedName) {
        return res.status(400).json({ error: 'outletName cannot be empty' });
      }
      updateData.outletName = trimmedName;
    }
    if (revenue !== undefined) {
      const revNum = Number(revenue);
      if (Number.isNaN(revNum) || revNum < 0) {
        return res.status(400).json({ error: 'revenue must be a non-negative number' });
      }
      updateData.revenue = revNum;
    }
    if (notes !== undefined) {
      updateData.notes = String(notes).trim() || null;
    }
    updateData.updatedBy = req.user.name || req.user.email || 'Admin';

    // Enforce tenant scope on the WHERE clause
    const updated = await basePrisma.additionalOutletSale.updateMany({
      where: { id, restaurantId: { in: tenantIds } },
      data: updateData,
    });

    if (updated.count === 0) {
      return res.status(404).json({ error: 'Additional sale not found or not authorized' });
    }

    // Re-fetch the updated record
    const record = await basePrisma.additionalOutletSale.findFirst({
      where: { id, restaurantId: { in: tenantIds } },
    });

    res.json({
      id: record!.id,
      saleDate: record!.saleDate,
      category: record!.category,
      outletName: record!.outletName,
      revenue: Number(record!.revenue),
      notes: record!.notes,
      updatedBy: record!.updatedBy,
      updatedAt: record!.updatedAt,
    });
  } catch (error: any) {
    logger.error({ err: error }, '[AdditionalSales] PATCH failed:');
    res.status(500).json({ error: error.message || 'Failed to update additional sale' });
  }
});

// ── DELETE /api/additional-sales/:id ─────────────────────────────────────
router.delete('/:id', requireRole('OWNER', 'ADMIN', 'MANAGER'), async (req: any, res) => {
  try {
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;

    const deleted = await basePrisma.additionalOutletSale.deleteMany({
      where: { id, restaurantId: { in: tenantIds } },
    });

    if (deleted.count === 0) {
      return res.status(404).json({ error: 'Additional sale not found or not authorized' });
    }

    res.json({ id, deleted: true });
  } catch (error: any) {
    logger.error({ err: error }, '[AdditionalSales] DELETE failed:');
    res.status(500).json({ error: error.message || 'Failed to delete additional sale' });
  }
});

export default router;
