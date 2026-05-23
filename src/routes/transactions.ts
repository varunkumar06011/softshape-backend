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

// GET /api/transactions?restaurantId=&limit=50 — fetch recent transactions
router.get('/', async (req, res) => {
  try {
    const { restaurantId, limit = '50' } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }

    const transactions = await prisma.transaction.findMany({
      where: { restaurantId: String(restaurantId) },
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
