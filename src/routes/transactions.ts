import { Router } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import { getKolkataDateString } from '../utils/date';
import prisma from '../lib/prisma';
import { cacheMiddleware, invalidateCache } from '../lib/cache';

const router = Router();

// ── Daily-sequential Transaction counter ──────────────────────────────────
// Must be called inside a Prisma transaction (tx) so the increment is atomic.
async function getNextTxnNumber(
  restaurantId: string,
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>
): Promise<number> {
  const counterDate = getKolkataDateString();

  return await tx.dailyCounter.upsert({
    where: { restaurantId_counterDate: { restaurantId, counterDate } },
    update: { txnCount: { increment: 1 } },
    create: { restaurantId, counterDate, txnCount: 1 },
    // Add select to ensure atomic read
    select: { txnCount: true }
  }).then(c => c.txnCount);
}

// POST /api/transactions — save a completed transaction
router.post('/', invalidateCache(['transactions:*', 'analytics:*', 'reports:*', 'stats:today:*']), async (req, res) => {
  try {
    const {
      restaurantId,
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
    } = req.body;

    if (!restaurantId || !amount || !method) {
      return res.status(400).json({ error: 'restaurantId, amount, and method are required' });
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
          captainId: captainId || null,
          amount: new Prisma.Decimal(amount),
          method: method.toUpperCase(),
          itemCount: Number(itemCount) || 0,
          items: items || [],
          subtotal: subtotal != null ? new Prisma.Decimal(subtotal) : null,
          discountPercent: discountPercent != null ? new Prisma.Decimal(discountPercent) : new Prisma.Decimal(0),
          discountAmount: discountAmount != null ? new Prisma.Decimal(discountAmount) : new Prisma.Decimal(0),
          cgst: cgst != null ? new Prisma.Decimal(cgst) : null,
          sgst: sgst != null ? new Prisma.Decimal(sgst) : null,
          grandTotal: grandTotal != null ? new Prisma.Decimal(grandTotal) : null,
          txnNumber,
          txnDate,
          billNumber: billNumber ?? null,
        },
      });
    }, { timeout: 15000, maxWait: 10000 });

    res.status(201).json(transaction);
  } catch (err: any) {
    // P2002 = unique constraint violation — orderId already has a transaction
    if (err?.code === 'P2002' && err?.meta?.target?.includes('orderId')) {
      return res.status(409).json({ error: 'This order has already been settled.' });
    }
    console.error('[Transactions] POST error:', err);
    res.status(500).json({ error: 'Failed to save transaction' });
  }
});


// GET /api/transactions/all?restaurantId=...
router.get('/all', cacheMiddleware('transactions:list', 15_000), async (req, res) => {
  try {
    const { restaurantId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }

    const transactions = await prisma.transaction.findMany({
      where: { restaurantId: String(restaurantId) },
      orderBy: { paidAt: 'desc' },
      take: 500,  // ← add this line only; returns the 500 most recent
    });

    res.json(transactions);
  } catch (err) {
    console.error('[Transactions] GET /all error:', err);
    res.status(500).json({ error: 'Failed to fetch all transactions' });
  }
});

// GET /api/transactions?restaurantId=&limit=50&date=2026-05-23
//                       &month=2026-05  (optional, takes precedence when date absent)
router.get('/', cacheMiddleware('transactions:list', 15_000), async (req, res) => {
  try {
    const { restaurantId, limit, date, month } = req.query;

    console.log('[Transactions] GET request:', { restaurantId, limit, date, month });

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
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
      console.log('[Transactions] Date filter:', { date, startIST, endIST });
    } else if (month) {
      // Monthly filter: treat YYYY-MM as an IST calendar month → convert to UTC range
      const [year, mon] = String(month).split('-').map(Number);
      // First moment of month (day 1, 00:00:00 IST) → UTC
      const startIST = new Date(Date.UTC(year, mon - 1,  1,  0,  0,  0,   0) - IST_OFFSET_MS);
      // Last moment of month (day 0 of next month = last day, 23:59:59.999 IST) → UTC
      const endIST   = new Date(Date.UTC(year,  mon,     0, 23, 59, 59, 999) - IST_OFFSET_MS);
      dateFilter = { paidAt: { gte: startIST, lte: endIST } };
      console.log('[Transactions] Month filter:', { month, startIST, endIST });
    }

    const prismaQuery: any = {
      where: { restaurantId: String(restaurantId), ...dateFilter },
      orderBy: { paidAt: 'desc' },
      include: {
        order: {
          select: {
            table: {
              select: {
                section: {
                  select: {
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
      prismaQuery.take = Number(limit);
    }

    console.log('[Transactions] Prisma query:', JSON.stringify(prismaQuery, null, 2));

    const transactions = await prisma.transaction.findMany(prismaQuery) as any[];

    console.log('[Transactions] Found transactions:', transactions.length);

    // Map results to add flat sectionName field
    const transactionsWithSection = transactions.map(txn => ({
      ...txn,
      sectionName: txn.order?.table?.section?.name || null,
      sectionTag: (txn.order?.table as any)?.sectionTag || null,
      order: undefined, // strip nested order object
    }));

    console.log('[Transactions] Returning transactions with section:', transactionsWithSection.length);
    res.json(transactionsWithSection);
  } catch (err) {
    console.error('[Transactions] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// DELETE /api/transactions/:id?restaurantId=...
router.delete('/:id', invalidateCache(['transactions:*', 'analytics:*', 'reports:*', 'stats:today:*']), async (req, res) => {
  try {
    const id = req.params.id as string;
    const { restaurantId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
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
    console.error('[Transactions] DELETE error:', err);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

export default router;
