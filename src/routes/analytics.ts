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
import prisma, { withOrgScope } from '../lib/prisma';
import { cacheMiddleware } from '../lib/cache';
import { authenticate, optionalAuth } from '../middleware/auth';
import { resolveOutletFilter } from './reports';
import { completedTxnWhere } from '../lib/transactionHelpers';
const router = Router();

// Bar-like venue types — PDR, Conference, Room Service, Banquet are bar outlets too
const BAR_LIKE_VENUE_TYPES = ['BAR', 'PDR', 'CONFERENCE', 'BANQUET', 'ROOM_SERVICE'];

// Beverage keywords used to classify soft drinks / cool drinks / mocktails in analytics.
const BEVERAGE_KEYWORDS = [
  'water', 'sprite', 'thums up', 'thumsup', 'tin thums', 'soda', 'cola', 'coke', 'pepsi',
  'limca', 'fanta', 'mirinda', '7up', 'pulpy orange', 'fresh lime', 'mojitho', 'mojito',
  'moctail', 'mocktail', 'fruit punch', 'lassi', 'butter milk', 'buttermilk', 'milk shake',
  'milkshake', 'monster', 'charged', 'red bull', 'coolberg', 'juice',
];

const BEVERAGE_ALIASES: Record<string, string> = {
  'thumsup': 'thums up',
  'thums': 'thums up',
  'tin thums': 'thums up',
  'butter milk': 'buttermilk',
  'milk shake': 'milkshake',
  'moctail': 'mocktail',
  'mojitho': 'mojito',
};

function normalizeBeverageName(name: string): string {
  let normalized = String(name || '').toLowerCase();
  normalized = normalized
    .replace(/\b(bottle|can|tin|glass|cup|ml|ltr|liter|litre)\b/g, ' ')
    .replace(/\s+\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return BEVERAGE_ALIASES[normalized] || normalized;
}

function getAnalyticsType(item: any): 'food' | 'liquor' | 'beverages' {
  const rawType = String(item?.menuType || item?.type || '').toUpperCase();
  if (rawType === 'LIQUOR') return 'liquor';
  const normalizedName = normalizeBeverageName(String(item?.n || item?.name || ''));
  if (BEVERAGE_KEYWORDS.some((k) => normalizedName.includes(k))) return 'beverages';
  return 'food';
}

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
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getTodayISTRange() {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  const defaultDate = now.toISOString().slice(0, 10);
  return { defaultDate, now };
}

function parseISTRange(startDate?: string, endDate?: string) {
  const { defaultDate } = getTodayISTRange();
  const start = startDate || defaultDate;
  const end = endDate || defaultDate;
  const [startYear, startMonth, startDay] = start.split('-').map(Number);
  const [endYear, endMonth, endDay] = end.split('-').map(Number);
  const startIST = new Date(Date.UTC(startYear, startMonth - 1, startDay, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endIST = new Date(Date.UTC(endYear, endMonth - 1, endDay, 23, 59, 59, 999) - IST_OFFSET_MS);
  return { start, end, startIST, endIST };
}

router.get('/items-sold', authenticate, async (req: any, res) => {
  try {
    const { startDate, endDate, sectionName, outletType } = req.query;

    const userRestaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!userRestaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const restaurantId = String(req.query.restaurantId || userRestaurantId);

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }

    const { start, end, startIST, endIST } = parseISTRange(startDate as string, endDate as string);

    // Resolve section filter to table IDs / numbers
    let sectionTableIds: string[] = [];
    let sectionTableNumbers: number[] = [];
    let sectionIds: string[] = [];

    if (sectionName) {
      const sections = await prisma.section.findMany({
        where: {
          restaurantId: String(restaurantId),
          name: { equals: String(sectionName), mode: 'insensitive' }
        },
        select: { id: true }
      });

      sectionIds = sections.map(s => s.id);

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
    } else if (outletType) {
      // Filter by venue type (BAR vs non-BAR) when no specific section is given
      // Bar-like venue types (PDR, Conference, Room Service, Banquet) are treated as bar outlets
      const isBarOutlet = String(outletType).toUpperCase() === 'BAR';
      const venueSections = await prisma.section.findMany({
        where: {
          restaurantId: String(restaurantId),
          venue: isBarOutlet
            ? { venueType: { in: BAR_LIKE_VENUE_TYPES } }
            : { venueType: { notIn: BAR_LIKE_VENUE_TYPES } }
        },
        select: { id: true }
      });
      sectionIds = venueSections.map(s => s.id);

      if (venueSections.length > 0) {
        const tables = await prisma.table.findMany({
          where: {
            restaurantId: String(restaurantId),
            sectionId: { in: venueSections.map(s => s.id) }
          },
          select: { id: true }
        });
        sectionTableIds = tables.map(t => t.id);
      }
    }


    // Fetch transactions in date range (optionally scoped to section tables)
    const transactions = await prisma.transaction.findMany({
      where: {
        ...completedTxnWhere(String(restaurantId), {
          paidAt: { gte: startIST, lte: endIST },
        }),
        ...((sectionName || outletType) && sectionIds.length > 0 ? {
          OR: [
            { sectionId: { in: sectionIds } },
            { order: { tableId: { in: sectionTableIds } } },
          ]
        } : {})
      },
      select: {
        items: true, // JSON array of items
        discountPercent: true,
      },
    });

    // Fetch all liquor item names from the database (across all outlets) for historical matching
    const liquorMenuItems = await withOrgScope(undefined, [restaurantId]).menuItem.findMany({
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
      const txnDiscountPercent = Number(txn.discountPercent ?? 0);
      const discountFactor = txnDiscountPercent > 0 ? (1 - txnDiscountPercent / 100) : 1;

      for (const item of items) {
        const rawName = (item as any).n || (item as any).name || 'Unknown';
        const name = rawName.trim();
        const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
        const quantity = Number((item as any).q || (item as any).quantity || 0);
        const price = Number((item as any).p || (item as any).price || 0);
        const revenue = Math.round(price * quantity * discountFactor * 100) / 100;

        // Detect item type (food / liquor / beverages)
        let type = getAnalyticsType(item);

        // Historical fallback & correction for items that defaulted to 'FOOD' mistakenly
        if (type === 'food' || type === 'beverages') {
          const lowerName = name.toLowerCase();
          if (liquorKeywords.some(keyword => lowerName.startsWith(keyword))) {
            type = 'liquor';
          }
        }

        // Note: Do NOT exclude liquor items based on outletType — sections may have mixed items

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

/**
 * GET /api/analytics/top-items
 * Query params:
 *   - outletId: 'all' | specific outlet ID (defaults to current tenant's outlets)
 *   - limit: number (default 3)
 *   - startDate: YYYY-MM-DD (default today)
 *   - endDate: YYYY-MM-DD (default today)
 *   - sortBy: 'quantity' | 'revenue' (default quantity)
 *
 * Returns: { items: [{ name, quantity, revenue }], dateRange }
 */
router.get('/top-items', authenticate, cacheMiddleware('analytics:top-items', 30_000), async (req: any, res) => {
  try {
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { startDate, endDate, limit, sortBy } = req.query;
    const { start, end, startIST, endIST } = parseISTRange(startDate as string, endDate as string);
    const topLimit = Math.min(Math.max(Number(limit || 3), 1), 50);
    const sortField = String(sortBy || 'quantity').toLowerCase() === 'revenue' ? 'revenue' : 'quantity';

    const transactions = await prisma.transaction.findMany({
      where: completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
      select: {
        items: true,
        discountPercent: true,
      },
    });

    const itemMap = new Map<string, { name: string; quantity: number; revenue: number }>();

    for (const txn of transactions) {
      const items = Array.isArray(txn.items) ? txn.items : [];
      const txnDiscountPercent = Number(txn.discountPercent ?? 0);
      const discountFactor = txnDiscountPercent > 0 ? (1 - txnDiscountPercent / 100) : 1;

      for (const item of items) {
        const rawName = (item as any).n || (item as any).name || 'Unknown';
        const name = rawName.trim();
        const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
        const quantity = Number((item as any).q || (item as any).quantity || 0);
        const price = Number((item as any).p || (item as any).price || 0);
        const revenue = Math.round(price * quantity * discountFactor * 100) / 100;

        if (itemMap.has(key)) {
          const existing = itemMap.get(key)!;
          existing.quantity += quantity;
          existing.revenue += revenue;
        } else {
          itemMap.set(key, { name, quantity, revenue });
        }
      }
    }

    const itemsData = Array.from(itemMap.entries())
      .map(([_, data]) => ({
        name: data.name,
        quantity: data.quantity,
        revenue: Math.round(data.revenue * 100) / 100,
      }))
      .sort((a, b) => b[sortField as 'quantity' | 'revenue'] - a[sortField as 'quantity' | 'revenue'])
      .slice(0, topLimit);

    res.json({
      items: itemsData,
      dateRange: { startDate: start, endDate: end },
    });
  } catch (err) {
    logger.error({ err }, '[Analytics] top-items error');
    res.status(500).json({ error: 'Failed to fetch top items' });
  }
});

/**
 * GET /api/analytics/today-specials-sold
 * Query params:
 *   - outletId: 'all' | specific outlet ID (defaults to current tenant's outlets)
 *   - startDate: YYYY-MM-DD (default today)
 *   - endDate: YYYY-MM-DD (default today)
 *
 * Returns: { specials: [{ id, name, specialChannel, soldCount }] }
 */
router.get('/today-specials-sold', optionalAuth, async (req: any, res) => {
  try {
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { startDate, endDate } = req.query;
    const { start, end, startIST, endIST } = parseISTRange(startDate as string, endDate as string);
    const specialsWhere: any = {
      restaurantId: { in: tenantIds },
      isSpecial: true,
    };
    const specialsSelect: any = { id: true, name: true, specialChannel: true };

    const orgPrisma = withOrgScope(undefined, tenantIds) as any;
    const [activeSpecials, transactions] = await Promise.all([
      orgPrisma.menuItem.findMany({ where: specialsWhere, select: specialsSelect }),
      orgPrisma.transaction.findMany({
        where: completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
        select: { items: true, orderId: true },
      }),
    ]);

    const specialMap = new Map<string, { id: string; name: string; specialChannel: string | null; soldCount: number }>();
    for (const special of activeSpecials) {
      specialMap.set(special.id, { id: special.id, name: special.name, specialChannel: special.specialChannel, soldCount: 0 });
    }

    let totalTables = 0;
    const tablesWithSpecials = new Set<string>();

    for (const txn of transactions) {
      totalTables++;
      const items = Array.isArray(txn.items) ? txn.items : [];
      let hasSpecial = false;
      for (const item of items) {
        const menuItemId = (item as any).menuItemId || (item as any).id;
        const quantity = Number((item as any).q || (item as any).quantity || 0);
        if (menuItemId && specialMap.has(menuItemId)) {
          const existing = specialMap.get(menuItemId)!;
          existing.soldCount += quantity;
          hasSpecial = true;
        }
      }
      if (hasSpecial && txn.orderId) {
        tablesWithSpecials.add(txn.orderId);
      }
    }

    const specials = Array.from(specialMap.values()).filter(s => s.soldCount > 0);
    const tablesWithSpecialsCount = tablesWithSpecials.size;
    const conversionRate = totalTables > 0 ? Math.round((tablesWithSpecialsCount / totalTables) * 100) : 0;

    res.json({
      specials,
      dateRange: { startDate: start, endDate: end },
      tableMetrics: {
        totalTables,
        tablesWithSpecials: tablesWithSpecialsCount,
        conversionRate,
        totalSpecialsSold: specials.reduce((sum, s) => sum + s.soldCount, 0),
      },
    });
  } catch (err) {
    logger.error({ err }, '[Analytics] today-specials-sold error');
    res.status(500).json({ error: 'Failed to fetch today specials sold' });
  }
});

/**
 * GET /api/analytics/today-specials-by-staff
 * Query params:
 *   - outletId: 'all' | specific outlet ID (defaults to current tenant's outlets)
 *   - startDate: YYYY-MM-DD (default today)
 *   - endDate: YYYY-MM-DD (default today)
 *
 * Returns: { staff: [{ userId, name, soldCount, revenue, items: [{ name, soldCount, revenue }] }] }
 * Attributes special sales to the captain who sold them. Attribution priority:
 *   1. Kot.captainId — the captain who sent the KOT (most accurate, per-item)
 *   2. Transaction.captainId — the captain on the settled bill (fallback)
 * Only order items that are not cancelled and belong to a paid order are counted.
 * All active captains in the selected scope are returned, even those with zero sales.
 */
router.get('/today-specials-by-staff', optionalAuth, async (req: any, res) => {
  try {
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { startDate, endDate } = req.query;
    const { start, end, startIST, endIST } = parseISTRange(startDate as string, endDate as string);
    const orgPrisma = withOrgScope(undefined, tenantIds) as any;

    // 1. Load paid transactions with their captainId and order items.
    const completedTxns = await orgPrisma.transaction.findMany({
      where: completedTxnWhere(tenantIds, { paidAt: { gte: startIST, lte: endIST } }),
      select: {
        orderId: true,
        captainId: true,
        order: {
          select: {
            id: true,
            items: {
              where: { removedFromBill: false, quantity: { gt: 0 } },
              include: { menuItem: { select: { id: true, name: true, basePrice: true, isSpecial: true, isDeleted: true } } },
            },
          },
        },
      },
    });

    // 2. Build a set of paid order IDs for the KOT lookup.
    const paidOrderIds = new Set((completedTxns as any[])
      .map((t: any) => t.orderId)
      .filter(Boolean));

    // 3. Load KOTs that have a captain for paid orders (per-item attribution).
    //    When a KOT has a captainId, it overrides the transaction-level captain
    //    because it's more accurate — it identifies who actually sent the item.
    const kots = paidOrderIds.size > 0 ? await orgPrisma.kot.findMany({
      where: {
        captainId: { not: null },
        orderId: { in: Array.from(paidOrderIds) },
      },
      include: {
        items: {
          include: {
            orderItem: { select: { id: true } },
          },
        },
      },
    }) : [];

    // Map orderItemId → captainId from KOTs (latest KOT wins per order item).
    const orderItemKotCaptain = new Map<string, string>();
    const orderKotCaptainLatest = new Map<string, { captainId: string; createdAt: Date }>();
    for (const kot of kots as any[]) {
      const captainId = kot.captainId;
      if (!captainId || captainId === 'N/A') continue;
      const kotCreatedAt = new Date(kot.createdAt || 0);
      const existing = orderKotCaptainLatest.get(kot.orderId);
      if (!existing || kotCreatedAt > existing.createdAt) {
        orderKotCaptainLatest.set(kot.orderId, { captainId, createdAt: kotCreatedAt });
      }
      for (const kotItem of kot.items || []) {
        if (kotItem.orderItem?.id) {
          orderItemKotCaptain.set(kotItem.orderItem.id, captainId);
        }
      }
    }

    const staffMap = new Map<string, { userId: string; name: string | null; role: string | null; soldCount: number; revenue: number; items: Map<string, { name: string; soldCount: number; revenue: number }> }>();

    // 4. Attribute each special order item to a captain.
    //    Priority: KOT captain (per-item) > KOT captain (per-order) > Transaction captain.
    for (const txn of completedTxns as any[]) {
      const txnCaptainId = txn.captainId;
      const orderKotCaptain = orderKotCaptainLatest.get(txn.orderId)?.captainId || null;
      const items = txn.order?.items || [];
      for (const item of items) {
        const menuItem = item.menuItem;
        if (!menuItem || !menuItem.isSpecial || menuItem.isDeleted) continue;
        const quantity = Number(item.quantity || 0);
        if (quantity <= 0) continue;
        // Attribution priority: per-item KOT > per-order KOT > transaction
        const captainId = orderItemKotCaptain.get(item.id) || orderKotCaptain || txnCaptainId;
        if (!captainId || captainId === 'N/A') continue;
        const price = Number(menuItem.basePrice || item.price || 0);
        const name = menuItem.name || item.name || 'Unknown Item';
        const existing = staffMap.get(captainId);
        if (existing) {
          existing.soldCount += quantity;
          existing.revenue += quantity * price;
          const itemRecord = existing.items.get(menuItem.id);
          if (itemRecord) {
            itemRecord.soldCount += quantity;
            itemRecord.revenue += quantity * price;
          } else {
            existing.items.set(menuItem.id, { name, soldCount: quantity, revenue: quantity * price });
          }
        } else {
          const itemsMap = new Map<string, { name: string; soldCount: number; revenue: number }>();
          itemsMap.set(menuItem.id, { name, soldCount: quantity, revenue: quantity * price });
          staffMap.set(captainId, { userId: captainId, name: null, role: null, soldCount: quantity, revenue: quantity * price, items: itemsMap });
        }
      }
    }

    // 5. Add manually-entered backfill counts for the date range.
    //    When sync fails (orders/KOTs not in cloud), owners can insert rows
    //    into CaptainBackfill so the leaderboard still reflects real sales.
    //    This is raw SQL because the table may not be in the generated Prisma
    //    client if prisma generate has not been run yet.
    const tenantIdList = (tenantIds as string[]).map((id: string) => `'${id.replace(/'/g, "''")}'`).join(',');
    const backfillRows = await (orgPrisma as any).$queryRawUnsafe(
      `SELECT "userId" AS captain_id, SUM("specialSoldCount") AS sold_count, SUM("revenue") AS revenue
       FROM "CaptainBackfill"
       WHERE "restaurantId" IN (${tenantIdList})
         AND "date" >= $1
         AND "date" <= $2
       GROUP BY "userId"`,
      start,
      end,
    ) as any[];

    const backfillItemName = 'Yet to be synced from local database';
    for (const row of backfillRows || []) {
      const captainId = row.captain_id;
      const quantity = Number(row.sold_count || 0);
      const revenue = Number(row.revenue || 0);
      if (!captainId || quantity <= 0) continue;
      const existing = staffMap.get(captainId);
      if (existing) {
        existing.soldCount += quantity;
        existing.revenue += revenue;
        const itemRecord = existing.items.get('__backfill__');
        if (itemRecord) {
          itemRecord.soldCount += quantity;
          itemRecord.revenue += revenue;
        } else {
          existing.items.set('__backfill__', { name: backfillItemName, soldCount: quantity, revenue });
        }
      } else {
        const itemsMap = new Map<string, { name: string; soldCount: number; revenue: number }>();
        itemsMap.set('__backfill__', { name: backfillItemName, soldCount: quantity, revenue });
        staffMap.set(captainId, { userId: captainId, name: null, role: null, soldCount: quantity, revenue, items: itemsMap });
      }
    }

    // Look up every staff member in the map to get their name AND role.
    // We need the role to filter the leaderboard to CAPTAIN-only.
    // Also fetch the linked Employee designation — User.role is just the
    // login role and many non-captain staff have role='CAPTAIN'. The real
    // job designation is on the Employee record.
    const userIds = Array.from(staffMap.keys());
    if (userIds.length > 0) {
      const users = await (prisma as any).user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          name: true,
          role: true,
          employee: { select: { designation: true, role: true } },
        } as any,
      });
      for (const user of users) {
        const record = staffMap.get(user.id);
        if (record) {
          record.name = user.name || null;
          record.role = user.role || null;
          // Store the employee designation so we can filter accurately below.
          // If there is no linked Employee record, treat designation as null
          // (the user will be excluded from the captain leaderboard).
          const empDesig = user.employee
            ? (user.employee.designation || user.employee.role || '').toUpperCase()
            : '';
          (record as any).employeeDesignation = empDesig;
        }
      }
    }

    // Include all active captains in the selected scope so their names appear
    // even when they have not sold any specials in the period.
    // IMPORTANT: User.role is just the login role — many non-captain staff
    // (assistants, bar staff, cleaners, waiters, security, etc.) have
    // role='CAPTAIN' so they can take orders. The real job designation lives
    // on the linked Employee record (Employee.designation / Employee.role).
    // We only include users whose Employee designation is CAPTAIN, CPATION
    // (a known typo in the data), or CAPTION.
    const allCaptains = await (prisma as any).user.findMany({
      where: {
        isActive: true,
        role: 'CAPTAIN',
        OR: [
          { outletId: { in: tenantIds } },
          { outletAccess: { some: { outletId: { in: tenantIds } } } },
        ],
        employee: {
          isActive: true,
          OR: [
            { designation: { in: ['CAPTAIN', 'CPATION', 'CAPTION', 'Captain'] } },
            { role: { in: ['CAPTAIN', 'CPATION', 'CAPTION', 'Captain'] } },
          ],
        },
      },
      select: { id: true, name: true },
    });
    for (const captain of allCaptains) {
      if (!staffMap.has(captain.id)) {
        staffMap.set(captain.id, {
          userId: captain.id,
          name: captain.name || null,
          role: 'CAPTAIN',
          soldCount: 0,
          revenue: 0,
          items: new Map(),
          // These users passed the employee designation filter above, so mark
          // them as real captains.
          employeeDesignation: 'CAPTAIN',
        } as any);
      } else {
        // Ensure existing entries from transactions also get marked if they
        // were included by the allCaptains query.
        const existing = staffMap.get(captain.id) as any;
        if (!existing.employeeDesignation) {
          existing.employeeDesignation = 'CAPTAIN';
        }
      }
    }

    // Filter to real captains only. User.role='CAPTAIN' is just the login
    // role — many non-captain staff (assistants, bar staff, cleaners, etc.)
    // have it so they can take orders. The real job designation is on the
    // Employee record. We include users whose employee designation is
    // CAPTAIN, CPATION (a known typo), or CAPTION. Users without a linked
    // Employee record are excluded.
    const CAPTAIN_DESIGNATIONS = new Set(['CAPTAIN', 'CPATION', 'CAPTION']);
    const staff = Array.from(staffMap.values())
      .filter(s => {
        const desig = (s as any).employeeDesignation || '';
        return CAPTAIN_DESIGNATIONS.has(desig.toUpperCase());
      })
      .map(s => ({
        userId: s.userId,
        name: s.name,
        role: s.role,
        soldCount: s.soldCount,
        revenue: s.revenue,
        items: Array.from(s.items.values()).sort((a, b) => b.soldCount - a.soldCount),
      }))
      .sort((a, b) => {
        if (b.soldCount !== a.soldCount) return b.soldCount - a.soldCount;
        return (a.name || a.userId).localeCompare(b.name || b.userId);
      });

    res.json({ staff, dateRange: { startDate: start, endDate: end } });
  } catch (err) {
    logger.error({ err }, '[Analytics] today-specials-by-staff error');
    res.status(500).json({ error: 'Failed to fetch today specials by staff' });
  }
});

export default router;
