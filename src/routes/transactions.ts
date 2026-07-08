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
import { authenticate, requireRole } from '../middleware/auth';
import { getNextTxnNumber, completedTxnWhere } from '../lib/transactionHelpers';
import { settleOrderService } from '../services/orderService';
import { createAuditLog } from '../lib/auditLog';

const router = Router();

// Apply authentication to all transaction routes
router.use(authenticate);

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
      roundOff,
      billNumber,
      sectionId,
      sectionTag,
      platform,
      tipAmount,
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
            gstEnabled: item.gstEnabled ?? true,
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
          roundOff: roundOff != null ? new Prisma.Decimal(roundOff) : null,
          tipAmount: tipAmount != null ? new Prisma.Decimal(tipAmount) : new Prisma.Decimal(0),
          sectionTag: resolvedSectionTag,
          sectionId: resolvedSectionId,
          platform: resolvedPlatform,
          txnNumber,
          txnDate,
          billNumber: resolvedBillNumber,
          status: 'COMPLETED',
          paidAt: new Date(),
          confirmedAt: new Date(),
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
    const { limit, date, month, sectionId, billNumber, tableNumber } = req.query;

    if (process.env.NODE_ENV !== 'production') logger.info({ restaurantId, limit, date, month, tableNumber }, '[Transactions] GET request:');

    if (!restaurantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Build date filter using txnDate string (IST business date) instead of paidAt.
    // This avoids timezone mismatch between server/db and matches how expenditures
    // are filtered (expenditureDate string).
    let dateFilter = {};
    if (date) {
      dateFilter = { txnDate: String(date) };
      if (process.env.NODE_ENV !== 'production') logger.info({ date }, '[Transactions] Date filter:');
    } else if (month) {
      dateFilter = { txnDate: { startsWith: String(month) } };
      if (process.env.NODE_ENV !== 'production') logger.info({ month }, '[Transactions] Month filter:');
    }

    const prismaQuery: any = {
      where: {
        restaurantId,
        ...(sectionId ? { sectionId: String(sectionId) } : {}),
        ...(tableNumber && !isNaN(Number(tableNumber)) ? { tableNumber: Number(tableNumber) } : {}),
        ...dateFilter,
        ...(billNumber ? {
          OR: [
            { billNumber: { equals: String(billNumber), mode: 'insensitive' } },
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

// POST /api/transactions/:id/confirm-payment
// Recover a PENDING or CANCELLED transaction into a COMPLETED sale. Used by
// admins/cashiers to confirm payment for bills that were terminated, failed, or
// stuck in PENDING after printing.
router.post('/:id/confirm-payment', requireRole('OWNER', 'ADMIN', 'CASHIER'), invalidateCache(['transactions:*', 'analytics:*', 'reports:*', 'stats:today:*']), async (req: any, res) => {
  try {
    const id = req.params.id as string;
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    const userId = req.user?.userId;
    const { paymentMethod = 'CASH', cashAmount, cardAmount } = req.body;

    if (!restaurantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Lock the transaction row so concurrent confirm/delete attempts are serialized.
      const rows = await tx.$queryRaw<Array<{ id: string; status: string; orderId: string | null; restaurantId: string }>>`
        SELECT "id", "status", "orderId", "restaurantId"
        FROM "Transaction" WHERE "id" = ${id} FOR UPDATE
      `;
      const txn = rows[0];
      if (!txn) {
        throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });
      }
      if (txn.restaurantId !== String(restaurantId)) {
        throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
      }
      if (txn.status === 'COMPLETED') {
        throw Object.assign(new Error('Transaction is already completed'), { statusCode: 409 });
      }

      const now = new Date();
      const txnDate = getKolkataDateString();

      // PENDING transactions with an active order should be settled normally so
      // inventory and table state are handled by the core settlement flow.
      if (txn.status === 'PENDING' && txn.orderId) {
        const order = await tx.order.findUnique({
          where: { id: txn.orderId },
          select: { id: true, status: true },
        });
        if (order && order.status !== 'PAID') {
          // Commit the transaction to unlock the row before calling settleOrderService,
          // which runs its own transaction and locks the order. We return a marker so
          // the outer code can invoke settleOrderService and return its result.
          return { action: 'settle', orderId: order.id, paymentMethod } as any;
        }
        // Order is already paid (or missing); just mark the transaction COMPLETED.
      }

      // Recovery path: mark CANCELLED/FAILED/PENDING-without-order as COMPLETED.
      const updated = await tx.transaction.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          method: String(paymentMethod).toUpperCase(),
          paidAt: now,
          confirmedAt: now,
          txnDate,
          cashAmount: cashAmount != null ? cashAmount : 0,
          cardAmount: cardAmount != null ? cardAmount : 0,
          recoverySource: txn.status === 'CANCELLED' ? 'confirm-payment-cancelled' : (txn.status === 'FAILED' ? 'confirm-payment-failed' : 'confirm-payment-pending'),
        },
      });

      return { action: 'updated', transaction: updated, previousStatus: txn.status } as any;
    }, { timeout: 15000, maxWait: 20000 });

    if (result.action === 'settle') {
      const settleResult = await settleOrderService({
        orderId: result.orderId,
        restaurantId: String(restaurantId),
        userId,
        paymentMethod: result.paymentMethod,
        cashAmount,
        cardAmount,
      });
      createAuditLog({
        userId,
        restaurantId: String(restaurantId),
        action: 'TRANSACTION_CONFIRM_PAYMENT',
        entityType: 'Transaction',
        entityId: id,
        metadata: { orderId: result.orderId, paymentMethod: result.paymentMethod, via: 'settle' },
      });
      return res.json({ transaction: settleResult.transaction, order: settleResult.order });
    }

    createAuditLog({
      userId,
      restaurantId: String(restaurantId),
      action: 'TRANSACTION_CONFIRM_PAYMENT',
      entityType: 'Transaction',
      entityId: id,
      metadata: { paymentMethod, via: 'recovery', previousStatus: result.previousStatus },
    });

    return res.json({ transaction: result.transaction });
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error({ err }, '[Transactions] confirm-payment error:');
    return res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

// DELETE /api/transactions/:id?restaurantId=...
// Restricted to OWNER/ADMIN and never allows deleting a COMPLETED transaction,
// preserving the fail-safe audit trail.
router.delete('/:id', requireRole('OWNER', 'ADMIN'), invalidateCache(['transactions:*', 'analytics:*', 'reports:*', 'stats:today:*']), async (req: any, res) => {
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
    if (existing.status === 'COMPLETED') {
      return res.status(403).json({ error: 'Completed transactions cannot be deleted' });
    }

    await prisma.transaction.delete({ where: { id } });
    createAuditLog({
      userId: req.user?.userId,
      restaurantId: String(restaurantId),
      action: 'TRANSACTION_DELETE',
      entityType: 'Transaction',
      entityId: id,
      metadata: { previousStatus: existing.status },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, '[Transactions] DELETE error:');
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

export default router;
