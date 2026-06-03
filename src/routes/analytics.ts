/**
 * Analytics routes
 *
 * GET /api/analytics/items-sold — Get aggregated item sales data by date range
 */

import { Router } from 'express';
import prisma from '../lib/prisma';

const router = Router();

/**
 * GET /api/analytics/items-sold
 * Query params:
 *   - restaurantId: string (required)
 *   - startDate: YYYY-MM-DD (optional, defaults to today)
 *   - endDate: YYYY-MM-DD (optional, defaults to today)
 *
 * Returns aggregated item sales: name, quantity sold, total revenue
 */
router.get('/items-sold', async (req, res) => {
  try {
    const { restaurantId, startDate, endDate, sectionName } = req.query;

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

    // Fetch all transactions in date range
    const whereClause: any = {
      restaurantId: String(restaurantId),
      paidAt: {
        gte: startIST,
        lte: endIST,
      },
    };

    // Add section filter for venue subcategories
    if (sectionName) {
      whereClause.order = {
        table: {
          section: {
            name: {
              contains: String(sectionName),
              mode: 'insensitive',
            },
          },
        },
      };
    }

    const transactions = await prisma.transaction.findMany({
      where: whereClause,
      select: {
        items: true, // JSON array of items
      },
    });

    // Fetch all liquor item names from the database (across all outlets) for historical matching
    const liquorMenuItems = await prisma.menuItem.findMany({
      where: {
        menuType: 'LIQUOR'
      },
      select: { name: true }
    });
    
    // Create an array of keywords (all lowercase) for matching variant names (e.g., "VAT 69 30ml")
    const liquorKeywords = liquorMenuItems.map(m => m.name.toLowerCase());

    // Aggregate items: { itemName: { quantity, revenue } }
    const itemMap = new Map<string, { quantity: number; revenue: number; type: string; orderCount: number }>();

    for (const txn of transactions) {
      const items = Array.isArray(txn.items) ? txn.items : [];

      for (const item of items) {
        const name = (item as any).n || (item as any).name || 'Unknown';
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

        if (itemMap.has(name)) {
          const existing = itemMap.get(name)!;
          existing.quantity += quantity;
          existing.revenue += revenue;
          existing.orderCount += 1;
        } else {
          itemMap.set(name, { quantity, revenue, type, orderCount: 1 });
        }
      }
    }

    // Convert map to array and sort by revenue (descending)
    const itemsData = Array.from(itemMap.entries())
      .map(([name, data]) => ({
        name,
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
    console.error('[Analytics] items-sold error:', err);
    res.status(500).json({ error: 'Failed to fetch item analytics' });
  }
});

export default router;
