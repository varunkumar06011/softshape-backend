// ─────────────────────────────────────────────────────────────────────────────
// Payroll Routes — Employee management and payroll processing
// ─────────────────────────────────────────────────────────────────────────────
// Manages restaurant staff employees and their monthly/payroll-period records.
//
// Features:
//   - Employee CRUD (create, update, hard-delete with cascade to payroll/attendance/staff)
//   - Payroll records keyed by monthYear, with optional custom periodStart/periodEnd
//   - Present days auto-counted from attendance or set manually
//   - Leave slab: 0/3/4 payable days based on present-day count
//   - Total advance = voucher-driven advanceAmount + manualAdvanceAmount
//   - Manual advance history with reason, date, and audit log
//   - Payment tracking (partial/full payments with status: PENDING/PARTIAL/PAID)
//
// Endpoints:
//   GET    /api/payroll/employees              — list active employees
//   POST   /api/payroll/employees              — create or update employee
//   DELETE /api/payroll/employees/:id          — hard-delete employee and cascade to payroll/attendance/staff
//   GET    /api/payroll/records                — list payroll records (monthYear or date range)
//   POST   /api/payroll/records                — create or update payroll record
//   POST   /api/payroll/records/:id/payment    — add a payment to a payroll record
//   POST   /api/payroll/records/:id/advance    — add a manual advance to a payroll record
//   GET    /api/payroll/records/:id/advance-history — manual advance history
//
// All routes use authenticate + assertTenantScope + withTenantContext middleware.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import prisma from "../lib/prisma";
import logger from "../lib/logger";
import { authenticate, invalidateUserActiveCache, requireRole } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { getKolkataDateString } from "../utils/date";
import { hashPassword } from "../lib/auth";
import {
  parseExcelPayroll,
  parsePhotoPayroll,
  resolveImportMatches,
  commitImport,
  type ProposedStaffRow,
} from "../services/payrollImport";

const router = Router();

// Apply auth + tenant scoping to all payroll routes
router.use(authenticate, assertTenantScope, withTenantContext);

// Computes payroll salary based on the new present-day / leave-slab formula.
// Per-day salary = baseSalary / 30
// leaveDays = 0 if presentDays < 20, 3 if 20 <= presentDays < 24, 4 if presentDays >= 24
// totalDays = presentDays + leaveDays + (otDays * 0.5)
// actualSalary = totalDays * perDaySalary
// finalSalary = actualSalary - totalAdvance
// Only final outputs are rounded to 2 decimals.
export function computePayroll(baseSalary: number, presentDays: number, otDays: number, totalAdvance: number) {
  const perDay = baseSalary / 30;
  let leaveDays = 0;
  if (presentDays >= 24) leaveDays = 4;
  else if (presentDays >= 20) leaveDays = 3;

  const totalDays = presentDays + leaveDays + otDays * 0.5;
  const actualSalary = totalDays * perDay;
  const finalSalary = actualSalary - totalAdvance;

  return {
    perDay,
    leaveDays,
    totalDays,
    actualSalary: round2(actualSalary),
    finalSalary: round2(finalSalary),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Counts present days from attendance records for a date range.
// PRESENT = 1, HALF_DAY = 0.5, ABSENT/LEAVE/other = 0.
export async function countPresentDays(
  employeeId: string,
  restaurantId: string,
  periodStart: string,
  periodEnd: string
): Promise<number> {
  const records = await prisma.attendance.findMany({
    where: {
      employeeId,
      restaurantId,
      date: { gte: periodStart, lte: periodEnd },
    },
  });

  return records.reduce((sum, r) => {
    if (r.status === "PRESENT") return sum + 1;
    if (r.status === "HALF_DAY") return sum + 0.5;
    return sum;
  }, 0);
}

function getCurrentMonthYear(): string {
  const d = new Date(getKolkataDateString());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(monthYear: string): number {
  const [year, month] = monthYear.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

// Recomputes the payroll record for an employee's month based on attendance.
// Creates the record if it doesn't exist so attendance marks always flow into payroll.
export async function syncPayrollFromAttendance(
  employeeId: string,
  restaurantId: string,
  date: string
) {
  const monthYear = date.slice(0, 7);

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
  });
  if (!employee || employee.restaurantId !== restaurantId) return;

  const existing = await prisma.payrollRecord.findUnique({
    where: { employeeId_monthYear: { employeeId, monthYear } },
  });

  const periodStart = existing?.periodStart || `${monthYear}-01`;
  const periodEnd = existing?.periodEnd || `${monthYear}-${String(daysInMonth(monthYear)).padStart(2, "0")}`;

  const baseSalary = Number(employee.baseSalary);
  const present = await countPresentDays(employeeId, restaurantId, periodStart, periodEnd);

  const advance = existing ? Number(existing.advanceAmount) : 0;
  const manualAdvance = existing ? Number(existing.manualAdvanceAmount) : 0;
  const totalAdvance = advance + manualAdvance;
  const ot = existing ? Number(existing.otDays) : 0;

  const computed = computePayroll(baseSalary, present, ot, totalAdvance);
  const paidAmount = existing ? Number(existing.paidAmount) : 0;
  const status = getStatus(paidAmount, computed.finalSalary);

  const data = {
    restaurantId,
    employeeId,
    monthYear,
    baseSalary: new Prisma.Decimal(baseSalary),
    presentDays: present,
    absentDays: 0,
    otDays: ot,
    otAmount: new Prisma.Decimal(0),
    advanceAmount: new Prisma.Decimal(advance),
    manualAdvanceAmount: new Prisma.Decimal(manualAdvance),
    netPayable: new Prisma.Decimal(computed.finalSalary),
    paidAmount: new Prisma.Decimal(paidAmount),
    periodStart,
    periodEnd,
    status,
    notes: existing?.notes || null,
  };

  if (existing) {
    await prisma.payrollRecord.update({
      where: { id: existing.id },
      data,
      include: { employee: true },
    });
  } else {
    await prisma.payrollRecord.create({
      data,
      include: { employee: true },
    });
  }
}

// Determines payment status based on paid amount vs final salary.
// PAID if fully paid, PARTIAL if partially paid, PENDING if nothing paid or
// finalSalary is non-positive (needs review).
export function getStatus(paidAmount: number, finalSalary: number): string {
  if (finalSalary <= 0) return "PENDING";
  if (paidAmount >= finalSalary) return "PAID";
  if (paidAmount > 0) return "PARTIAL";
  return "PENDING";
}

// ==========================================
// Employee CRUD
// ==========================================

router.get("/employees", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const employees = await prisma.employee.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(employees);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/employees", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { id, name, age, role, designation, workerCategory, baseSalary, idempotencyKey } = req.body;

    if (!name || typeof baseSalary !== "number") {
      return res.status(400).json({ error: "name and baseSalary are required" });
    }

    if (id) {
      const updateResult = await prisma.employee.updateMany({
        where: { id, restaurantId },
        data: {
          name,
          age: age !== undefined ? age || null : undefined,
          role: role !== undefined ? role || null : undefined,
          designation: designation !== undefined ? designation || null : undefined,
          workerCategory: workerCategory !== undefined ? workerCategory || null : undefined,
          baseSalary: new Prisma.Decimal(baseSalary),
        },
      });
      if (updateResult.count === 0) {
        return res.status(404).json({ error: "Employee not found" });
      }
      const updated = await prisma.employee.findFirst({
        where: { id, restaurantId },
      });
      // Sync linked staff user name if present
      if (updated?.userId) {
        await prisma.user.updateMany({
          where: { id: updated.userId, outletId: restaurantId },
          data: { name: name.trim() },
        }).catch(() => {});
      }
      return res.json(updated);
    }

    // Idempotency guard: same key within 60 seconds returns existing employee
    if (idempotencyKey) {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      const existing = await prisma.employee.findFirst({
        where: {
          idempotencyKey,
          restaurantId,
          isActive: true,
          createdAt: { gte: oneMinuteAgo },
        },
      });
      if (existing) {
        return res.json(existing);
      }
    }

    // Resolve or create a staff User record for this employee so names stay in sync.
    const trimmedName = name.trim();
    const staffRole = (role || '').toUpperCase() === 'CASHIER' ? 'CASHIER' : 'CAPTAIN';
    let userId: string | null = null;

    const existingUser = await prisma.user.findFirst({
      where: {
        outletId: restaurantId,
        name: { equals: trimmedName, mode: 'insensitive' },
        isActive: true,
      },
      select: { id: true },
    });

    if (existingUser) {
      userId = existingUser.id;
    } else {
      try {
        const pin = String(Math.floor(1000 + Math.random() * 9000));
        const newUser = await prisma.user.create({
          data: {
            name: trimmedName,
            role: staffRole,
            outletId: restaurantId,
            pin: await hashPassword(pin),
            isActive: true,
          },
          select: { id: true },
        });
        userId = newUser.id;
      } catch (err) {
        logger.warn({ err, name: trimmedName }, '[Payroll] Could not auto-create staff user');
      }
    }

    const employee = await prisma.employee.create({
      data: {
        name: trimmedName,
        age: age || null,
        role: role || null,
        designation: designation || null,
        workerCategory: workerCategory || null,
        baseSalary: new Prisma.Decimal(baseSalary),
        restaurantId,
        idempotencyKey: idempotencyKey || null,
        userId,
      },
    });

    // Seed a payroll record for the current month so the employee appears immediately.
    const monthYear = getCurrentMonthYear();
    await prisma.payrollRecord.upsert({
      where: { employeeId_monthYear: { employeeId: employee.id, monthYear } },
      update: {},
      create: {
        restaurantId,
        employeeId: employee.id,
        monthYear,
        baseSalary: new Prisma.Decimal(baseSalary),
        presentDays: 0,
        absentDays: 0,
        otDays: 0,
        advanceAmount: new Prisma.Decimal(0),
        manualAdvanceAmount: new Prisma.Decimal(0),
        otAmount: new Prisma.Decimal(0),
        netPayable: new Prisma.Decimal(0),
        paidAmount: new Prisma.Decimal(0),
        periodStart: `${monthYear}-01`,
        periodEnd: `${monthYear}-${String(daysInMonth(monthYear)).padStart(2, "0")}`,
        status: "PENDING",
      },
    });

    res.status(201).json(employee);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/employees/:id", requireRole("OWNER", "ADMIN") as any, async (req: any, res) => {
  try {
    const { id } = req.params;
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    const employee = await prisma.employee.findFirst({
      where: { id, restaurantId },
      include: { user: true },
    });
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    // Hard delete the employee. Prisma cascades to Attendance, PayrollRecord, and PayrollAdvanceHistory.
    await prisma.employee.deleteMany({
      where: { id, restaurantId },
    });

    // If the employee is linked to a staff user, deactivate that user and clean up related records.
    if (employee.userId) {
      if (employee.user?.role === "CAPTAIN") {
        await prisma.captainAssignment.deleteMany({
          where: { captainId: employee.userId, restaurantId },
        }).catch(() => {});
      }
      await prisma.outletAccess.deleteMany({
        where: { userId: employee.userId },
      }).catch(() => {});
      await prisma.user.update({
        where: { id: employee.userId },
        data: { isActive: false },
      }).catch(() => {});
      await invalidateUserActiveCache(employee.userId).catch(() => {});
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

function serializePayrollRecord(record: any) {
  const baseSalary = Number(record.baseSalary);
  const presentDays = record.presentDays || 0;
  const otDays = record.otDays || 0;
  const advanceAmount = Number(record.advanceAmount || 0);
  const manualAdvanceAmount = Number(record.manualAdvanceAmount || 0);
  const paidAmount = Number(record.paidAmount || 0);
  const totalAdvance = advanceAmount + manualAdvanceAmount;

  const computed = computePayroll(baseSalary, presentDays, otDays, totalAdvance);
  const balanceSalary = round2(computed.finalSalary - paidAmount);

  return {
    ...record,
    baseSalary,
    advanceAmount,
    manualAdvanceAmount,
    totalAdvance: round2(totalAdvance),
    paidAmount,
    presentDays,
    otDays,
    perDay: computed.perDay,
    leaveDays: computed.leaveDays,
    totalDays: computed.totalDays,
    actualSalary: computed.actualSalary,
    finalSalary: computed.finalSalary,
    netPayable: computed.finalSalary,
    balanceSalary,
    needsReview: presentDays === 0 && advanceAmount > 0,
  };
}

// ==========================================
// Payroll Records
// ==========================================

router.get("/records", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { monthYear, startDate, endDate } = req.query;

    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    let targetMonthYear = monthYear as string | undefined;
    let periodStart = startDate as string | undefined;
    let periodEnd = endDate as string | undefined;

    if (!targetMonthYear && (!periodStart || !periodEnd)) {
      return res.status(400).json({ error: "monthYear or startDate+endDate required" });
    }

    if (!targetMonthYear && periodStart) {
      targetMonthYear = periodStart.slice(0, 7);
    }

    const records = await prisma.payrollRecord.findMany({
      where: { restaurantId, monthYear: targetMonthYear },
      include: { employee: true },
      orderBy: { employee: { name: "asc" } },
    });

    res.json(records.map(serializePayrollRecord));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/records", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { employeeId, monthYear, startDate, endDate, presentDays, otDays, autoCount, notes } = req.body;

    if (!restaurantId || !employeeId || !monthYear) {
      return res.status(400).json({ error: "restaurantId, employeeId, monthYear are required" });
    }

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return res.status(404).json({ error: "Employee not found" });
    if (employee.restaurantId !== restaurantId) {
      return res.status(403).json({ error: "Employee does not belong to this restaurant" });
    }

    const baseSalary = Number(employee.baseSalary);
    const periodStart = startDate || `${monthYear}-01`;
    const periodEnd = endDate || `${monthYear}-${String(daysInMonth(monthYear)).padStart(2, "0")}`;

    let present = presentDays ?? 0;
    if (autoCount) {
      present = await countPresentDays(employeeId, restaurantId, periodStart, periodEnd);
    }

    const ot = otDays || 0;

    const existing = await prisma.payrollRecord.findUnique({
      where: { employeeId_monthYear: { employeeId, monthYear } },
    });

    const advance = existing ? Number(existing.advanceAmount) : 0;
    const manualAdvance = existing ? Number(existing.manualAdvanceAmount) : 0;
    const totalAdvance = advance + manualAdvance;

    const computed = computePayroll(baseSalary, present, ot, totalAdvance);
    const paidAmount = existing ? Number(existing.paidAmount) : 0;
    const status = getStatus(paidAmount, computed.finalSalary);

    const data = {
      restaurantId,
      employeeId,
      monthYear,
      baseSalary: new Prisma.Decimal(baseSalary),
      presentDays: present,
      absentDays: 0,
      otDays: ot,
      otAmount: new Prisma.Decimal(0),
      advanceAmount: new Prisma.Decimal(advance),
      manualAdvanceAmount: new Prisma.Decimal(manualAdvance),
      netPayable: new Prisma.Decimal(computed.finalSalary),
      paidAmount: new Prisma.Decimal(paidAmount),
      periodStart,
      periodEnd,
      status,
      notes: notes || existing?.notes || null,
    };

    let record;
    if (existing) {
      record = await prisma.payrollRecord.update({
        where: { id: existing.id },
        data,
        include: { employee: true },
      });
    } else {
      record = await prisma.payrollRecord.create({
        data,
        include: { employee: true },
      });
    }

    res.json(serializePayrollRecord(record));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/records/:id/payment", async (req: any, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;

    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const record = await prisma.payrollRecord.findFirst({
      where: { id, restaurantId },
    });
    if (!record) return res.status(404).json({ error: "Payroll record not found" });

    const newPaidAmount = Number(record.paidAmount) + amount;
    const finalSalary = Number(record.netPayable);

    const updateResult = await prisma.payrollRecord.updateMany({
      where: { id, restaurantId },
      data: {
        paidAmount: new Prisma.Decimal(newPaidAmount),
        status: getStatus(newPaidAmount, finalSalary),
      },
    });
    if (updateResult.count === 0) {
      return res.status(404).json({ error: "Payroll record not found" });
    }

    const updated = await prisma.payrollRecord.findFirst({
      where: { id, restaurantId },
      include: { employee: true },
    });

    res.json(serializePayrollRecord(updated));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/records/:id/advance", async (req: any, res) => {
  try {
    const { id } = req.params;
    const { amount, reason, date } = req.body;
    const userId = req.user!.userId;
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const userRole = req.user!.role;

    if (!["ADMIN", "OWNER"].includes(userRole)) {
      return res.status(403).json({ error: "Only admin or owner can add manual advances" });
    }

    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    const record = await prisma.payrollRecord.findFirst({
      where: { id, restaurantId },
    });
    if (!record) return res.status(404).json({ error: "Payroll record not found" });

    const advanceDate = date && typeof date === "string" ? date : getKolkataDateString();

    await prisma.$transaction(async (tx) => {
      const current = await tx.payrollRecord.findUnique({ where: { id } });
      if (!current) throw new Error("Payroll record not found");

      const newManualAdvance = Number(current.manualAdvanceAmount) + amount;
      const totalAdvance = Number(current.advanceAmount) + newManualAdvance;
      const computed = computePayroll(
        Number(current.baseSalary),
        current.presentDays,
        current.otDays,
        totalAdvance
      );

      await tx.payrollAdvanceHistory.create({
        data: {
          restaurantId,
          employeeId: current.employeeId,
          payrollRecordId: current.id,
          amount: new Prisma.Decimal(amount),
          reason: reason?.trim() || null,
          date: advanceDate,
          createdById: userId,
        },
      });

      await tx.payrollRecord.update({
        where: { id },
        data: {
          manualAdvanceAmount: new Prisma.Decimal(newManualAdvance),
          netPayable: new Prisma.Decimal(computed.finalSalary),
          status: getStatus(Number(current.paidAmount), computed.finalSalary),
        },
      });

      await tx.auditLog.create({
        data: {
          userId,
          restaurantId,
          action: "MANUAL_ADVANCE_CREATED",
          entityType: "PayrollAdvanceHistory",
          entityId: current.id,
          metadata: {
            amount,
            reason: reason?.trim() || null,
            employeeId: current.employeeId,
            payrollRecordId: current.id,
          },
        },
      });
    });

    const updated = await prisma.payrollRecord.findFirst({
      where: { id, restaurantId },
      include: { employee: true },
    });

    res.json(serializePayrollRecord(updated));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/records/:id/advance-history", async (req: any, res) => {
  try {
    const { id } = req.params;
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;

    const record = await prisma.payrollRecord.findFirst({
      where: { id, restaurantId },
      include: {
        expenditures: {
          where: { status: { not: "VOIDED" } },
          include: { createdBy: { select: { id: true, name: true } } },
        },
      },
    });
    if (!record) return res.status(404).json({ error: "Payroll record not found" });

    const manualHistory = await prisma.payrollAdvanceHistory.findMany({
      where: { payrollRecordId: id },
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: { date: "desc" },
    });

    const history = [
      ...record.expenditures.map((v) => ({
        id: v.id,
        type: "VOUCHER",
        amount: Number(v.amount),
        date: v.expenditureDate,
        reason: v.narration || `Voucher #${v.expenditureNo}`,
        createdBy: v.createdBy,
      })),
      ...manualHistory.map((h) => ({
        id: h.id,
        type: "MANUAL",
        amount: Number(h.amount),
        date: h.date,
        reason: h.reason,
        createdBy: h.createdBy,
      })),
    ].sort((a, b) => b.date.localeCompare(a.date));

    res.json(history);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Payroll Import
// ==========================================

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const importRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req: any) => req.ip || "unknown",
  message: { error: "Too many import attempts, please wait a minute" },
});

const isExcelFile = (mimetype: string, originalname: string) =>
  mimetype.includes("sheet") ||
  mimetype.includes("csv") ||
  mimetype.includes("excel") ||
  originalname.match(/\.(xlsx|xls|csv)$/i);

const isImageFile = (mimetype: string) => mimetype.startsWith("image/");

router.post(
  "/import/preview",
  importRateLimiter,
  importUpload.single("file"),
  async (req: any, res) => {
    try {
      const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
      if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const { mimetype, originalname, buffer } = req.file;
      let parsed: Awaited<ReturnType<typeof parseExcelPayroll>>;

      if (isExcelFile(mimetype, originalname)) {
        parsed = parseExcelPayroll(buffer);
      } else if (isImageFile(mimetype)) {
        parsed = await parsePhotoPayroll(buffer);
      } else {
        return res.status(400).json({ error: "Unsupported file type. Upload Excel, CSV, or an image." });
      }

      const { proposed, warnings } = await resolveImportMatches(parsed.rows, restaurantId);

      res.json({
        source: isExcelFile(mimetype, originalname) ? "excel" : "photo",
        parsedRows: parsed.rows,
        proposed,
        warnings: [...parsed.warnings, ...warnings],
        confidence: parsed.confidence,
      });
    } catch (error: any) {
      logger.error({ err: error }, "[Payroll] Preview failed");
      res.status(500).json({ error: error.message });
    }
  }
);

router.post(
  "/import/commit",
  importRateLimiter,
  async (req: any, res) => {
    try {
      const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
      const userId = req.user!.id;
      if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

      const { rows } = req.body;
      if (!Array.isArray(rows)) return res.status(400).json({ error: "rows array required" });

      const result = await commitImport(rows as ProposedStaffRow[], restaurantId, userId);
      res.json(result);
    } catch (error: any) {
      logger.error({ err: error }, "[Payroll] Commit failed");
      res.status(500).json({ error: error.message });
    }
  }
);

export default router;
