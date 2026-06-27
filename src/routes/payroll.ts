import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";

const router = Router();

router.use(authenticate, assertTenantScope, withTenantContext);

function computeNetPayable(baseSalary: number, absentDays: number, otDays: number, advanceAmount: number) {
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

    const { id, name, age, role, baseSalary } = req.body;

    if (!name || typeof baseSalary !== "number") {
      return res.status(400).json({ error: "name and baseSalary are required" });
    }

    if (id) {
      const updated = await prisma.employee.update({
        where: { id },
        data: {
          name,
          age: age || null,
          role: role || null,
          baseSalary: new Prisma.Decimal(baseSalary),
        },
      });
      return res.json(updated);
    }

    const employee = await prisma.employee.create({
      data: {
        name,
        age: age || null,
        role: role || null,
        baseSalary: new Prisma.Decimal(baseSalary),
        restaurantId,
      },
    });
    res.json(employee);
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
      const updated = await prisma.payrollRecord.update({
        where: { id: existing.id },
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

    const updated = await prisma.payrollRecord.update({
      where: { id },
      data: {
        paidAmount: new Prisma.Decimal(newPaidAmount),
        status: getStatus(newPaidAmount, netPayable),
      },
      include: { employee: true },
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
