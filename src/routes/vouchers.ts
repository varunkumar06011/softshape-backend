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
import { computePayroll, getStatus } from "./payroll";

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

    // Query Employee table (includes helpers/kitchen/cleaning staff without login accounts)
    const employees = await prisma.employee.findMany({
      where: { restaurantId, isActive: true },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    });

    // Query User table (login accounts — exclude OWNER/ADMIN)
    const users = await prisma.user.findMany({
      where: {
        outletId: restaurantId,
        isActive: true,
        role: { notIn: ["OWNER", "ADMIN"] },
      },
      select: { id: true, name: true, role: true, employee: { select: { id: true } } },
      orderBy: { name: "asc" },
    });

    // Merge and de-duplicate by name (case-insensitive)
    const mergedMap = new Map<string, { id: string; name: string; role: string | null; employeeId: string | null }>();

    // Add Employee records first
    for (const emp of employees) {
      const key = emp.name.toLowerCase().trim();
      if (!mergedMap.has(key)) {
        mergedMap.set(key, {
          id: emp.id,
          name: emp.name,
          role: emp.role || null,
          employeeId: emp.id,
        });
      }
    }

    // Merge User records — role from User.role takes priority if a match exists
    for (const u of users) {
      const key = u.name.toLowerCase().trim();
      const existing = mergedMap.get(key);
      if (existing) {
        // User exists for this name — User.role wins
        existing.role = u.role || existing.role;
        // Keep Employee ID for payroll reconciliation if available
        if (u.employee?.id && !existing.employeeId) {
          existing.employeeId = u.employee.id;
        }
      } else {
        mergedMap.set(key, {
          id: u.id,
          name: u.name,
          role: u.role,
          employeeId: u.employee?.id || null,
        });
      }
    }

    // Sort by name
    const staff = Array.from(mergedMap.values()).sort((a, b) => a.name.localeCompare(b.name));

    res.json({ staff });
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

    const suggestions = await prisma.voucher.groupBy({
      by: ["narration"],
      where: { restaurantId, narration: { not: null } },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      take: 20,
    });

    res.json(suggestions.map((s) => s.narration).filter(Boolean));
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
    const { paidToType, paidToName, employeeId, amount, narration, approvedById, approvedByName, idempotencyKey, voucherDate: inputDate, category } = req.body;

    const VALID_NON_STAFF_CATEGORIES = ["MISCELLANEOUS", "MAINTENANCE", "KITCHEN", "ENTERTAINMENT", "OTHER"];

    if (!paidToType || !["STAFF", "OTHER"].includes(paidToType)) {
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
    if (paidToType === "OTHER" && !VALID_NON_STAFF_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "category is required for non-staff vouchers" });
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
        // Use a permanent sentinel date so voucher numbers never reset daily.
        // reset_day.sql only deletes DailyCounter rows where counterDate = target_date,
        // so 'global' is never touched by the day-reset procedure.
        const counter = await tx.dailyCounter.upsert({
          where: { restaurantId_counterDate: { restaurantId, counterDate: 'global' } },
          update: { voucherCount: { increment: 1 } },
          create: { restaurantId, counterDate: 'global', voucherCount: 1 },
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
            approvedByName: approvedByName?.trim() || null,
            category: paidToType === "STAFF" ? null : category,
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
            await prisma.$transaction(async (tx) => {
              const current = await tx.payrollRecord.findUnique({ where: { id: payroll.id } });
              if (!current) return;

              const newAdvance = Number(current.advanceAmount) + amount;
              const totalAdvance = newAdvance + Number(current.manualAdvanceAmount || 0);
              const computed = computePayroll(
                Number(current.baseSalary),
                current.presentDays,
                current.otDays,
                totalAdvance
              );

              await tx.payrollRecord.update({
                where: { id: current.id },
                data: {
                  advanceAmount: new Prisma.Decimal(newAdvance),
                  netPayable: new Prisma.Decimal(computed.finalSalary),
                  status: getStatus(Number(current.paidAmount), computed.finalSalary),
                },
              });
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
              const computed = computePayroll(Number(employee.baseSalary), 0, 0, amount);
              const [year, month] = monthYear.split("-").map(Number);
              const lastDay = new Date(year, month, 0).getDate();
              const newPayroll = await prisma.payrollRecord.create({
                data: {
                  restaurantId,
                  employeeId: resolvedEmployeeId,
                  monthYear,
                  baseSalary: employee.baseSalary,
                  presentDays: 0,
                  absentDays: 0,
                  otDays: 0,
                  otAmount: new Prisma.Decimal(0),
                  advanceAmount: new Prisma.Decimal(amount),
                  manualAdvanceAmount: new Prisma.Decimal(0),
                  netPayable: new Prisma.Decimal(computed.finalSalary),
                  paidAmount: new Prisma.Decimal(0),
                  periodStart: `${monthYear}-01`,
                  periodEnd: `${monthYear}-${String(lastDay).padStart(2, "0")}`,
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
    const { date, startDate, endDate, status, paidToType, category, employeeId, limit } = req.query;

    const where: any = { restaurantId };
    if (date) {
      where.voucherDate = date;
    } else if (startDate || endDate) {
      where.voucherDate = {};
      if (startDate) where.voucherDate.gte = startDate;
      if (endDate) where.voucherDate.lte = endDate;
    }
    if (status) where.status = status;
    if (paidToType) where.paidToType = paidToType;
    if (category) where.category = category;
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

    const [agg, byStatus, byCategory, byPaidTo] = await Promise.all([
      prisma.voucher.aggregate({
        where: { restaurantId, voucherDate: date, status: { not: "VOIDED" } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.voucher.groupBy({
        by: ["status"],
        where: { restaurantId, voucherDate: date, status: { not: "VOIDED" } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.voucher.groupBy({
        by: ["category"],
        where: { restaurantId, voucherDate: date, status: { not: "VOIDED" }, paidToType: "OTHER" },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prisma.voucher.groupBy({
        by: ["paidToName"],
        where: { restaurantId, voucherDate: date, status: { not: "VOIDED" }, paidToType: "STAFF" },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      byStatus.map((s) => [s.status, s._count._all])
    );
    const statusAmounts = Object.fromEntries(
      byStatus.map((s) => [s.status, Number(s._sum.amount || 0)])
    );

    const categoryBreakdown = byCategory
      .filter((c) => c.category)
      .map((c) => ({
        category: c.category,
        count: c._count._all,
        totalAmount: Number(c._sum.amount || 0),
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount);

    const staffBreakdown = byPaidTo
      .filter((s) => s.paidToName)
      .map((s) => ({
        name: s.paidToName,
        count: s._count._all,
        totalAmount: Number(s._sum.amount || 0),
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount);

    res.json({
      date,
      count: agg._count._all,
      totalAmount: Math.round(Number(agg._sum.amount || 0) * 100) / 100,
      unverifiedCount: statusCounts.UNVERIFIED || 0,
      verifiedCount: statusCounts.VERIFIED || 0,
      unverifiedAmount: statusAmounts.UNVERIFIED || 0,
      verifiedAmount: statusAmounts.VERIFIED || 0,
      categoryBreakdown,
      staffBreakdown,
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
          const totalAdvance = reversedAdvance + Number(payroll.manualAdvanceAmount || 0);
          const computed = computePayroll(
            Number(payroll.baseSalary),
            payroll.presentDays,
            payroll.otDays,
            totalAdvance
          );
          await tx.payrollRecord.update({
            where: { id: payroll.id },
            data: {
              advanceAmount: new Prisma.Decimal(reversedAdvance),
              netPayable: new Prisma.Decimal(computed.finalSalary),
              status: getStatus(Number(payroll.paidAmount), computed.finalSalary),
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
      approvedByName: (voucher as any).approvedByName || voucher.approvedBy?.name || null,
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
