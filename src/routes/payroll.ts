// ─────────────────────────────────────────────────────────────────────────────
// Payroll Routes — Employee management and payroll processing
// ─────────────────────────────────────────────────────────────────────────────
// Manages restaurant staff employees and their monthly payroll records.
//
// Features:
//   - Employee CRUD (create, update, soft-delete via isActive=false)
//   - Monthly payroll records with automatic net payable calculation
//   - Payment tracking (partial/full payments with status: PENDING/PARTIAL/PAID)
//   - Net payable = baseSalary - absentDeduction + otAmount - advanceAmount
//   - OT (overtime) calculated at 0.5x per-day salary per OT day
//
// Endpoints:
//   GET    /api/payroll/employees              — list active employees
//   POST   /api/payroll/employees              — create or update employee
//   DELETE /api/payroll/employees/:id          — soft-delete employee
//   GET    /api/payroll/records?monthYear=     — list payroll records for a month
//   POST   /api/payroll/records                — create or update payroll record
//   POST   /api/payroll/records/:id/payment    — add a payment to a payroll record
//
// All routes use authenticate + assertTenantScope + withTenantContext middleware.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";

const router = Router();

// Apply auth + tenant scoping to all payroll routes
router.use(authenticate, assertTenantScope, withTenantContext);

// Computes net payable salary based on base salary, absent days, OT days, and advance amount.
// Per-day salary = baseSalary / 30
// Absent deduction = perDaySalary * absentDays
// OT amount = perDaySalary * 0.5 * otDays (half-day pay per OT day)
// Net payable = baseSalary - absentDeduction + otAmount - advanceAmount
// All amounts rounded to 2 decimal places.
export function computeNetPayable(baseSalary: number, absentDays: number, otDays: number, advanceAmount: number) {
  const perDaySalary = baseSalary / 30;
  const absentDeduction = perDaySalary * absentDays;
  const otAmount = perDaySalary * 0.5 * otDays;
  const netPayable = baseSalary - absentDeduction + otAmount - advanceAmount;
  return {
    perDaySalary: Math.round(perDaySalary * 100) / 100,
    absentDeduction: Math.round(absentDeduction * 100) / 100,
    otAmount: Math.round(otAmount * 100) / 100,
    netPayable: Math.round(netPayable * 100) / 100,
  };
}

// Determines payment status based on paid amount vs net payable.
// PAID if fully paid, PARTIAL if partially paid, PENDING if nothing paid.
function getStatus(paidAmount: number, netPayable: number): string {
  if (paidAmount >= netPayable) return "PAID";
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

    const { id, name, age, role, baseSalary, idempotencyKey } = req.body;

    if (!name || typeof baseSalary !== "number") {
      return res.status(400).json({ error: "name and baseSalary are required" });
    }

    if (id) {
      const updateResult = await prisma.employee.updateMany({
        where: { id, restaurantId },
        data: {
          name,
          age: age || null,
          role: role || null,
          baseSalary: new Prisma.Decimal(baseSalary),
        },
      });
      if (updateResult.count === 0) {
        return res.status(404).json({ error: "Employee not found" });
      }
      const updated = await prisma.employee.findFirst({
        where: { id, restaurantId },
      });
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

    // Fallback duplicate guard: same name within 5 seconds returns existing employee
    const fiveSecondsAgo = new Date(Date.now() - 5000);
    const existingByName = await prisma.employee.findFirst({
      where: {
        name,
        restaurantId,
        isActive: true,
        createdAt: { gte: fiveSecondsAgo },
      },
    });
    if (existingByName) {
      return res.json(existingByName);
    }

    const employee = await prisma.employee.create({
      data: {
        name,
        age: age || null,
        role: role || null,
        baseSalary: new Prisma.Decimal(baseSalary),
        restaurantId,
        idempotencyKey: idempotencyKey || null,
      },
    });
    res.status(201).json(employee);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/employees/:id", async (req: any, res) => {
  try {
    const { id } = req.params;
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const result = await prisma.employee.updateMany({
      where: { id, restaurantId },
      data: { isActive: false },
    });
    if (result.count === 0) {
      return res.status(404).json({ error: "Employee not found" });
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Payroll Records
// ==========================================

router.get("/records", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { monthYear } = req.query;

    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });
    if (!monthYear) return res.status(400).json({ error: "monthYear required (YYYY-MM)" });

    const records = await prisma.payrollRecord.findMany({
      where: { restaurantId, monthYear },
      include: { employee: true },
      orderBy: { employee: { name: "asc" } },
    });
    res.json(records);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/records", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    const { employeeId, monthYear, absentDays, otDays, advanceAmount, notes } = req.body;

    if (!restaurantId || !employeeId || !monthYear) {
      return res.status(400).json({ error: "restaurantId, employeeId, monthYear are required" });
    }

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return res.status(404).json({ error: "Employee not found" });
    if (employee.restaurantId !== restaurantId) {
      return res.status(403).json({ error: "Employee does not belong to this restaurant" });
    }

    const baseSalary = Number(employee.baseSalary);
    const absent = absentDays || 0;
    const ot = otDays || 0;
    const advance = advanceAmount || 0;

    const { netPayable, otAmount } = computeNetPayable(baseSalary, absent, ot, advance);

    // Check if record already exists
    const existing = await prisma.payrollRecord.findUnique({
      where: { employeeId_monthYear: { employeeId, monthYear } },
    });

    if (existing) {
      const paidAmount = Number(existing.paidAmount);
      const updateResult = await prisma.payrollRecord.updateMany({
        where: { id: existing.id, restaurantId },
        data: {
          baseSalary: new Prisma.Decimal(baseSalary),
          absentDays: absent,
          otDays: ot,
          otAmount: new Prisma.Decimal(otAmount),
          advanceAmount: new Prisma.Decimal(advance),
          netPayable: new Prisma.Decimal(netPayable),
          status: getStatus(paidAmount, netPayable),
          notes: notes || existing.notes,
        },
      });
      if (updateResult.count === 0) {
        return res.status(404).json({ error: "Payroll record not found" });
      }
      const updated = await prisma.payrollRecord.findFirst({
        where: { id: existing.id, restaurantId },
        include: { employee: true },
      });
      return res.json(updated);
    }

    const record = await prisma.payrollRecord.create({
      data: {
        restaurantId,
        employeeId,
        monthYear,
        baseSalary: new Prisma.Decimal(baseSalary),
        absentDays: absent,
        otDays: ot,
        otAmount: new Prisma.Decimal(otAmount),
        advanceAmount: new Prisma.Decimal(advance),
        netPayable: new Prisma.Decimal(netPayable),
        status: "PENDING",
        notes: notes || null,
      },
      include: { employee: true },
    });
    res.json(record);
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

    const record = await prisma.payrollRecord.findFirst({
      where: { id, restaurantId: req.user!.activeRestaurantId ?? req.user!.restaurantId },
    });
    if (!record) return res.status(404).json({ error: "Payroll record not found" });

    const newPaidAmount = Number(record.paidAmount) + amount;
    const netPayable = Number(record.netPayable);

    const updateResult = await prisma.payrollRecord.updateMany({
      where: { id, restaurantId: req.user!.activeRestaurantId ?? req.user!.restaurantId },
      data: {
        paidAmount: new Prisma.Decimal(newPaidAmount),
        status: getStatus(newPaidAmount, netPayable),
      },
    });
    if (updateResult.count === 0) {
      return res.status(404).json({ error: "Payroll record not found" });
    }

    const updated = await prisma.payrollRecord.findFirst({
      where: { id, restaurantId: req.user!.activeRestaurantId ?? req.user!.restaurantId },
      include: { employee: true },
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
