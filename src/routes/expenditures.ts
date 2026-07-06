// ─────────────────────────────────────────────────────────────────────────────
// Expenditure Routes — Cash payment expenditures for staff / maintenance / other
// ─────────────────────────────────────────────────────────────────────────────
// Manages cash payment expenditures with sequential numbering, payroll integration,
// print dispatch, and verify/void lifecycle.
//
// Endpoints:
//   GET    /api/expenditures/paid-to-options     — employees + maintenance + other
//   GET    /api/expenditures/approver-options     — users with canApproveVoucher permission
//   GET    /api/expenditures/narration-suggestions — recent unique narrations
//   POST   /api/expenditures                      — create expenditure (with payroll update)
//   GET    /api/expenditures                      — list expenditures with filters
//   GET    /api/expenditures/today-summary        — today's count + total amount
//   POST   /api/expenditures/:id/verify           — mark expenditure as verified
//   POST   /api/expenditures/:id/void             — void expenditure (with payroll reversal)
//   POST   /api/expenditures/:id/print            — dispatch expenditure print job
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { Prisma } from "@prisma/client";
import crypto from "crypto";
import prisma from "../lib/prisma";
import { basePrisma } from "../lib/prisma";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { getKolkataDateString } from "../utils/date";
import { buildExpenditure } from "../utils/escpos";
import { getIo } from "../socket";
import { bufferPrintJob } from "../lib/printQueue";
import { acquireLock, releaseLock } from "../lib/redisLock";
import logger from "../lib/logger";
import { computePayroll, getStatus } from "./payroll";
import { resolveOutletFilter } from "./reports";
import { updateXReportExpenditureAmount } from "../services/xReportService";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

const EXPENDITURE_LOCK_KEY = (key: string) => `expenditure_lock:${key}`;
const EXPENDITURE_LOCK_TTL = 5;

function getMonthYearFromDate(dateStr: string): string {
  const parts = dateStr.split("-");
  return `${parts[0]}-${parts[1]}`;
}

function elapsed(label: string, startMs: number) {
  logger.info({ query: label, elapsedMs: Date.now() - startMs }, "[Expenditures] query timing");
}

// ── GET /api/expenditures/paid-to-options ─────────────────────────────────────────
router.get("/paid-to-options", async (req: any, res) => {
  const start = Date.now();
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    // Query Employee table (includes helpers/kitchen/cleaning staff without login accounts)
    const employees = await prisma.employee.findMany({
      where: { restaurantId, isActive: true },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    });

    // Query User table (login accounts — exclude OWNER/ADMIN).
    // Include users assigned to this outlet either directly or via OutletAccess.
    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        role: { notIn: ["OWNER", "ADMIN"] },
        OR: [
          { outletId: restaurantId },
          { outletAccess: { some: { outletId: restaurantId } } },
        ],
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

    elapsed("paid-to-options", start);
    res.json({ staff });
  } catch (error: any) {
    elapsed("paid-to-options-error", start);
    logger.error({ err: error }, "[Expenditures] paid-to-options failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/expenditures/approver-options ─────────────────────────────────────────
router.get("/approver-options", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    // User model uses outletId (not restaurantId) — matches auth.ts /staff endpoint pattern.
    // Include users who have OutletAccess to this outlet so approvers show up after switching outlets.
    // Any active user with canApproveVoucher permission, plus all OWNER/ADMIN users, qualifies.
    // Note: canApproveVoucher is the stored DB permission key — kept as-is for backward compatibility.
    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { outletId: restaurantId },
          { outletAccess: { some: { outletId: restaurantId } } },
        ],
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
    logger.error({ err: error }, "[Expenditures] approver-options failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/expenditures/narration-suggestions ────────────────────────────────────
router.get("/narration-suggestions", async (req: any, res) => {
  const start = Date.now();
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    const suggestions = await prisma.expenditure.groupBy({
      by: ["narration"],
      where: { restaurantId, narration: { not: null } },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      take: 20,
    });

    elapsed("narration-suggestions", start);
    res.json(suggestions.map((s) => s.narration).filter(Boolean));
  } catch (error: any) {
    elapsed("narration-suggestions-error", start);
    logger.error({ err: error }, "[Expenditures] narration-suggestions failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/expenditures ─────────────────────────────────────────────────────────
router.post("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userId = req.user!.userId;
    const {
      paidToType,
      paidToName,
      employeeId,
      amount,
      narration,
      approvedById,
      approvedByName,
      idempotencyKey,
      expenditureDate: inputExpenditureDate,
      category,
      createEmployeeIfMissing,
    } = req.body;

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
    if (paidToType === "OTHER" && category && !VALID_NON_STAFF_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }

    let resolvedEmployeeId: string | undefined = employeeId;

    // Auto-create Employee record if requested but not found
    if (paidToType === "STAFF" && createEmployeeIfMissing && !resolvedEmployeeId) {
      const existing = await prisma.employee.findFirst({
        where: { restaurantId, name: { equals: paidToName.trim(), mode: 'insensitive' } },
      });
      if (existing) {
        resolvedEmployeeId = existing.id;
      } else {
        const newEmployee = await prisma.employee.create({
          data: {
            restaurantId,
            name: paidToName.trim(),
            baseSalary: 0,
            isActive: true,
          },
        });
        resolvedEmployeeId = newEmployee.id;
      }
    }

    // Validate expenditure date (defaults to today IST; reject future dates)
    const today = getKolkataDateString();
    const chosenDateInput = (typeof inputExpenditureDate === 'string' && inputExpenditureDate) || undefined;
    const expenditureDate = chosenDateInput ? chosenDateInput.trim() : today;
    if (expenditureDate > today) {
      return res.status(400).json({ error: "Expenditure date cannot be in the future" });
    }

    // Idempotency guard
    if (idempotencyKey) {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      const existing = await prisma.expenditure.findFirst({
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
    const acquired = await acquireLock(EXPENDITURE_LOCK_KEY(lockKey), EXPENDITURE_LOCK_TTL);
    if (!acquired) {
      return res.status(429).json({ error: "Duplicate expenditure request — please wait" });
    }

    try {
      const monthYear = getMonthYearFromDate(expenditureDate);

      // Phase 1: Atomic counter + expenditure creation only. This is the smallest
      // possible transaction to avoid timeouts under PgBouncer/Render pooling.
      let expenditure = await prisma.$transaction(async (tx) => {
        // Use a permanent sentinel date so expenditure numbers never reset daily.
        // reset_day.sql only deletes DailyCounter rows where counterDate = target_date,
        // so 'global' is never touched by the day-reset procedure.
        const counter = await tx.dailyCounter.upsert({
          where: { restaurantId_counterDate: { restaurantId, counterDate: 'global' } },
          update: { expenditureCount: { increment: 1 } },
          create: { restaurantId, counterDate: 'global', expenditureCount: 1 },
        });

        return tx.expenditure.create({
          data: {
            restaurantId,
            expenditureNo: counter.expenditureCount,
            expenditureDate,
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

      // Phase 2: Best-effort payroll update. If this fails, the expenditure is still
      // safely saved and can be reconciled later.
      if (paidToType === "STAFF" && resolvedEmployeeId) {
        try {
          const payroll = await prisma.payrollRecord.findFirst({
            where: { employeeId: resolvedEmployeeId, restaurantId, monthYear },
          });

          if (payroll) {
            const newAdvance = Number(payroll.advanceAmount) + amount;
            const totalAdvance = newAdvance + Number(payroll.manualAdvanceAmount || 0);
            const computed = computePayroll(
              Number(payroll.baseSalary),
              payroll.presentDays,
              payroll.otDays,
              totalAdvance
            );

            await prisma.$transaction(async (tx) => {
              await tx.payrollRecord.update({
                where: { id: payroll.id },
                data: {
                  advanceAmount: new Prisma.Decimal(newAdvance),
                  netPayable: new Prisma.Decimal(computed.finalSalary),
                  status: getStatus(Number(payroll.paidAmount), computed.finalSalary),
                },
              });

              await prisma.expenditure.update({
                where: { id: expenditure.id },
                data: { payrollRecordId: payroll.id },
              });
            });
            (expenditure as any).payrollRecordId = payroll.id;
          } else {
            const employee = await prisma.employee.findFirst({
              where: { id: resolvedEmployeeId, restaurantId },
            });
            if (employee) {
              const computed = computePayroll(Number(employee.baseSalary), 0, 0, amount);
              const lastDay = new Date(
                parseInt(monthYear.split("-")[0]),
                parseInt(monthYear.split("-")[1]),
                0
              ).getDate();

              const newPayroll = await prisma.payrollRecord.create({
                data: {
                  restaurantId,
                  employeeId: resolvedEmployeeId,
                  monthYear,
                  baseSalary: new Prisma.Decimal(employee.baseSalary),
                  presentDays: 0,
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
              await prisma.expenditure.update({
                where: { id: expenditure.id },
                data: { payrollRecordId: newPayroll.id },
              });
              (expenditure as any).payrollRecordId = newPayroll.id;
            }
          }
        } catch (payrollErr: any) {
          logger.error({ err: payrollErr }, "[Expenditures] Payroll update failed after expenditure created");
          // Do not fail the expenditure request; payroll can be reconciled later.
        }
      }

      const result = await prisma.expenditure.findFirst({
        where: { id: expenditure.id },
        include: {
          employee: { select: { id: true, name: true, role: true } },
          approvedBy: { select: { id: true, name: true, role: true } },
          createdBy: { select: { id: true, name: true } },
        },
      });

      await updateXReportExpenditureAmount(restaurantId, expenditureDate);
      res.json(result);
    } finally {
      releaseLock(EXPENDITURE_LOCK_KEY(lockKey)).catch(() => {});
    }
  } catch (error: any) {
    logger.error({ err: error }, "[Expenditures] Create failed");
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/expenditures ──────────────────────────────────────────────────────────
router.get("/", async (req: any, res) => {
  const start = Date.now();
  try {
    const { date, startDate, endDate, status, paidToType, category, employeeId, limit } = req.query;

    // Allow cross-outlet filtering: outletId=all (default) returns all tenant outlets
    const tenantIds = await resolveOutletFilter(req);
    if (tenantIds.length === 0) return res.json([]);

    const where: any = { restaurantId: { in: tenantIds } };
    if (date) {
      where.expenditureDate = date;
    } else if (startDate || endDate) {
      where.expenditureDate = {};
      if (startDate) where.expenditureDate.gte = startDate;
      if (endDate) where.expenditureDate.lte = endDate;
    }
    if (status) where.status = status;
    if (paidToType) where.paidToType = paidToType;
    if (category) where.category = category;
    if (employeeId) where.employeeId = employeeId;

    // Use basePrisma here because the default prisma client is tenant-scoped and would
    // overwrite the restaurantId filter with the active outlet only.
    const expenditures = await basePrisma.expenditure.findMany({
      where,
      include: {
        employee: { select: { id: true, name: true, role: true } },
        approvedBy: { select: { id: true, name: true, role: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: Number(limit) || 200,
    });

    elapsed("list", start);
    res.json(expenditures);
  } catch (error: any) {
    elapsed("list-error", start);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/expenditures/today-summary ─────────────────────────────────────────────
router.get("/today-summary", async (req: any, res) => {
  const start = Date.now();
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const date = (req.query.date as string) || getKolkataDateString();

    // Single raw query is much faster than 4 separate Prisma groupBy/aggregate calls,
    // especially on large Voucher tables where each round-trip can be expensive.
    const rows = await basePrisma.$queryRaw`
      WITH filtered AS (
        SELECT "amount", "status", "category", "paidToName", "paidToType"
        FROM "Voucher"
        WHERE "restaurantId" = ${restaurantId}
          AND "voucherDate" = ${date}
          AND "status" <> 'VOIDED'
      ),
      summary AS (
        SELECT COALESCE(SUM("amount"), 0)::float AS total_amount, COUNT(*)::int AS total_count
        FROM filtered
      ),
      status_breakdown AS (
        SELECT "status" AS status, COUNT(*)::int AS count, COALESCE(SUM("amount"), 0)::float AS amount
        FROM filtered
        GROUP BY "status"
      ),
      category_breakdown AS (
        SELECT "category" AS category, COUNT(*)::int AS count, COALESCE(SUM("amount"), 0)::float AS amount
        FROM filtered
        WHERE "paidToType" = 'OTHER' AND "category" IS NOT NULL
        GROUP BY "category"
      ),
      staff_breakdown AS (
        SELECT "paidToName" AS name, COUNT(*)::int AS count, COALESCE(SUM("amount"), 0)::float AS amount
        FROM filtered
        WHERE "paidToType" = 'STAFF' AND "paidToName" IS NOT NULL
        GROUP BY "paidToName"
      )
      SELECT
        (SELECT total_amount FROM summary) AS total_amount,
        (SELECT total_count FROM summary) AS total_count,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('status', status, 'count', count, 'amount', amount)) FROM status_breakdown), '[]'::jsonb) AS by_status,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('category', category, 'count', count, 'amount', amount)) FROM category_breakdown), '[]'::jsonb) AS by_category,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('name', name, 'count', count, 'amount', amount)) FROM staff_breakdown), '[]'::jsonb) AS by_staff
    ` as any[];

    const row = rows[0] || {};
    const byStatus = Array.isArray(row.by_status) ? row.by_status : [];
    const byCategory = Array.isArray(row.by_category) ? row.by_category : [];
    const byStaff = Array.isArray(row.by_staff) ? row.by_staff : [];

    const statusCounts = Object.fromEntries(byStatus.map((s: any) => [s.status, s.count]));
    const statusAmounts = Object.fromEntries(byStatus.map((s: any) => [s.status, s.amount]));

    const categoryBreakdown = byCategory
      .map((c: any) => ({ category: c.category, count: c.count, totalAmount: c.amount }))
      .sort((a: any, b: any) => b.totalAmount - a.totalAmount);

    const staffBreakdown = byStaff
      .map((s: any) => ({ name: s.name, count: s.count, totalAmount: s.amount }))
      .sort((a: any, b: any) => b.totalAmount - a.totalAmount);

    elapsed("today-summary", start);
    res.json({
      date,
      count: row.total_count || 0,
      totalAmount: Math.round((row.total_amount || 0) * 100) / 100,
      unverifiedCount: statusCounts.UNVERIFIED || 0,
      verifiedCount: statusCounts.VERIFIED || 0,
      unverifiedAmount: statusAmounts.UNVERIFIED || 0,
      verifiedAmount: statusAmounts.VERIFIED || 0,
      categoryBreakdown,
      staffBreakdown,
    });
  } catch (error: any) {
    elapsed("today-summary-error", start);
    logger.error({ err: error }, "[Expenditures] today-summary failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/expenditures/:id/verify ──────────────────────────────────────────────
router.post("/:id/verify", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const expenditure = await prisma.expenditure.findFirst({
      where: { id, restaurantId },
    });
    if (!expenditure) return res.status(404).json({ error: "Expenditure not found" });
    if (expenditure.status === "VOIDED") return res.status(400).json({ error: "Cannot verify a voided expenditure" });
    if (expenditure.status === "VERIFIED") return res.json(expenditure);

    const updated = await prisma.expenditure.update({
      where: { id },
      data: { status: "VERIFIED" },
      include: {
        employee: { select: { id: true, name: true, role: true } },
        approvedBy: { select: { id: true, name: true, role: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });

    await updateXReportExpenditureAmount(restaurantId, updated.expenditureDate);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/expenditures/:id/void ────────────────────────────────────────────────
router.post("/:id/void", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const expenditure = await prisma.expenditure.findFirst({
      where: { id, restaurantId },
    });
    if (!expenditure) return res.status(404).json({ error: "Expenditure not found" });
    if (expenditure.status === "VOIDED") return res.status(400).json({ error: "Expenditure already voided" });

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.expenditure.update({
        where: { id },
        data: { status: "VOIDED" },
      });

      // Reverse payroll advance if linked
      if (expenditure.payrollRecordId && expenditure.paidToType === "STAFF") {
        const payroll = await tx.payrollRecord.findFirst({
          where: { id: expenditure.payrollRecordId, restaurantId },
        });
        if (payroll) {
          const reversedAdvance = Math.max(0, Number(payroll.advanceAmount) - Number(expenditure.amount));
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

    await updateXReportExpenditureAmount(restaurantId, expenditure.expenditureDate);

    const updated = await prisma.expenditure.findFirst({
      where: { id: result.id },
      include: {
        employee: { select: { id: true, name: true, role: true } },
        approvedBy: { select: { id: true, name: true, role: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });

    res.json(updated);
  } catch (error: any) {
    logger.error({ err: error }, "[Expenditures] Void failed");
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/expenditures/:id/print ───────────────────────────────────────────────
router.post("/:id/print", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { id } = req.params;

    const expenditure = await prisma.expenditure.findFirst({
      where: { id, restaurantId },
      include: {
        employee: { select: { id: true, name: true, role: true } },
        approvedBy: { select: { id: true, name: true, role: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!expenditure) return res.status(404).json({ error: "Expenditure not found" });

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

    const escposData = buildExpenditure({
      expenditureNo: expenditure.expenditureNo,
      expenditureDate: expenditure.expenditureDate,
      paidToType: expenditure.paidToType,
      paidToName: expenditure.paidToName,
      amount: Number(expenditure.amount),
      narration: expenditure.narration,
      approvedByName: expenditure.approvedByName || expenditure.approvedBy?.name || null,
      status: expenditure.status,
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
      type: "EXPENDITURE",
      data: {
        restaurantId,
        expenditureId: expenditure.id,
        expenditureNo: expenditure.expenditureNo,
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
    logger.error({ err: error }, "[Expenditures] Print failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
