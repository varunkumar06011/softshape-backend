// ─────────────────────────────────────────────────────────────────────────────
// Analytics Routes — Item sales analytics for reports
// ─────────────────────────────────────────────────────────────────────────────
// Provides aggregated item sales data by date range, used by the admin dashboard
// reports and analytics views.
//
// Endpoints:
//   GET /api/analytics/items-sold — aggregated item sales by date range
//
// Features:
//   - Date range filtering (defaults to today in IST)
//   - Section filtering (filter by section name → resolves to table IDs)
//   - Food/liquor type detection with historical fallback for misclassified items
//   - Restaurant context can exclude liquor items from analytics
//   - Cached for 30 seconds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analytics routes
 *
 * GET /api/analytics/items-sold — Get aggregated item sales data by date range
 */

import { Router } from 'express';
import logger from "../lib/logger";
import prisma from '../lib/prisma';
import { cacheMiddleware } from '../lib/cache';
import { authenticate } from '../middleware/auth';
const router = Router();

/**
 * GET /api/analytics/items-sold
 * Query params:
 *   - restaurantId: string (required, auto-injected from JWT)
 *   - startDate: YYYY-MM-DD (optional, defaults to today)
 *   - endDate: YYYY-MM-DD (optional, defaults to today)
 *   - sectionName: string (optional, filters by section → table IDs)
 *   - outletType: string (optional, 'restaurant' excludes liquor items)
 *
 * Returns: { items: [{ name, quantity, revenue, type, orderCount }], summary, dateRange }
 * Items are sorted by revenue (descending).
 */
router.get('/items-sold', authenticate, cacheMiddleware('analytics:items-sold', 30_000), async (req: any, res) => {
  try {
    const { startDate, endDate, sectionName, outletType } = req.query;

    const userRestaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!userRestaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const restaurantId = userRestaurantId;

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }

    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const now = new Date(Date.now() + IST_OFFSET_MS);

    // Default to today if no dates provided
    const defaultDate = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const start = (startDate as string) || defaultDate;
    const end = (endDate as string) || defaultDate;

    // Convert YYYY-MM-DD to IST day range → UTC timestamps for DB query
    const [startYear, startMonth, startDay] = start.split('-').map(Number);
    const [endYear, endMonth, endDay] = end.split('-').map(Number);

    const startIST = new Date(Date.UTC(startYear, startMonth - 1, startDay, 0, 0, 0, 0) - IST_OFFSET_MS);
    const endIST = new Date(Date.UTC(endYear, endMonth - 1, endDay, 23, 59, 59, 999) - IST_OFFSET_MS);

    // Resolve section filter to table IDs / numbers
    let sectionTableIds: string[] = [];
    let sectionTableNumbers: number[] = [];

    if (sectionName) {
      const sections = await prisma.section.findMany({
        where: {
          restaurantId: String(restaurantId),
          name: { equals: String(sectionName), mode: 'insensitive' }
        },
        select: { id: true }
      });

      if (sections.length > 0) {
        const tables = await prisma.table.findMany({
          where: {
            restaurantId: String(restaurantId),
            sectionId: { in: sections.map(s => s.id) }
          },
          select: { id: true, number: true }
        });
        sectionTableIds = tables.map(t => t.id);
        sectionTableNumbers = tables.map(t => t.number);
      }

      // If filtering by section but no tables found, return empty
      if (sectionTableIds.length === 0 && sectionTableNumbers.length === 0) {
        return res.json({
          items: [],
          summary: { totalItems: 0, totalQuantity: 0, totalRevenue: 0 },
          dateRange: { startDate: start, endDate: end },
        });
      }
    }


    // Fetch transactions in date range (optionally scoped to section tables)
    const transactions = await prisma.transaction.findMany({
      where: {
        restaurantId: String(restaurantId),
        paidAt: {
          gte: startIST,
          lte: endIST,
        },
        ...(sectionName ? {
          order: { tableId: { in: sectionTableIds } }
        } : {})
      },
      select: {
        items: true, // JSON array of items
      },
    });

    // Fetch all liquor item names from the database (across all outlets) for historical matching
    const liquorMenuItems = await prisma.menuItem.findMany({
      where: {
        menuType: 'LIQUOR',
        restaurantId: { in: [restaurantId] },
      },
      select: { name: true }
    });
    
    // Create an array of keywords (all lowercase) for matching variant names (e.g., "VAT 69 30ml")
    const liquorKeywords = liquorMenuItems.map(m => m.name.toLowerCase());

    // Aggregate items: { itemName: { quantity, revenue } }
    const itemMap = new Map<string, { name: string; quantity: number; revenue: number; type: string; orderCount: number }>();

    for (const txn of transactions) {
      const items = Array.isArray(txn.items) ? txn.items : [];

      for (const item of items) {
        const rawName = (item as any).n || (item as any).name || 'Unknown';
        const name = rawName.trim();
        const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
        const quantity = Number((item as any).q || (item as any).quantity || 0);
        const price = Number((item as any).p || (item as any).price || 0);
        const revenue = price * quantity;

        // Detect item type (food vs liquor)
        const rawType = (item as any).menuType || (item as any).type || '';
        let type = rawType.toString().toUpperCase() === 'LIQUOR' ? 'liquor' : 'food';

        // Historical fallback & correction for items that defaulted to 'FOOD' mistakenly
        if (type === 'food') {
          const lowerName = name.toLowerCase();
          if (liquorKeywords.some(keyword => lowerName.startsWith(keyword))) {
            type = 'liquor';
          }
        }

        // If this is a restaurant context, exclude liquor items from analytics
        const isRestaurantContext = req.query.outletType === 'restaurant';
        if (isRestaurantContext && type === 'liquor') continue;

        if (itemMap.has(key)) {
          const existing = itemMap.get(key)!;
          existing.quantity += quantity;
          existing.revenue += revenue;
          existing.orderCount += 1;
        } else {
          itemMap.set(key, { name, quantity, revenue, type, orderCount: 1 });
        }
      }
    }

    // Convert map to array and sort by revenue (descending)
    const itemsData = Array.from(itemMap.entries())
      .map(([_, data]) => ({
        name: data.name,
        quantity: data.quantity,
        revenue: Math.round(data.revenue * 100) / 100,
        type: data.type,
        orderCount: data.orderCount,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // Calculate totals
    const totalQuantity = itemsData.reduce((sum, item) => sum + item.quantity, 0);
    const totalRevenue = itemsData.reduce((sum, item) => sum + item.revenue, 0);

    res.json({
      items: itemsData,
      summary: {
        totalItems: itemsData.length,
        totalQuantity,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
      },
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Analytics] items-sold error');
    res.status(500).json({ error: 'Failed to fetch item analytics' });
  }
});

export default router;
