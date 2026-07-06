// ─────────────────────────────────────────────────────────────────────────────
// Bar Tables Routes — Table management and order operations for bar-type restaurants
// ─────────────────────────────────────────────────────────────────────────────
// Manages tables and table-specific operations for bar/lounge restaurants.
// Includes table status updates, order creation, item additions, and real-time
// socket notifications for table state changes.
//
// Features:
//   - Table CRUD with status tracking (AVAILABLE, OCCUPIED, BILLING, etc.)
//   - Order creation and item addition to tables
//   - Real-time socket updates on table status changes
//   - Cache invalidation on mutations
//   - Active order tracking (only one active order per table)
//
// Endpoints:
//   GET    /api/bar/tables              — list all tables with sections and active orders
//   POST   /api/bar/tables              — create a new table
//   PATCH  /api/bar/tables/:id          — update table status/number/section
//   DELETE /api/bar/tables/:id          — delete a table
//   POST   /api/bar/tables/:id/order    — create a new order on a table
//   POST   /api/bar/tables/:id/items    — add items to a table's active order
// ─────────────────────────────────────────────────────────────────────────────

import { OrderStatus, Prisma, TableStatus } from "@prisma/client";
import logger from "../lib/logger";
import { Router } from "express";
import { randomUUID } from "crypto";
import { getIo } from "../socket";
import prisma from "../lib/prisma";
import { invalidateCache } from "../lib/cache";
import { authenticate } from "../middleware/auth";
import { bufferPrintJob } from "../lib/printQueue";
import { resolveTenantContext } from "../lib/tenantContext";
import { getGstBreakdownWithRate, getEffectiveGstRate } from "../utils/gst";
import { buildFinalBill } from "../utils/escpos";
import { getKolkataDateString } from "../utils/date";

// Helper: extract the effective restaurantId from the authenticated user
function getUserRestaurantId(req: any): string | undefined {
  return req.user?.activeRestaurantId ?? req.user?.restaurantId;
}
const router = Router();

// Valid table statuses from Prisma enum
const VALID_STATUSES = new Set<string>(Object.values(TableStatus));
// Order statuses that are considered "active" (table is occupied)
const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.BILLING_REQUESTED,
];

const tableInclude = {
  section: {
    select: { id: true, name: true, restaurantId: true },
  },
  orders: {
    where: { status: { in: ACTIVE_ORDER_STATUSES } },
    orderBy: { updatedAt: "desc" },
    take: 1,
    include: {
      items: {
        where: { removedFromBill: false, quantity: { gt: 0 } },
        orderBy: { id: "asc" },
        include: {
          menuItem: { select: { gstEnabled: true, menuType: true } },
        },
      },
    },
  },
  kots: {
    orderBy: { createdAt: "asc" },
    include: {
      items: { orderBy: { id: "asc" } },
    },
  },
} as const;

type TableWorkflowStatus =
  | "Free"
  | "Occupied"
  | "Preparing"
  | "Ready"
  | "Waiting Bill"
  | "Reserved"
  | "Cleaning";

const VALID_WORKFLOW_STATUSES = new Set<TableWorkflowStatus>([
  "Free",
  "Occupied",
  "Preparing",
  "Ready",
  "Waiting Bill",
  "Reserved",
  "Cleaning",
]);

function toBackendStatus(workflowStatus?: string): TableStatus {
  switch (workflowStatus) {
    case "Occupied":
    case "Preparing":
    case "Ready":
      return TableStatus.OCCUPIED;
    case "Waiting Bill":
      return TableStatus.BILLING_REQUESTED;
    case "Reserved":
      return TableStatus.RESERVED;
    case "Cleaning":
      return TableStatus.CLEANING;
    case "Free":
    default:
      return TableStatus.AVAILABLE;
  }
}

function requireRestaurantId(_reqRestaurantId: unknown, _res: { status: (code: number) => { json: (body: unknown) => void } }, req?: any): string | null {
  if (req) return getUserRestaurantId(req) ?? null;
  return null;
}

function emitTableUpdated(restaurantId: string, table: unknown): void {
  getIo().to(restaurantId).emit("table:updated", { restaurantId, table });
}

router.get("/", authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const sections = await prisma.section.findMany({
      where: { restaurantId },
      orderBy: { name: "asc" },
      include: {
        tables: {
          where: { restaurantId },
          orderBy: { number: "asc" },
          include: tableInclude,
        },
      },
    });

    res.set("Cache-Control", "no-store");
    res.json(sections);
  } catch (error) {
    logger.error({ err: error }, "[GET /api/bar/tables]");
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: "Failed to fetch tables", detail: msg });
  }
});

router.get("/flat", authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tables = await prisma.table.findMany({
      where: { restaurantId },
      orderBy: [{ section: { name: "asc" } }, { number: "asc" }],
      include: tableInclude,
    });

    res.set("Cache-Control", "no-store");
    res.json(tables);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch tables" });
  }
});

router.get("/sections", authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req) ?? '';

    const sections = await prisma.section.findMany({
      where: { restaurantId: getUserRestaurantId(req) ?? '' },
      orderBy: { name: "asc" },
      include: {
        tables: {
          where: { restaurantId: getUserRestaurantId(req) ?? '' },
          orderBy: { number: "asc" },
          include: tableInclude,
        },
      },
    });

    res.json(sections);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch sections" });
  }
});

router.post("/", authenticate, async (req: any, res) => {
  try {
    const { number, capacity, sectionId, status } = req.body as {
      number?: number | string;
      capacity?: number;
      sectionId?: string;
      status?: string;
    };
    const restaurantId = getUserRestaurantId(req) ?? '';

    const parsedNumber = Number(number);
    if (!Number.isInteger(parsedNumber) || parsedNumber <= 0 || !sectionId?.trim()) {
      res.status(400).json({
        error: "number and sectionId are required",
      });
      return;
    }

    if (status && !VALID_STATUSES.has(status)) {
      res.status(400).json({
        error: "Invalid status",
        validStatuses: Array.from(VALID_STATUSES),
      });
      return;
    }

    const section = await prisma.section.findFirst({
      where: { id: sectionId, restaurantId: getUserRestaurantId(req) ?? '' },
    });
    if (!section) {
      res.status(404).json({ error: "Section not found" });
      return;
    }

    const created = await prisma.table.create({
      data: {
        number: parsedNumber,
        capacity: capacity ?? 4,
        sectionId,
        restaurantId: getUserRestaurantId(req) ?? '',
        status: (status as TableStatus | undefined) ?? TableStatus.AVAILABLE,
      },
      include: tableInclude,
    });

    emitTableUpdated(restaurantId ?? '', created);
    res.status(201).json(created);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to create table" });
  }
});

router.patch("/:id/status", authenticate, async (req: any, res) => {
  try {
    const id = req.params.id as string;
    const { status } = req.body as { status?: string };

    if (!status || !VALID_STATUSES.has(status)) {
      res.status(400).json({
        error: "Invalid status",
        validStatuses: Array.from(VALID_STATUSES),
      });
      return;
    }

    const existing = await prisma.table.findFirst({ where: { id, restaurantId: getUserRestaurantId(req) ?? '' } });
    if (!existing) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    const isAvailable = status === TableStatus.AVAILABLE;
    if (isAvailable) {
      await prisma.kot.deleteMany({ where: { tableId: id } });
    }
    const updated = await prisma.table.update({
      where: { id },
      data: {
        status: status as TableStatus,
        workflowStatus:
          status === TableStatus.BILLING_REQUESTED
            ? "Waiting Bill"
            : isAvailable
              ? "Free"
              : undefined,
        captainId: isAvailable ? null : undefined,
        guests: isAvailable ? 0 : undefined,
        sessionStartedAt: isAvailable ? null : undefined,
        currentBill: isAvailable ? 0 : undefined,
        kotHistory: isAvailable ? [] : undefined,
      },
      include: tableInclude,
    });

    emitTableUpdated(getUserRestaurantId(req) ?? '', updated);
    res.json(updated);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update table status" });
  }
});

router.patch("/:id/session", authenticate, async (req: any, res) => {
  try {
    const id = req.params.id as string;
    const {
      status,
      captainId,
      guests,
      time,
      currentBill,
    } = req.body as {
      status?: TableWorkflowStatus;
      captainId?: string | null;
      guests?: number | null;
      time?: string | null;
      currentBill?: number | null;
    };

    if (status && !VALID_WORKFLOW_STATUSES.has(status)) {
      res.status(400).json({
        error: "Invalid workflow status",
        validStatuses: Array.from(VALID_WORKFLOW_STATUSES),
      });
      return;
    }

    const existing = await prisma.table.findFirst({ where: { id, restaurantId: getUserRestaurantId(req) ?? '' } });
    if (!existing) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    const workflowStatus = status ?? existing.workflowStatus ?? "Free";
    const isFree = workflowStatus === "Free";

    let finalSessionStartedAt: string | Date | null | undefined = isFree ? null : time ?? existing.sessionStartedAt;
    if (finalSessionStartedAt) {
      if (typeof finalSessionStartedAt === "number") {
        // Raw JS number timestamp
        finalSessionStartedAt = new Date(Number(finalSessionStartedAt)).toISOString();
      } else if (typeof finalSessionStartedAt === "string") {
        if (/^\d+[a-z]+$/i.test(finalSessionStartedAt)) {
          // Relative string like "1m", "2h" — use now
          finalSessionStartedAt = new Date().toISOString();
        } else if (/^\d+$/.test(finalSessionStartedAt)) {
          // Pure numeric string — Unix ms timestamp
          finalSessionStartedAt = new Date(Number(finalSessionStartedAt)).toISOString();
        } else {
          const d = new Date(finalSessionStartedAt);
          if (!isNaN(d.getTime())) {
            finalSessionStartedAt = d.toISOString();
          } else {
            finalSessionStartedAt = new Date().toISOString();
          }
        }
      } else if (finalSessionStartedAt instanceof Date) {
        finalSessionStartedAt = finalSessionStartedAt.toISOString();
      }
    }

    if (isFree) {
      await prisma.kot.deleteMany({ where: { tableId: id } });
    }
    const updated = await prisma.table.update({
      where: { id },
      data: {
        status: toBackendStatus(workflowStatus),
        workflowStatus,
        captainId: isFree ? null : captainId ?? existing.captainId,
        guests: isFree ? 0 : guests ?? existing.guests,
        sessionStartedAt: finalSessionStartedAt as string | null | undefined,
        currentBill: isFree ? 0 : currentBill ?? existing.currentBill,
        ...(isFree ? { kotHistory: [] } : {}),
      },
      include: tableInclude,
    });

    emitTableUpdated(getUserRestaurantId(req) ?? '', updated);
    res.json(updated);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update table session" });
  }
});

// PATCH /api/tables/:id — update specific fields on a table (e.g. discount before billing)
router.patch("/:id", authenticate, async (req: any, res) => {
  try {
    const id = req.params.id as string;
    const { discount } = req.body as { discount?: number };

    const table = await prisma.table.findFirst({ where: { id, restaurantId: getUserRestaurantId(req) ?? '' } });
    if (!table) {
      return res.status(404).json({ error: "Table not found" });
    }

    const updateData: Record<string, unknown> = {};
    if (discount !== undefined) {
      const parsed = parseFloat(String(discount));
      updateData.discount = isNaN(parsed) ? null : Math.max(0, Math.min(100, parsed));
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const updated = await prisma.table.update({
      where: { id },
      data: updateData,
    });

    res.json({ success: true, table: updated });
  } catch (err) {
    logger.error({ err }, "[PATCH /tables/:id]");
    res.status(500).json({ error: "Failed to update table" });
  }
});

router.delete("/:id", authenticate, async (req: any, res) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.table.findFirst({ where: { id, restaurantId: getUserRestaurantId(req) ?? '' } });
    if (!existing) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    await prisma.table.delete({ where: { id } });
    getIo().to(existing.restaurantId).emit("table:deleted", {
      restaurantId: existing.restaurantId,
      id,
    });

    res.json({ success: true });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to delete table" });
  }
});

// ─── Terminate Table Session ──────────────────────────────────────────────
router.post("/terminate-table/:tableId", authenticate, invalidateCache(["tables:*", "sections:list:*"]), async (req: any, res) => {
  try {
    const tableId = req.params.tableId as string;
    const requestingRestaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    if (!requestingRestaurantId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 1. Verify table belongs to this tenant
    const table = await prisma.table.findUnique({
      where: { id: tableId },
      select: { restaurantId: true },
    });
    if (!table) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }
    if (table.restaurantId !== requestingRestaurantId) {
      res.status(403).json({ error: 'Cross-tenant access denied' });
      return;
    }

    const restaurantId = requestingRestaurantId;

    // 2. Find active order for this table — include items and table info for cancelled bill
    const activeOrder = await prisma.order.findFirst({
      where: {
        tableId,
        restaurantId,
        status: { in: ACTIVE_ORDER_STATUSES },
      },
      include: {
        items: {
          where: { removedFromBill: false, quantity: { gt: 0 } },
          include: { menuItem: true },
        },
        table: {
          include: { section: { include: { venue: { include: { taxProfile: true } } } } },
        },
      },
    });

    // Fetch outlet data for bill header
    const billRestaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { name: true, receiptHeader: true, receiptSubHeader: true, address: true, phone: true, gstin: true },
    });

    const ctx = await resolveTenantContext(restaurantId);

    const result = await prisma.$transaction(async (tx) => {
      let updatedOrder = null;
      let cancelledBillNumber: string | null = null;

      if (activeOrder) {
        // Generate or reuse bill number for the cancelled bill
        if (activeOrder.billNumber) {
          cancelledBillNumber = activeOrder.billNumber;
        } else {
          const counterDate = getKolkataDateString();
          const counter = await tx.dailyCounter.upsert({
            where: { restaurantId_counterDate: { restaurantId, counterDate } },
            update: { billCount: { increment: 1 } },
            create: { restaurantId, counterDate, billCount: 1 },
            select: { billCount: true },
          });
          cancelledBillNumber = String(counter.billCount);
        }

        await tx.orderItem.deleteMany({
          where: { orderId: activeOrder.id },
        });
        updatedOrder = await tx.order.update({
          where: { id: activeOrder.id },
          data: {
            status: OrderStatus.CANCELLED,
            totalAmount: new Prisma.Decimal(0),
            billNumber: cancelledBillNumber,
          },
          include: {
            table: {
              include: { section: true }
            }
          },
        });
      }

      // 3. Reset the table — delete all Kot/KotItem rows for this table
      await tx.kot.deleteMany({ where: { tableId } });
      const updatedTable = await tx.table.update({
        where: { id: tableId },
        data: {
          status: TableStatus.AVAILABLE,
          workflowStatus: "Free",
          kotHistory: [],
          currentBill: 0,
          captainId: null,
          guests: 0,
          sessionStartedAt: null,
        },
        include: tableInclude,
      });

      return { order: updatedOrder, table: updatedTable, cancelledBillNumber };
    }, { timeout: 15000, maxWait: 20000 });

    // 4. Emit socket events
    const emitRestaurantId = (result.table as any).restaurantId || result.table.section?.restaurantId || restaurantId;
    if (!emitRestaurantId) {
      logger.warn('[barTables] Cannot emit table update: missing restaurantId');
    } else if (result.order) {
      emitTableUpdated(emitRestaurantId, result.table);
      getIo().to(emitRestaurantId).emit("order:updated", { order: result.order });
    } else {
      emitTableUpdated(emitRestaurantId, result.table);
    }

    // 5. If there were items, build and emit a CANCELLED BILL to the bill printer
    if (activeOrder && activeOrder.items.length > 0 && result.cancelledBillNumber) {
      try {
        const now = new Date();
        const items = activeOrder.items;
        const tbl = activeOrder.table!;

        // Calculate bill details
        const foodItems = items.filter(item => item.menuItem.menuType === "FOOD");
        const liquorItems = items.filter(item => {
          const mt = item.menuItem.menuType as string;
          return mt === "LIQUOR" || mt === "BAR";
        });

        const foodSubtotal = foodItems.reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
        const liquorSubtotal = liquorItems.reduce((sum, item) => sum + (Number(item.price) * item.quantity), 0);
        const subtotal = foodSubtotal + liquorSubtotal;

        // Tax calculation
        const venueTaxProfile = tbl.section?.venue?.taxProfile;
        const taxSource = venueTaxProfile
          ? { gstRate: venueTaxProfile.gstRate, gstCategory: venueTaxProfile.gstCategory, gstRegistered: venueTaxProfile.gstRegistered, pricesIncludeGst: ctx.pricesIncludeGst }
          : ctx;
        const effectiveRate = getEffectiveGstRate(taxSource.gstRate, taxSource.gstCategory, taxSource.gstRegistered);
        const { cgst, sgst, tax, baseAmount } = getGstBreakdownWithRate(foodSubtotal, effectiveRate, !!taxSource.pricesIncludeGst);
        const displayedSubtotal = Math.round((baseAmount + liquorSubtotal) * 100) / 100;
        const rawGrandTotal = Math.round((displayedSubtotal + tax) * 100) / 100;
        const grandTotal = Math.round(rawGrandTotal);
        const roundOff = Math.round((grandTotal - rawGrandTotal) * 100) / 100;

        // Format table number for bar
        const formattedTableNumber = `B${tbl.number}`;

        // Group items for bill
        const groupedItems = items.reduce((acc, item) => {
          const key = `${item.name}::${Number(item.price)}::${item.notes ?? ''}`;
          if (!acc[key]) {
            acc[key] = { name: item.name, quantity: 0, price: Number(item.price), menuType: item.menuItem.menuType, notes: item.notes ?? null };
          }
          acc[key].quantity += item.quantity;
          return acc;
        }, {} as Record<string, any>);

        const billItems = Object.values(groupedItems).map((item: any) => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          amount: item.price * item.quantity,
          menuType: item.menuType,
          notes: item.notes,
        }));

        // KOT numbers from table history (use pre-termination data)
        const kotHistory = (tbl as any).kots as Array<{ kotNumber: number }> || [];
        const kotNumbers = kotHistory.map(k => String(k.kotNumber)).filter(Boolean);

        const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
        const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });

        const billData = {
          billNumber: result.cancelledBillNumber,
          date: dateStr,
          time: timeStr,
          kotNumbers,
          tableNumber: formattedTableNumber,
          captain: (tbl as any).captainId || "N/A",
          items: billItems,
          subtotal,
          discount: null,
          tax: { cgst, sgst, total: tax },
          grandTotal,
          roundOff,
          section: tbl.section?.name || "Bar",
          sectionTag: (tbl as any).sectionTag || null,
          itemCount: billItems.length,
          qtyCount: items.reduce((sum, item) => sum + item.quantity, 0),
          ...(ctx.gstin ? { gstIn: ctx.gstin } : {}),
          restaurant: billRestaurant as any,
          isCancelled: true,
        };

        const cancelledBillEscpos = buildFinalBill(billData as any);
        const eventId = randomUUID();
        const envelope = {
          restaurantId: emitRestaurantId,
          type: "CANCELLED_BILL",
          data: { ...billData, escposData: cancelledBillEscpos, eventId },
          eventId,
        };
        getIo().to(`print:${emitRestaurantId}`).emit("print_job", envelope);
        bufferPrintJob(emitRestaurantId, envelope).catch(() => {});
      } catch (printErr) {
        logger.error({ err: printErr }, "[terminate-table bar] Failed to emit cancelled bill print job");
      }
    }

    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "[terminate-table bar]");
    res.status(500).json({ error: 'Failed to terminate bar table session' });
  }
});

export default router;
