// ─────────────────────────────────────────────────────────────────────────────
// Attendance Routes — Staff check-in/check-out and daily summary
// ─────────────────────────────────────────────────────────────────────────────
// Provides per-restaurant attendance tracking for dashboard "Staff Present".
//
// Endpoints:
//   GET  /api/attendance/today         — today's summary: { present, total, employees[] }
//   GET  /api/attendance?date=YYYY-MM-DD — list attendance records for a date
//   POST /api/attendance                — mark attendance for an employee (PRESENT | ABSENT | HALF_DAY | LEAVE)
//   POST /api/attendance/:id/check-in   — record check-in time
//   POST /api/attendance/:id/check-out  — record check-out time
//
// All routes use authenticate + assertTenantScope + withTenantContext middleware.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";

const router = Router();

router.use(authenticate, assertTenantScope, withTenantContext);

function getTodayDate() {
  return new Date().toISOString().split("T")[0];
}

// GET /api/attendance/today — summary for the dashboard card
router.get("/today", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const today = getTodayDate();

    const [employees, attendance] = await Promise.all([
      prisma.employee.findMany({
        where: { restaurantId, isActive: true },
        select: { id: true, name: true },
      }),
      prisma.attendance.findMany({
        where: { restaurantId, date: today },
        include: { employee: { select: { id: true, name: true } } },
      }),
    ]);

    const present = attendance.filter(a => a.status === "PRESENT" || a.status === "HALF_DAY").length;
    const total = employees.length;

    res.json({
      date: today,
      present,
      total,
      absent: total - present,
      attendance,
      employees,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/attendance?date=YYYY-MM-DD OR ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date, startDate, endDate } = req.query;

    const dateWhere: any = { restaurantId };
    if (date) {
      dateWhere.date = date;
    } else if (startDate || endDate) {
      dateWhere.date = {};
      if (startDate) dateWhere.date.gte = startDate;
      if (endDate) dateWhere.date.lte = endDate;
    } else {
      dateWhere.date = getTodayDate();
    }

    const attendance = await prisma.attendance.findMany({
      where: dateWhere,
      include: { employee: { select: { id: true, name: true, role: true } } },
      orderBy: { date: "asc" },
    });

    res.json({ date: date || startDate || endDate || getTodayDate(), attendance });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/attendance — mark attendance for an employee
router.post("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { employeeId, date, status = "PRESENT", notes } = req.body;
    if (!employeeId) return res.status(400).json({ error: "employeeId required" });
    if (!date) return res.status(400).json({ error: "date required" });

    const validStatuses = ["PRESENT", "ABSENT", "HALF_DAY", "LEAVE"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${validStatuses.join(", ")}` });
    }

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, restaurantId },
    });
    if (!employee) return res.status(404).json({ error: "employee not found" });

    const existingRecord = await prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId, date } },
    });

    const now = new Date();
    const checkInTime = status === "PRESENT" ? now : undefined;

    const record = await prisma.attendance.upsert({
      where: { employeeId_date: { employeeId, date } },
      update: {
        status,
        notes,
        updatedAt: now,
        // Auto-check-in only if the record didn't already have one and status is PRESENT
        checkInTime: status === "PRESENT" && !existingRecord?.checkInTime ? now : undefined,
      },
      create: {
        restaurantId,
        employeeId,
        date,
        status,
        notes,
        checkInTime,
      },
      include: { employee: { select: { id: true, name: true } } },
    });

    res.json(record);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/attendance/bulk — mark attendance for multiple employees at once
router.post("/bulk", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { date, items = [] } = req.body;
    if (!date) return res.status(400).json({ error: "date required" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items must be a non-empty array" });
    }

    const validStatuses = ["PRESENT", "ABSENT", "HALF_DAY", "LEAVE"];
    const employeeIds = items.map((i: any) => i.employeeId).filter(Boolean);

    // Validate all employees belong to the tenant
    const employees = await prisma.employee.findMany({
      where: { id: { in: employeeIds }, restaurantId },
      select: { id: true },
    });
    const validEmployeeIds = new Set(employees.map(e => e.id));

    const now = new Date();

    const results = await Promise.allSettled(
      items.map(async (item: any) => {
        const { employeeId, status = "PRESENT", notes } = item;
        if (!employeeId || !validEmployeeIds.has(employeeId)) {
          throw new Error(`invalid or unknown employeeId: ${employeeId}`);
        }
        if (!validStatuses.includes(status)) {
          throw new Error(`invalid status: ${status}`);
        }

        const existingRecord = await prisma.attendance.findUnique({
          where: { employeeId_date: { employeeId, date } },
        });
        const checkInTime = status === "PRESENT" ? now : undefined;

        return prisma.attendance.upsert({
          where: { employeeId_date: { employeeId, date } },
          update: {
            status,
            notes,
            updatedAt: now,
            checkInTime: status === "PRESENT" && !existingRecord?.checkInTime ? now : undefined,
          },
          create: {
            restaurantId,
            employeeId,
            date,
            status,
            notes,
            checkInTime,
          },
          include: { employee: { select: { id: true, name: true } } },
        });
      })
    );

    const succeeded = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
      .map(r => r.value);
    const failed = results
      .map((r, idx) => ({ result: r, item: items[idx] }))
      .filter(({ result }) => result.status === "rejected")
      .map(({ result, item }) => ({ employeeId: item.employeeId, reason: String((result as PromiseRejectedResult).reason) }));

    res.json({
      date,
      processed: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
      records: succeeded,
      errors: failed,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/attendance/:id/check-in
router.post("/:id/check-in", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { id } = req.params;
    const record = await prisma.attendance.findFirst({
      where: { id, restaurantId },
    });
    if (!record) return res.status(404).json({ error: "attendance record not found" });

    const updated = await prisma.attendance.update({
      where: { id },
      data: {
        checkInTime: new Date(),
        status: record.status === "ABSENT" ? "PRESENT" : record.status,
      },
      include: { employee: { select: { id: true, name: true } } },
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/attendance/:id/check-out
router.post("/:id/check-out", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const { id } = req.params;
    const record = await prisma.attendance.findFirst({
      where: { id, restaurantId },
    });
    if (!record) return res.status(404).json({ error: "attendance record not found" });

    const updated = await prisma.attendance.update({
      where: { id },
      data: { checkOutTime: new Date() },
      include: { employee: { select: { id: true, name: true } } },
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
