import { Router } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// ── Daily-sequential Transaction counter ──────────────────────────────────
// Must be called inside a Prisma transaction (tx) so the increment is atomic.
async function getNextTxnNumber(
  restaurantId: string,
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>
): Promise<number> {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const counterDate = nowIST.toISOString().slice(0, 10); // "YYYY-MM-DD"

  const counter = await tx.dailyCounter.upsert({
    where: { restaurantId_counterDate: { restaurantId, counterDate } },
    update: { txnCount: { increment: 1 } },
    create: { restaurantId, counterDate, txnCount: 1 },
  });

  return counter.txnCount;
}

// POST /api/transactions — save a completed transaction
router.post('/', async (req, res) => {
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
    } = req.body;

    if (!restaurantId || !amount || !method) {
      return res.status(400).json({ error: 'restaurantId, amount, and method are required' });
    }

    // Compute IST date for daily sequential numbering
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(Date.now() + IST_OFFSET_MS);
    const txnDate = nowIST.toISOString().slice(0, 10); // "YYYY-MM-DD"

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
          txnNumber,
          txnDate,
        },
      });
    });

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
router.get('/all', async (req, res) => {
  try {
    const { restaurantId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }

    const transactions = await prisma.transaction.findMany({
      where: { restaurantId: String(restaurantId) },
      orderBy: { paidAt: 'desc' },
    });

    res.json(transactions);
  } catch (err) {
    console.error('[Transactions] GET /all error:', err);
    res.status(500).json({ error: 'Failed to fetch all transactions' });
  }
});

// GET /api/transactions?restaurantId=&limit=50&date=2026-05-23
//                       &month=2026-05  (optional, takes precedence when date absent)
router.get('/', async (req, res) => {
  try {
    const { restaurantId, limit = '200', date, month } = req.query;

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
    } else if (month) {
      // Monthly filter: treat YYYY-MM as an IST calendar month → convert to UTC range
      const [year, mon] = String(month).split('-').map(Number);
      // First moment of month (day 1, 00:00:00 IST) → UTC
      const startIST = new Date(Date.UTC(year, mon - 1,  1,  0,  0,  0,   0) - IST_OFFSET_MS);
      // Last moment of month (day 0 of next month = last day, 23:59:59.999 IST) → UTC
      const endIST   = new Date(Date.UTC(year,  mon,     0, 23, 59, 59, 999) - IST_OFFSET_MS);
      dateFilter = { paidAt: { gte: startIST, lte: endIST } };
    }

    const transactions = await prisma.transaction.findMany({
      where: { restaurantId: String(restaurantId), ...dateFilter },
      orderBy: { paidAt: 'desc' },
      take: Number(limit),
    });

    res.json(transactions);
  } catch (err) {
    console.error('[Transactions] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

export default router;
