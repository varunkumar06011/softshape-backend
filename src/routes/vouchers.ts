// ─────────────────────────────────────────────────────────────────────────────
// Voucher Routes — Cash payment vouchers for staff / maintenance / other
// ─────────────────────────────────────────────────────────────────────────────
// Manages cash payment vouchers with sequential numbering, payroll integration,
// print dispatch, and verify/void lifecycle.
//
// Endpoints:
//   GET    /api/vouchers/paid-to-options     — employees + maintenance + other
//   GET    /api/vouchers/approver-options     — users with canApproveVoucher permission
//   GET    /api/vouchers/narration-suggestions — recent unique narrations
//   POST   /api/vouchers                      — create voucher (with payroll update)
//   GET    /api/vouchers                      — list vouchers with filters
//   GET    /api/vouchers/today-summary        — today's count + total amount
//   POST   /api/vouchers/:id/verify           — mark voucher as verified
//   POST   /api/vouchers/:id/void             — void voucher (with payroll reversal)
//   POST   /api/vouchers/:id/print            — dispatch voucher print job
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { Prisma } from "@prisma/client";
import crypto from "crypto";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { getKolkataDateString } from "../utils/date";
import { buildVoucher } from "../utils/escpos";
import { getIo } from "../socket";
import { bufferPrintJob } from "../lib/printQueue";
import { acquireLock, releaseLock } from "../lib/redisLock";
import logger from "../lib/logger";
import { computeNetPayable } from "./payroll";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

const VOUCHER_LOCK_KEY = (key: string) => `voucher_lock:${key}`;
const VOUCHER_LOCK_TTL = 5;

function getMonthYearFromDate(dateStr: string): string {
  const parts = dateStr.split("-");
  return `${parts[0]}-${parts[1]}`;
}

// ── GET /api/vouchers/paid-to-options ─────────────────────────────────────────
router.get("/paid-to-options", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    // Query the User table (same source as Admin staff list) so cashiers see actual staff names
    const users = await prisma.user.findMany({
      where: {
        outletId: restaurantId,
        isActive: true,
        role: { in: ["CAPTAIN", "CASHIER"] },
      },
      select: { id: true, name: true, role: true, employee: { select: { id: true } } },
      orderBy: { name: "asc" },
    });

    res.json({
      staff: users.map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        employeeId: u.employee?.id || null,
      })),
    });
  } catch (error: any) {
    logger.error({ err: error }, "[Vouchers] paid-to-options failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/vouchers/approver-options ─────────────────────────────────────────
router.get("/approver-options", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    // User model uses outletId (not restaurantId) — matches auth.ts /staff endpoint pattern
    const users = await prisma.user.findMany({
      where: {
        outletId: restaurantId,
        isActive: true,
        role: { in: ["OWNER", "ADMIN"] },
      },
      select: { id: true, name: true, role: true, permissions: true },
    });

    const approvers = users.filter((u) => {
      if (u.role === "OWNER" || u.role === "ADMIN") return true;
      try {
        const perms = typeof u.permissions === "string" ? JSON.parse(u.permissions) : u.permissions;
        return perms?.canApproveVoucher === true;
      } catch {
        return false;
      }
    });

    res.json(approvers.map((u) => ({ id: u.id, name: u.name, role: u.role })));
  } catch (error: any) {
    logger.error({ err: error }, "[Vouchers] approver-options failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/vouchers/narration-suggestions ────────────────────────────────────
router.get("/narration-suggestions", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    const vouchers = await prisma.voucher.findMany({
      where: { restaurantId, narration: { not: null } },
      distinct: ["narration"],
      select: { narration: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    res.json(vouchers.map((v) => v.narration).filter(Boolean));
  } catch (error: any) {
    logger.error({ err: error }, "[Vouchers] narration-suggestions failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/vouchers ─────────────────────────────────────────────────────────
router.post("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const { paidToType, paidToName, employeeId, amount, narration, approvedById, idempotencyKey, voucherDate: inputDate } = req.body;

    if (!paidToType || !["STAFF", "MAINTENANCE", "OTHER"].includes(paidToType)) {
      return res.status(400).json({ error: "Invalid paidToType" });
    }
    if (!paidToName || !paidToName.trim()) {
      return res.status(400).json({ error: "paidToName is required" });
    }
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }
    if (paidToType === "STAFF" && !employeeId) {
      return res.status(400).json({ error: "employeeId is required when paidToType is STAFF" });
    }

    // Resolve the provided employeeId: it may be the Employee id or the User id.
    let resolvedEmployeeId: string | null = null;
    if (paidToType === "STAFF" && employeeId) {
      const employee = await prisma.employee.findFirst({
        where: { id: employeeId, restaurantId },
        select: { id: true },
      });
      if (employee) {
        resolvedEmployeeId = employee.id;
      } else {
        const user = await prisma.user.findFirst({
          where: { id: employeeId, outletId: restaurantId, isActive: true },
          select: { id: true, name: true, role: true, employee: { select: { id: true } } },
        });
        if (user) {
          // Prefer an employee already linked to this user, or an unlinked employee
          // with the same name. This prevents duplicate employee records and preserves
          // the baseSalary that was set in the payroll module.
          const existingEmployee = await prisma.employee.findFirst({
            where: {
              restaurantId,
              OR: [
                { userId: user.id },
                { name: { equals: user.name.trim(), mode: 'insensitive' }, userId: null },
              ],
            },
            orderBy: { userId: 'desc' }, // Linked employee first
            select: { id: true, userId: true },
          });
          if (existingEmployee) {
            if (existingEmployee.userId !== user.id) {
              await prisma.employee.update({
                where: { id: existingEmployee.id },
                data: { userId: user.id },
              });
            }
            resolvedEmployeeId = existingEmployee.id;
          } else {
            const newEmployee = await prisma.employee.create({
              data: {
                restaurantId,
                name: user.name,
                role: user.role,
                baseSalary: 0,
                isActive: true,
                userId: user.id,
              },
            });
            resolvedEmployeeId = newEmployee.id;
          }
        }
      }
      if (!resolvedEmployeeId) {
        return res.status(400).json({ error: "Invalid employeeId" });
      }
    }

    // Validate voucher date (defaults to today IST; reject future dates)
    const today = getKolkataDateString();
    const voucherDate = inputDate && typeof inputDate === "string" ? inputDate.trim() : today;
    if (voucherDate > today) {
      return res.status(400).json({ error: "Voucher date cannot be in the future" });
    }

    // Idempotency guard
    if (idempotencyKey) {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      const existing = await prisma.voucher.findFirst({
        where: {
          idempotencyKey,
          restaurantId,
          createdAt: { gte: oneMinuteAgo },
        },
      });
      if (existing) {
        return res.json(existing);
      }
    }

    const lockKey = `${restaurantId}-${idempotencyKey || paidToName}-${amount}`;
    const acquired = await acquireLock(VOUCHER_LOCK_KEY(lockKey), VOUCHER_LOCK_TTL);
    if (!acquired) {
      return res.status(429).json({ error: "Duplicate voucher request — please wait" });
    }

    try {
      const monthYear = getMonthYearFromDate(voucherDate);

      // Phase 1: Atomic counter + voucher creation only. This is the smallest
      // possible transaction to avoid timeouts under PgBouncer/Render pooling.
      let voucher = await prisma.$transaction(async (tx) => {
        const counter = await tx.dailyCounter.upsert({
          where: { restaurantId_counterDate: { restaurantId, counterDate: voucherDate } },
          update: { voucherCount: { increment: 1 } },
          create: { restaurantId, counterDate: voucherDate, voucherCount: 1 },
        });

        return tx.voucher.create({
          data: {
            restaurantId,
            voucherNo: counter.voucherCount,
            voucherDate,
            paidToType,
            paidToName: paidToName.trim(),
            employeeId: paidToType === "STAFF" ? resolvedEmployeeId : null,
            amount: new Prisma.Decimal(amount),
            narration: narration?.trim() || null,
            approvedById: approvedById || null,
            createdById: userId,
            idempotencyKey: idempotencyKey || null,
          },
        });
      });

      // Phase 2: Best-effort payroll update. If this fails, the voucher is still
      // safely saved and can be reconciled later.
      if (paidToType === "STAFF" && resolvedEmployeeId) {
        try {
          const payroll = await prisma.payrollRecord.findFirst({
            where: { employeeId: resolvedEmployeeId, restaurantId, monthYear },
          });

          if (payroll) {
            const newAdvance = Number(payroll.advanceAmount) + amount;
            const computed = computeNetPayable(
              Number(payroll.baseSalary),
              payroll.absentDays,
              payroll.otDays,
              newAdvance
            );
            await prisma.payrollRecord.update({
              where: { id: payroll.id },
              data: {
                advanceAmount: new Prisma.Decimal(newAdvance),
                otAmount: new Prisma.Decimal(computed.otAmount),
                netPayable: new Prisma.Decimal(computed.netPayable),
              },
            });
            await prisma.voucher.update({
              where: { id: voucher.id },
              data: { payrollRecordId: payroll.id },
            });
            (voucher as any).payrollRecordId = payroll.id;
          } else {
            const employee = await prisma.employee.findFirst({
              where: { id: resolvedEmployeeId, restaurantId },
            });
            if (employee) {
              const computed = computeNetPayable(Number(employee.baseSalary), 0, 0, amount);
              const newPayroll = await prisma.payrollRecord.create({
                data: {
                  restaurantId,
                  employeeId: resolvedEmployeeId,
                  monthYear,
                  baseSalary: employee.baseSalary,
                  advanceAmount: new Prisma.Decimal(amount),
                  otAmount: new Prisma.Decimal(computed.otAmount),
                  netPayable: new Prisma.Decimal(computed.netPayable),
                  status: "PENDING",
                },
              });
              await prisma.voucher.update({
                where: { id: voucher.id },
                data: { payrollRecordId: newPayroll.id },
              });
              (voucher as any).payrollRecordId = newPayroll.id;
            }
          }
        } catch (payrollErr: any) {
          logger.error({ err: payrollErr }, "[Vouchers] Payroll update failed after voucher created");
          // Do not fail the voucher request; payroll can be reconciled later.
        }
      }

      const result = await prisma.voucher.findFirst({
        where: { id: voucher.id },
        include: {
          employee: { select: { id: true, name: true, role: true } },
          approvedBy: { select: { id: true, name: true, role: true } },
          createdBy: { select: { id: true, name: true } },
        },
      });

      res.json(result);
    } finally {
      releaseLock(VOUCHER_LOCK_KEY(lockKey)).catch(() => {});
    }
  } catch (error: any) {
    logger.error({ err: error }, "[Vouchers] Create failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/vouchers ──────────────────────────────────────────────────────────
router.get("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { date, status, paidToType, employeeId, limit } = req.query;

    const where: any = { restaurantId };
    if (date) where.voucherDate = date;
    if (status) where.status = status;
    if (paidToType) where.paidToType = paidToType;
    if (employeeId) where.employeeId = employeeId;

    const vouchers = await prisma.voucher.findMany({
      where,
      include: {
        employee: { select: { id: true, name: true, role: true } },
        approvedBy: { select: { id: true, name: true, role: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: Number(limit) || 200,
    });

    res.json(vouchers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/vouchers/today-summary ─────────────────────────────────────────────
router.get("/today-summary", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const date = (req.query.date as string) || getKolkataDateString();

    const vouchers = await prisma.voucher.findMany({
      where: { restaurantId, voucherDate: date, status: { not: "VOIDED" } },
      select: { amount: true, status: true },
    });

    const totalAmount = vouchers.reduce((sum, v) => sum + Number(v.amount), 0);

    res.json({
      date,
      count: vouchers.length,
      totalAmount: Math.round(totalAmount * 100) / 100,
      unverifiedCount: vouchers.filter((v) => v.status === "UNVERIFIED").length,
      verifiedCount: vouchers.filter((v) => v.status === "VERIFIED").length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/vouchers/:id/verify ──────────────────────────────────────────────
router.post("/:id/verify", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const voucher = await prisma.voucher.findFirst({
      where: { id, restaurantId },
    });
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    if (voucher.status === "VOIDED") return res.status(400).json({ error: "Cannot verify a voided voucher" });
    if (voucher.status === "VERIFIED") return res.json(voucher);

    const updated = await prisma.voucher.update({
      where: { id },
      data: { status: "VERIFIED" },
      include: {
        employee: { select: { id: true, name: true, role: true } },
        approvedBy: { select: { id: true, name: true, role: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/vouchers/:id/void ────────────────────────────────────────────────
router.post("/:id/void", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const voucher = await prisma.voucher.findFirst({
      where: { id, restaurantId },
    });
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    if (voucher.status === "VOIDED") return res.status(400).json({ error: "Voucher already voided" });

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.voucher.update({
        where: { id },
        data: { status: "VOIDED" },
      });

      // Reverse payroll advance if linked
      if (voucher.payrollRecordId && voucher.paidToType === "STAFF") {
        const payroll = await tx.payrollRecord.findFirst({
          where: { id: voucher.payrollRecordId, restaurantId },
        });
        if (payroll) {
          const reversedAdvance = Math.max(0, Number(payroll.advanceAmount) - Number(voucher.amount));
          const computed = computeNetPayable(
            Number(payroll.baseSalary),
            payroll.absentDays,
            payroll.otDays,
            reversedAdvance
          );
          await tx.payrollRecord.update({
            where: { id: payroll.id },
            data: {
              advanceAmount: new Prisma.Decimal(reversedAdvance),
              otAmount: new Prisma.Decimal(computed.otAmount),
              netPayable: new Prisma.Decimal(computed.netPayable),
            },
          });
        }
      }

      return updated;
    });

    const updated = await prisma.voucher.findFirst({
      where: { id: result.id },
      include: {
        employee: { select: { id: true, name: true, role: true } },
        approvedBy: { select: { id: true, name: true, role: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });

    res.json(updated);
  } catch (error: any) {
    logger.error({ err: error }, "[Vouchers] Void failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/vouchers/:id/print ───────────────────────────────────────────────
router.post("/:id/print", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const voucher = await prisma.voucher.findFirst({
      where: { id, restaurantId },
      include: {
        employee: { select: { id: true, name: true, role: true } },
        approvedBy: { select: { id: true, name: true, role: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });

    // Use findUnique (not findFirst) to match Final Bill's pattern in print.ts
    const restaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: {
        name: true,
        receiptHeader: true,
        receiptSubHeader: true,
        address: true,
        phone: true,
        gstin: true,
      },
    });

    const escposData = buildVoucher({
      voucherNo: voucher.voucherNo,
      voucherDate: voucher.voucherDate,
      paidToType: voucher.paidToType,
      paidToName: voucher.paidToName,
      amount: Number(voucher.amount),
      narration: voucher.narration,
      approvedByName: voucher.approvedBy?.name || null,
      createdByName: voucher.createdBy?.name || null,
      status: voucher.status,
      restaurant: restaurant
        ? {
            name: restaurant.name,
            receiptHeader: restaurant.receiptHeader,
            receiptSubHeader: restaurant.receiptSubHeader,
            address: restaurant.address,
            phone: restaurant.phone,
            gstin: restaurant.gstin,
          }
        : undefined,
    });

    // Match Final Bill's payload structure: { type, data: { escposData, ... }, eventId }
    // The print agent (agentSocket.js) reads envelope.type and envelope.data.escposData
    const enriched = {
      type: "VOUCHER",
      data: {
        restaurantId,
        voucherId: voucher.id,
        voucherNo: voucher.voucherNo,
        escposData,
      },
      eventId: crypto.randomUUID(),
    };

    try {
      await bufferPrintJob(restaurantId, enriched);
    } catch {
      // non-fatal — emit anyway
    }
    getIo().to(`print:${restaurantId}`).emit("print_job", enriched);

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, "[Vouchers] Print failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
