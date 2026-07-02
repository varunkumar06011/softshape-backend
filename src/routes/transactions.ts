// ─────────────────────────────────────────────────────────────────────────────
// Transactions Routes — Payment transaction records for settled orders
// ─────────────────────────────────────────────────────────────────────────────
// Manages transaction records created when an order is settled (paid).
// Each transaction stores payment details (amount, method, items, GST, discounts)
// and is assigned a daily-sequential transaction number.
//
// Features:
//   - Atomic daily-sequential txnNumber generation via Prisma transaction + upsert
//   - IST date-based filtering (per-day or per-month)
//   - Section filtering and nested section name resolution
//   - Duplicate prevention via unique constraint on orderId
//   - Cache invalidation on mutations (transactions, analytics, reports, stats)
//   - No caching on GET endpoints — transaction lists must always be fresh
//
// Endpoints:
//   POST   /api/transactions           — save a completed transaction
//   GET    /api/transactions/all       — list recent 500 transactions (no date filter)
//   GET    /api/transactions           — list transactions with date/month/section filters
//   DELETE /api/transactions/:id       — delete a transaction (with ownership check)
//
// All routes require authentication.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import logger from "../lib/logger";
import { Prisma, PrismaClient } from '@prisma/client';
import { getKolkataDateString } from '../utils/date';
import prisma from '../lib/prisma';
import { invalidateCache } from '../lib/cache';
import { authenticate } from '../middleware/auth';

const router = Router();

// Apply authentication to all transaction routes
router.use(authenticate);

// ── Daily-sequential Transaction counter ──────────────────────────────────
// Generates a per-restaurant, per-day sequential transaction number (1, 2, 3, ...).
// Must be called inside a Prisma transaction (tx) so the increment is atomic.
// Uses upsert on (restaurantId, counterDate) to handle both first-of-day and subsequent txns.
async function getNextTxnNumber(
  restaurantId: string,
  tx: any
): Promise<number> {
  const counterDate = getKolkataDateString();

  return await tx.dailyCounter.upsert({
    where: { restaurantId_counterDate: { restaurantId, counterDate } },
    update: { txnCount: { increment: 1 } },
    create: { restaurantId, counterDate, txnCount: 1 },
    // Add select to ensure atomic read
    select: { txnCount: true }
  }).then((c: { txnCount: number }) => c.txnCount);
}

// POST /api/transactions — save a completed transaction
router.post('/', invalidateCache(['transactions:*', 'analytics:*', 'reports:*', 'stats:today:*']), async (req: any, res) => {
  try {
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!restaurantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const {
      orderId,
      tableNumber,
      captainId,
      amount,
      method,
      itemCount,
      items,
      subtotal,
      discountPercent,
      discountAmount,
      cgst,
      sgst,
      grandTotal,
      billNumber,
      sectionId,
      sectionTag,
      platform,
    } = req.body;

    if (!amount || !method) {
      return res.status(400).json({ error: 'amount and method are required' });
    }

    if (!platform) {
      logger.warn(`[Transaction] platform missing for order ${orderId || '(no order)'}`);
    }
    if (!sectionId) {
      logger.warn(`[Transaction] sectionId missing for order ${orderId || '(no order)'}`);
    }

    // Look up order to populate missing fields (sectionTag, sectionId, platform, billNumber, captainId)
    let resolvedSectionTag: string | null = sectionTag ?? null;
    let resolvedSectionId: string | null = sectionId ?? null;
    let resolvedPlatform: string | null = platform ?? null;
    let resolvedBillNumber: string | null = billNumber ?? null;
    let resolvedCaptainId: string | null = captainId || null;

    if (orderId) {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          table: {
            include: { section: true },
          },
        },
      });
      if (order) {
        resolvedSectionTag = (order.table as any)?.sectionTag || null;
        resolvedSectionId = resolvedSectionId || order.table?.sectionId || null;
        resolvedPlatform = resolvedPlatform || order.platform || null;
        resolvedBillNumber = resolvedBillNumber || order.billNumber || null;
        resolvedCaptainId = resolvedCaptainId || order.table?.captainId || null;
      }
    }

    // Deduplicate items to prevent inflated analytics
    let resolvedItems: any[] = [];
    if (Array.isArray(items) && items.length > 0) {
      const itemMap = new Map<string, any>();
      for (const item of items) {
        const qty = Number(item.quantity || item.q || 0);
        if (qty <= 0) continue;
        const name = (item.name || item.n || '').trim();
        const price = Number(item.price || item.p || 0);
        const key = `${name.toLowerCase()}::${price}`;
        const existing = itemMap.get(key);
        if (existing) {
          existing.quantity += qty;
        } else {
          itemMap.set(key, {
            name,
            quantity: qty,
            price,
            menuType: item.menuType || item.type || 'FOOD',
          });
        }
      }
      resolvedItems = Array.from(itemMap.values());
    }

    // Compute IST date for daily sequential numbering
    const txnDate = getKolkataDateString();

    // Use atomic transaction to get next txnNumber and create transaction
    const transaction = await prisma.$transaction(async (tx) => {
      const txnNumber = await getNextTxnNumber(String(restaurantId), tx);

      return await tx.transaction.create({
        data: {
          restaurantId,
          orderId: orderId || null,
          tableNumber: tableNumber ? Number(tableNumber) : null,
          captainId: resolvedCaptainId,
          amount: new Prisma.Decimal(amount),
          method: method.toUpperCase(),
          itemCount: resolvedItems.length || Number(itemCount) || 0,
          items: resolvedItems.length > 0 ? resolvedItems : (items || []),
          subtotal: subtotal != null ? new Prisma.Decimal(subtotal) : null,
          discountPercent: discountPercent != null ? new Prisma.Decimal(discountPercent) : new Prisma.Decimal(0),
          discountAmount: discountAmount != null ? new Prisma.Decimal(discountAmount) : new Prisma.Decimal(0),
          cgst: cgst != null ? new Prisma.Decimal(cgst) : null,
          sgst: sgst != null ? new Prisma.Decimal(sgst) : null,
          grandTotal: grandTotal != null ? new Prisma.Decimal(grandTotal) : null,
          sectionTag: resolvedSectionTag,
          sectionId: resolvedSectionId,
          platform: resolvedPlatform,
          txnNumber,
          txnDate,
          billNumber: resolvedBillNumber,
        },
      });
    }, { timeout: 15000, maxWait: 10000 });

    res.status(201).json(transaction);
  } catch (err: any) {
    // P2002 = unique constraint violation — orderId already has a transaction
    if (err?.code === 'P2002' && err?.meta?.target?.includes('orderId')) {
      return res.status(409).json({ error: 'This order has already been settled.' });
    }
    logger.error({ err }, '[Transactions] POST error:');
    res.status(500).json({ error: 'Failed to save transaction' });
  }
});


// GET /api/transactions/all?restaurantId=...
// NOTE: No cacheMiddleware here — transaction lists must always be fresh
router.get('/all', async (req: any, res) => {
  try {
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!restaurantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const transactions = await prisma.transaction.findMany({
      where: { restaurantId },
      orderBy: { paidAt: 'desc' },
      take: 500,
      include: {
        order: {
          select: {
            table: {
              select: {
                sectionTag: true,
                section: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const transactionsWithSection = transactions.map(txn => ({
      ...txn,
      sectionId: (txn as any).sectionId || (txn as any).order?.table?.section?.id || null,
      sectionName: (txn as any).section?.name || (txn as any).order?.table?.section?.name || null,
      sectionTag: (txn as any).sectionTag || (txn as any).order?.table?.sectionTag || null,
      order: undefined,
      section: undefined,
    }));

    res.json(transactionsWithSection);
  } catch (err) {
    logger.error({ err }, '[Transactions] GET /all error:');
    res.status(500).json({ error: 'Failed to fetch all transactions' });
  }
});

// GET /api/transactions?restaurantId=&limit=50&date=2026-05-23
//                       &month=2026-05  (optional, takes precedence when date absent)
// NOTE: No cacheMiddleware here — transaction lists must always be fresh
// because settlements write new records and stale cache causes missing bills.
router.get('/', async (req: any, res) => {
  try {
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    const { limit, date, month, sectionId, billNumber } = req.query;

    if (process.env.NODE_ENV !== 'production') logger.info({ restaurantId, limit, date, month }, '[Transactions] GET request:');

    if (!restaurantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

    // Build date range filter
    let dateFilter = {};
    if (date) {
      // Per-day filter: treat YYYY-MM-DD as an IST calendar day → convert to UTC range
      const [year, mon, day] = String(date).split('-').map(Number);
      const startIST = new Date(Date.UTC(year, mon - 1, day,  0,  0,  0,   0) - IST_OFFSET_MS);
      const endIST   = new Date(Date.UTC(year, mon - 1, day, 23, 59, 59, 999) - IST_OFFSET_MS);
      dateFilter = { paidAt: { gte: startIST, lte: endIST } };
      if (process.env.NODE_ENV !== 'production') logger.info({ date, startIST, endIST }, '[Transactions] Date filter:');
    } else if (month) {
      // Monthly filter: treat YYYY-MM as an IST calendar month → convert to UTC range
      const [year, mon] = String(month).split('-').map(Number);
      // First moment of month (day 1, 00:00:00 IST) → UTC
      const startIST = new Date(Date.UTC(year, mon - 1,  1,  0,  0,  0,   0) - IST_OFFSET_MS);
      // Last moment of month (day 0 of next month = last day, 23:59:59.999 IST) → UTC
      const endIST   = new Date(Date.UTC(year,  mon,     0, 23, 59, 59, 999) - IST_OFFSET_MS);
      dateFilter = { paidAt: { gte: startIST, lte: endIST } };
      if (process.env.NODE_ENV !== 'production') logger.info({ month, startIST, endIST }, '[Transactions] Month filter:');
    }

    const prismaQuery: any = {
      where: {
        restaurantId,
        ...(sectionId ? { sectionId: String(sectionId) } : {}),
        ...dateFilter,
        ...(billNumber ? {
          OR: [
            { billNumber: { contains: String(billNumber), mode: 'insensitive' } },
            ...(isNaN(Number(billNumber)) ? [] : [{ txnNumber: Number(billNumber) }]),
          ]
        } : {}),
      },
      orderBy: { paidAt: 'desc' },
      include: {
        order: {
          select: {
            table: {
              select: {
                sectionTag: true,
                section: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    };

    if (limit && Number(limit) > 0) {
      prismaQuery.take = Math.min(Number(limit), 5000);
    }

    if (process.env.NODE_ENV !== 'production') logger.info(`[Transactions] Prisma query: ${JSON.stringify(prismaQuery, null, 2)}`);

    const transactions = await prisma.transaction.findMany(prismaQuery) as any[];

    if (process.env.NODE_ENV !== 'production') logger.info(`[Transactions] Found transactions: ${transactions.length}`);

    // Map results to add flat sectionName field
    const transactionsWithSection = transactions.map(txn => ({
      ...txn,
      sectionId: txn.sectionId || txn.order?.table?.section?.id || null,
      sectionName: txn.section?.name || txn.order?.table?.section?.name || null,
      sectionTag: txn.sectionTag || (txn.order?.table as any)?.sectionTag || null,
      platform: txn.platform || txn.order?.platform || null,
      order: undefined, // strip nested order object
      section: undefined, // strip nested section object
    }));

    if (process.env.NODE_ENV !== 'production') logger.info(`[Transactions] Returning transactions with section: ${transactionsWithSection.length}`);
    res.json(transactionsWithSection);
  } catch (err) {
    logger.error({ err }, '[Transactions] GET error:');
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// DELETE /api/transactions/:id?restaurantId=...
router.delete('/:id', invalidateCache(['transactions:*', 'analytics:*', 'reports:*', 'stats:today:*']), async (req: any, res) => {
  try {
    const id = req.params.id as string;
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;

    if (!restaurantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const existing = await prisma.transaction.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    if (existing.restaurantId !== String(restaurantId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.transaction.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, '[Transactions] DELETE error:');
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

export default router;
