// ─────────────────────────────────────────────────────────────────────────────
// Liabilities Ledger Routes
// ─────────────────────────────────────────────────────────────────────────────
// Endpoints:
//   GET    /api/liabilities                    — list (filterable by ?status=, ?liabilityType=)
//   GET    /api/liabilities/summary            — AP + loans + payroll payable rollup
//   GET    /api/liabilities/:id                — detail with payment history
//   POST   /api/liabilities                    — manual creation (sourceType: MANUAL)
//   PATCH  /api/liabilities/:id                — edit (reject principalAmount change if payments exist)
//   POST   /api/liabilities/:id/payments       — record a payment, reduce currentBalance
//   POST   /api/liabilities/:id/close          — manual close (forgiven/refinanced)
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { getKolkataDateString } from "../utils/date";
import logger from "../lib/logger";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

// ── Helper: write AuditLog ────────────────────────────────────────────────────
async function writeAuditLog(
  restaurantId: string,
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata?: any
) {
  try {
    await prisma.auditLog.create({
      data: {
        restaurantId,
        userId,
        action,
        entityType,
        entityId: entityId || null,
        metadata: metadata || undefined,
      },
    });
  } catch (err) {
    logger.error({ err }, "[Liability] AuditLog write failed");
  }
}

function serializeLiability(liab: any) {
  return {
    ...liab,
    principalAmount: Number(liab.principalAmount),
    currentBalance: Number(liab.currentBalance),
    interestRate: liab.interestRate ? Number(liab.interestRate) : null,
  };
}

// ── GET /api/liabilities/summary — rollup for balance sheet ──────────────────
router.get("/summary", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    // 1. Accounts Payable: unsettled Expenditure rows with entryType LIABILITY
    const apRows = await prisma.expenditure.findMany({
      where: {
        restaurantId,
        entryType: "LIABILITY",
        isSettled: false,
      },
      select: { amount: true },
    });
    const accountsPayable = apRows.reduce(
      (sum, r) => sum + Number(r.amount),
      0
    );

    // 2. Loans & Credit: active Liability currentBalance
    const loanRows = await prisma.liability.findMany({
      where: { restaurantId, status: "ACTIVE" },
      select: { currentBalance: true },
    });
    const loansAndCredit = loanRows.reduce(
      (sum, r) => sum + Number(r.currentBalance),
      0
    );

    // 3. Payroll Payable: PayrollRecord where status != PAID
    const payrollRows = await prisma.payrollRecord.findMany({
      where: {
        restaurantId,
        status: { not: "PAID" },
      },
      select: { netPayable: true, paidAmount: true },
    });
    const payrollPayable = payrollRows.reduce(
      (sum, r) => sum + (Number(r.netPayable) - Number(r.paidAmount)),
      0
    );

    const total = accountsPayable + loansAndCredit + payrollPayable;

    res.json({
      accountsPayable: Math.round(accountsPayable * 100) / 100,
      loansAndCredit: Math.round(loansAndCredit * 100) / 100,
      payrollPayable: Math.round(payrollPayable * 100) / 100,
      total: Math.round(total * 100) / 100,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[Liability] Summary failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/liabilities — list ───────────────────────────────────────────────
router.get("/", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { status, liabilityType } = req.query;

    const where: any = { restaurantId };
    if (status) where.status = status;
    if (liabilityType) where.liabilityType = liabilityType;

    const liabilities = await prisma.liability.findMany({
      where,
      include: {
        ledgerCategory: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(liabilities.map(serializeLiability));
  } catch (error: any) {
    logger.error({ err: error }, "[Liability] GET list failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/liabilities/:id — detail with payment history ────────────────────
router.get("/:id", requireRole('ADMIN', 'OWNER', 'MANAGER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const liability = await prisma.liability.findFirst({
      where: { id, restaurantId },
      include: {
        ledgerCategory: { select: { id: true, name: true } },
        payments: { orderBy: { paymentDate: "desc" } },
        sourceOpeningBalanceLine: { select: { id: true, name: true } },
      },
    });

    if (!liability) {
      return res.status(404).json({ error: "Liability not found" });
    }

    res.json(serializeLiability(liability));
  } catch (error: any) {
    logger.error({ err: error }, "[Liability] GET detail failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/liabilities — manual creation ───────────────────────────────────
router.post("/", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const {
      name, liabilityType, ledgerCategoryId, principalAmount,
      interestRate, startDate, lender, notes,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!liabilityType) {
      return res.status(400).json({ error: "liabilityType is required" });
    }
    if (!startDate) {
      return res.status(400).json({ error: "startDate is required" });
    }
    if (principalAmount === undefined || parseFloat(principalAmount) <= 0) {
      return res.status(400).json({ error: "principalAmount must be a positive number" });
    }

    const principal = new Prisma.Decimal(principalAmount);
    const liability = await prisma.liability.create({
      data: {
        restaurantId,
        name: name.trim(),
        liabilityType,
        ledgerCategoryId: ledgerCategoryId || null,
        principalAmount: principal,
        currentBalance: principal,
        interestRate: interestRate ? new Prisma.Decimal(interestRate) : null,
        startDate,
        lender: lender || null,
        notes: notes || null,
        status: "ACTIVE",
        sourceType: "MANUAL",
        createdById: userId,
      },
    });

    await writeAuditLog(restaurantId, userId, "LIABILITY_CREATED", "Liability", liability.id, {
      name: liability.name,
      amount: principal.toString(),
      type: liabilityType,
    });

    res.json(serializeLiability(liability));
  } catch (error: any) {
    logger.error({ err: error }, "[Liability] POST failed");
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /api/liabilities/:id — edit ─────────────────────────────────────────
router.patch("/:id", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const {
      name, liabilityType, ledgerCategoryId, interestRate,
      lender, notes, principalAmount,
    } = req.body;

    const existing = await prisma.liability.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) {
      return res.status(404).json({ error: "Liability not found" });
    }

    // Check if any payments exist
    const paymentCount = await prisma.liabilityPayment.count({
      where: { liabilityId: id },
    });

    if (paymentCount > 0 && principalAmount !== undefined &&
        Number(principalAmount) !== Number(existing.principalAmount)) {
      return res.status(400).json({
        error: "Cannot change principalAmount after payments exist. Close and recreate instead.",
      });
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (liabilityType !== undefined) updateData.liabilityType = liabilityType;
    if (ledgerCategoryId !== undefined) updateData.ledgerCategoryId = ledgerCategoryId || null;
    if (interestRate !== undefined) updateData.interestRate = interestRate ? new Prisma.Decimal(interestRate) : null;
    if (lender !== undefined) updateData.lender = lender || null;
    if (notes !== undefined) updateData.notes = notes || null;
    if (principalAmount !== undefined && paymentCount === 0) {
      const newPrincipal = new Prisma.Decimal(principalAmount);
      updateData.principalAmount = newPrincipal;
      updateData.currentBalance = newPrincipal;
    }

    const updated = await prisma.liability.update({
      where: { id },
      data: updateData,
    });

    await writeAuditLog(restaurantId, userId, "LIABILITY_UPDATED", "Liability", id, {
      before: {
        name: existing.name,
        liabilityType: existing.liabilityType,
        principalAmount: existing.principalAmount.toString(),
      },
      after: updateData,
    });

    res.json(serializeLiability(updated));
  } catch (error: any) {
    logger.error({ err: error }, "[Liability] PATCH failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/liabilities/:id/payments — record a payment ─────────────────────
router.post("/:id/payments", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const { amount, paymentDate, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    const liability = await prisma.liability.findFirst({
      where: { id, restaurantId },
    });
    if (!liability) {
      return res.status(404).json({ error: "Liability not found" });
    }
    if (liability.status !== "ACTIVE") {
      return res.status(400).json({ error: "Liability is not active" });
    }

    const paymentAmt = Number(amount);
    const currentBal = Number(liability.currentBalance);

    if (paymentAmt > currentBal) {
      return res.status(400).json({
        error: `Payment (${paymentAmt.toFixed(2)}) exceeds current balance (${currentBal.toFixed(2)})`,
      });
    }

    const newBalance = currentBal - paymentAmt;
    const isClosed = newBalance <= 0;

    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.liabilityPayment.create({
        data: {
          liabilityId: id,
          amount: new Prisma.Decimal(paymentAmt),
          paymentDate: paymentDate || getKolkataDateString(),
          notes: notes || null,
          createdById: userId,
        },
      });

      const updated = await tx.liability.update({
        where: { id },
        data: {
          currentBalance: new Prisma.Decimal(Math.round(newBalance * 100) / 100),
          status: isClosed ? "CLOSED" : "ACTIVE",
        },
      });

      return { payment, updated };
    });

    await writeAuditLog(restaurantId, userId, "LIABILITY_PAYMENT_RECORDED", "Liability", id, {
      liabilityName: liability.name,
      amountPaid: paymentAmt,
      remainingBalance: Math.round(newBalance * 100) / 100,
    });

    res.json({
      payment: {
        ...result.payment,
        amount: Number(result.payment.amount),
      },
      liability: serializeLiability(result.updated),
    });
  } catch (error: any) {
    logger.error({ err: error }, "[Liability] Payment failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/liabilities/:id/close — manual close ────────────────────────────
router.post("/:id/close", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { id } = req.params;
    const { closeNotes } = req.body;

    const existing = await prisma.liability.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) {
      return res.status(404).json({ error: "Liability not found" });
    }
    if (existing.status === "CLOSED") {
      return res.status(400).json({ error: "Liability is already closed" });
    }

    const updated = await prisma.liability.update({
      where: { id },
      data: {
        status: "CLOSED",
        notes: closeNotes
          ? `${existing.notes || ""}\n[Closed: ${closeNotes}]`.trim()
          : existing.notes,
      },
    });

    await writeAuditLog(restaurantId, userId, "LIABILITY_SETTLED", "Liability", id, {
      name: existing.name,
      totalPaid: Number(existing.principalAmount) - Number(existing.currentBalance),
    });

    res.json(serializeLiability(updated));
  } catch (error: any) {
    logger.error({ err: error }, "[Liability] Close failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
