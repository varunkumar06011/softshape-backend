import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

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

    const transaction = await prisma.transaction.create({
      data: {
        restaurantId,
        orderId: orderId || null,
        tableNumber: tableNumber ? Number(tableNumber) : null,
        captainId: captainId || null,
        amount: Number(amount),
        method: method.toUpperCase(),
        itemCount: Number(itemCount) || 0,
        items: items || [],
      },
    });

    res.status(201).json(transaction);
  } catch (err) {
    console.error('[Transactions] POST error:', err);
    res.status(500).json({ error: 'Failed to save transaction' });
  }
});

// GET /api/transactions?restaurantId=&limit=50&date=2026-05-23
router.get('/', async (req, res) => {
  try {
    const { restaurantId, limit = '50', date } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }

    // Build date range filter if date param provided (YYYY-MM-DD, treated as IST day)
    let dateFilter = {};
    if (date) {
      // IST = UTC+5:30 = 330 minutes offset
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      // Parse the local date at midnight IST → convert to UTC
      const [year, month, day] = String(date).split('-').map(Number);
      const startIST = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - IST_OFFSET_MS);
      const endIST   = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - IST_OFFSET_MS);
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
