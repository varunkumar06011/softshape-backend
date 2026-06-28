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

// GET /api/attendance?date=YYYY-MM-DD
router.get("/", async (req: any, res) => {
  try {
    const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!restaurantId) return res.status(400).json({ error: "restaurantId required" });

    const date = (req.query.date as string) || getTodayDate();

    const attendance = await prisma.attendance.findMany({
      where: { restaurantId, date },
      include: { employee: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: "desc" },
    });

    res.json({ date, attendance });
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

    const record = await prisma.attendance.upsert({
      where: { employeeId_date: { employeeId, date } },
      update: { status, notes, updatedAt: new Date() },
      create: {
        restaurantId,
        employeeId,
        date,
        status,
        notes,
      },
      include: { employee: { select: { id: true, name: true } } },
    });

    res.json(record);
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
