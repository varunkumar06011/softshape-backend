// ─────────────────────────────────────────────────────────────────────────────
// Tables Routes — Table management, status tracking, and QR code generation
// ─────────────────────────────────────────────────────────────────────────────
// Manages restaurant tables: CRUD, status tracking, QR code generation,
// table swaps, and section assignment. Tables are the core unit for order
// placement and billing in the POS system.
//
// Features:
//   - Table CRUD (create, update, delete)
//   - Status management (AVAILABLE, OCCUPIED, BILLING, RESERVED, etc.)
//   - QR code generation with HMAC-signed URLs (via tableSignature lib)
//   - Table swap/transfer with ESC/POS print output
//   - Real-time socket updates on table status changes
//   - Cache invalidation on mutations
//   - Active order tracking per table
//
// Endpoints:
//   GET    /api/tables              — list all tables with sections and active orders
//   POST   /api/tables              — create a new table
//   PATCH  /api/tables/:id          — update table (status, number, section)
//   DELETE /api/tables/:id          — delete a table
//   GET    /api/tables/:id/qr       — generate QR code URL for a table
//   POST   /api/tables/swap         — swap items between two tables (with print)
//   ...and more
// ─────────────────────────────────────────────────────────────────────────────

import { OrderStatus, TableStatus, PrismaClient } from "@prisma/client";
import crypto from "crypto";
import logger from "../lib/logger";
import { Router } from "express";
import { getIo } from "../socket";
import { emitConfigChange, emitConfigBatch } from "../lib/edgeEmit";
import prisma, { basePrisma } from "../lib/prisma";
import { cacheMiddleware, invalidateCache } from "../lib/cache";
import { buildTableSwap } from "../utils/escpos";
import { bufferPrintJob } from "../lib/printQueue";
import { tableInclude, calculateOrderTotalAmount, emitTableUpdated, emitTableTerminated, transferOrderItemsService } from "../services/tableService";
import { requireRole } from "../middleware/auth";
import { createAuditLog } from "../lib/auditLog";
import { resolveTenantContext } from "../lib/tenantContext";

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

type TableWorkflowStatus =
  | "Free"
  | "Occupied"
  | "Preparing"
  | "Ready"
  | "Waiting Bill"
  | "Billing"
  | "Reserved"
  | "Cleaning";

const VALID_WORKFLOW_STATUSES = new Set<TableWorkflowStatus>([
  "Free",
  "Occupied",
  "Preparing",
  "Ready",
  "Waiting Bill",
  "Billing",
  "Reserved",
  "Cleaning",
]);

// Maps workflow status strings to the expanded DB enum.
// With the new PREPARING/READY/BILLING enum values, status is the single source
// of truth. workflowStatus is kept as a derived field for frontend compatibility.
function toBackendStatus(workflowStatus?: string): TableStatus {
  switch (workflowStatus) {
    case "Occupied":
      return TableStatus.OCCUPIED;
    case "Preparing":
      return TableStatus.PREPARING;
    case "Ready":
      return TableStatus.READY;
    case "Waiting Bill":
      return TableStatus.BILLING_REQUESTED;
    case "Billing":
      return TableStatus.BILLING;
    case "Reserved":
      return TableStatus.RESERVED;
    case "Cleaning":
      return TableStatus.CLEANING;
    case "Free":
    default:
      return TableStatus.AVAILABLE;
  }
}

// Derives the frontend workflow status string from the DB enum.
// This is the canonical mapping — workflowStatus is now read-only.
export function toWorkflowStatus(status: TableStatus): TableWorkflowStatus {
  switch (status) {
    case TableStatus.OCCUPIED:
      return "Occupied";
    case TableStatus.PREPARING:
      return "Preparing";
    case TableStatus.READY:
      return "Ready";
    case TableStatus.BILLING_REQUESTED:
      return "Waiting Bill";
    case TableStatus.BILLING:
      return "Billing";
    case TableStatus.RESERVED:
      return "Reserved";
    case TableStatus.CLEANING:
      return "Cleaning";
    case TableStatus.AVAILABLE:
    default:
      return "Free";
  }
}

function getUserRestaurantId(req: any): string | undefined {
  return req.user?.activeRestaurantId ?? req.user?.restaurantId;
}

// ── Idempotency helper: check ProcessedRequest for dedup ────────────────────
// Returns the cached result if this requestId+actionType was already processed.
async function checkIdempotency(requestId: string | undefined, actionType: string, restaurantId: string) {
  if (!requestId) return null;
  const existing = await prisma.processedRequest.findUnique({
    where: {
      requestId_actionType_restaurantId: {
        requestId,
        actionType,
        restaurantId,
      },
    },
  });
  return existing?.result as any || null;
}

// ── Idempotency helper: record ProcessedRequest after successful mutation ───
async function recordIdempotency(requestId: string | undefined, actionType: string, restaurantId: string, result: any) {
  if (!requestId) return;
  await prisma.processedRequest.create({
    data: {
      requestId,
      actionType,
      restaurantId,
      deviceId: null,
      result,
    },
  }).catch(err => console.error('[tables] recordIdempotency failed:', err.message));
}

async function resolveTargetRestaurantIds(req: any): Promise<{ ids: string[]; error?: { status: number; message: string } }> {
  const sessionRestaurantId = getUserRestaurantId(req);
  const { outletId } = req.query;
  if (!sessionRestaurantId) {
    return { ids: [], error: { status: 401, message: "Authentication required" } };
  }

  const tenantCtx = await resolveTenantContext(String(sessionRestaurantId));
  const tenantIds = tenantCtx.allIds;
  let targetIds: string[] = [String(sessionRestaurantId)];

  if (outletId === "all") {
    targetIds = tenantIds;
  } else if (outletId) {
    const explicitId = String(outletId);
    if (!tenantIds.includes(explicitId)) {
      return { ids: [], error: { status: 403, message: "Outlet not accessible" } };
    }
    targetIds = [explicitId];
  }

  return { ids: targetIds };
}

router.get("/", cacheMiddleware("tables:list", 30_000), async (req, res) => {
  try {
    const { ids: targetIds, error } = await resolveTargetRestaurantIds(req);
    if (error) {
      return res.status(error.status).json({ error: error.message });
    }

    const restaurantFilter = targetIds.length === 1 ? targetIds[0] : { in: targetIds };
    const sections = await basePrisma.section.findMany({
      where: { restaurantId: restaurantFilter },
      orderBy: { name: "asc" },
      include: {
        tables: {
          where: { restaurantId: restaurantFilter },
          orderBy: { number: "asc" },
          include: tableInclude,
        },
      },
    });

    res.json(sections);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch tables" });
  }
});

router.get("/flat", cacheMiddleware("tables:flat", 30_000), async (req, res) => {
  try {
    const { ids: targetIds, error } = await resolveTargetRestaurantIds(req);
    if (error) {
      return res.status(error.status).json({ error: error.message });
    }

    const tables = await basePrisma.table.findMany({
      where: { restaurantId: targetIds.length === 1 ? targetIds[0] : { in: targetIds } },
      orderBy: [{ section: { name: "asc" } }, { number: "asc" }],
      include: tableInclude,
    });

    res.json(tables);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch tables" });
  }
});

router.get("/sections", cacheMiddleware("sections:list", 120_000), async (req, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
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

    res.json(sections);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to fetch sections" });
  }
});

router.post("/", invalidateCache(["tables:*", "sections:*"]), async (req, res) => {
  try {
    const { number, capacity, sectionId, status, requestId } = req.body as {
      number?: number | string;
      capacity?: number;
      sectionId?: string;
      status?: string;
      requestId?: string;
    };
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    // ── Idempotency check ──
    const cached = await checkIdempotency(requestId, 'create-table', restaurantId);
    if (cached) {
      res.status(201).json(cached);
      return;
    }

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
      where: { id: sectionId },
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
        restaurantId,
        status: (status as TableStatus | undefined) ?? TableStatus.AVAILABLE,
      },
      include: tableInclude,
    });

    emitTableUpdated(created.restaurantId, created);
    emitConfigChange(created.restaurantId, "table", "upsert", created);
    await recordIdempotency(requestId, 'create-table', restaurantId, created);
    res.status(201).json(created);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to create table" });
  }
});

// POST /api/tables/bulk — create multiple tables at once
router.post("/bulk", invalidateCache(["tables:*", "sections:*"]), async (req, res) => {
  try {
    const { sectionId, count, capacity, startNumber, requestId } = req.body as {
      sectionId?: string;
      count?: number;
      capacity?: number;
      startNumber?: number;
      requestId?: string;
    };
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    // ── Idempotency check ──
    const cached = await checkIdempotency(requestId, 'bulk-create-tables', restaurantId);
    if (cached) {
      res.status(201).json(cached);
      return;
    }

    const parsedCount = Number(count);
    const parsedCapacity = capacity ?? 4;
    const parsedStart = startNumber ?? 1;

    if (!Number.isInteger(parsedCount) || parsedCount <= 0 || parsedCount > 100) {
      res.status(400).json({ error: "count must be an integer between 1 and 100" });
      return;
    }
    if (!sectionId?.trim()) {
      res.status(400).json({ error: "sectionId is required" });
      return;
    }

    const section = await prisma.section.findFirst({
      where: { id: sectionId, restaurantId },
    });
    if (!section) {
      res.status(404).json({ error: "Section not found" });
      return;
    }

    // Find the max table number within this restaurant to avoid collisions
    const maxTable = await prisma.table.findFirst({
      where: { restaurantId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const baseNumber = Math.max(maxTable?.number ?? 0, parsedStart - 1);

    const data = Array.from({ length: parsedCount }, (_, i) => ({
      number: baseNumber + 1 + i,
      capacity: parsedCapacity,
      sectionId,
      restaurantId,
      status: TableStatus.AVAILABLE,
    }));

    await prisma.table.createMany({ data });

    // Fetch the newly created tables for socket emission
    const created = await prisma.table.findMany({
      where: {
        restaurantId,
        sectionId,
        number: { gte: baseNumber + 1, lte: baseNumber + parsedCount },
      },
      include: tableInclude,
    });

    for (const t of created) {
      emitTableUpdated(t.restaurantId, t);
    }

    const bulkResult = { created: created.length, tables: created };
    await recordIdempotency(requestId, 'bulk-create-tables', restaurantId, bulkResult);
    res.status(201).json(bulkResult);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to create tables in bulk" });
  }
});

router.patch("/:id/status", invalidateCache(["tables:*", "sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    const { status, requestId } = req.body as { status?: string; requestId?: string };
    const restaurantId = getUserRestaurantId(req) ?? '';

    // ── Idempotency check ──
    const cached = await checkIdempotency(requestId, 'update-table-status', restaurantId);
    if (cached) {
      res.json(cached);
      return;
    }

    if (!status || !VALID_STATUSES.has(status)) {
      res.status(400).json({
        error: "Invalid status",
        validStatuses: Array.from(VALID_STATUSES),
      });
      return;
    }

    const existing = await prisma.table.findFirst({ where: { id, restaurantId } });
    if (!existing) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    const isAvailable = status === TableStatus.AVAILABLE;
    if (isAvailable) {
      await prisma.kot.deleteMany({ where: { tableId: id } });
    }
    // Derive workflowStatus from the canonical status enum
    const derivedWorkflowStatus = toWorkflowStatus(status as TableStatus);
    const updated = await prisma.table.update({
      where: { id },
      data: {
        status: status as TableStatus,
        workflowStatus: derivedWorkflowStatus,
        captainId: isAvailable ? null : undefined,
        guests: isAvailable ? 0 : undefined,
        sessionStartedAt: isAvailable ? null : undefined,
        currentBill: isAvailable ? 0 : undefined,
        kotHistory: isAvailable ? [] : undefined,
      },
      include: tableInclude,
    });

    emitTableUpdated(updated.restaurantId, updated);
    emitConfigChange(updated.restaurantId, "table", "upsert", updated);
    if (isAvailable) {
      emitTableTerminated(updated.restaurantId, id, (req as any).user?.id);
    }
    await recordIdempotency(requestId, 'update-table-status', restaurantId, updated);
    res.json(updated);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update table status" });
  }
});

router.patch("/:id/session", invalidateCache(["tables:*", "sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    const {
      status,
      captainId,
      guests,
      time,
      currentBill,
      requestId,
    } = req.body as {
      status?: TableWorkflowStatus;
      captainId?: string | null;
      guests?: number | null;
      time?: string | null;
      currentBill?: number | null;
      requestId?: string;
    };
    const restaurantId = getUserRestaurantId(req) ?? '';

    // ── Idempotency check ──
    const cached = await checkIdempotency(requestId, 'update-table-session', restaurantId);
    if (cached) {
      res.json(cached);
      return;
    }

    if (status && !VALID_WORKFLOW_STATUSES.has(status)) {
      res.status(400).json({
        error: "Invalid workflow status",
        validStatuses: Array.from(VALID_WORKFLOW_STATUSES),
      });
      return;
    }

    const existing = await prisma.table.findFirst({ where: { id, restaurantId } });
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

    emitTableUpdated(updated.restaurantId, updated);
    emitConfigChange(updated.restaurantId, "table", "upsert", updated);
    if (isFree) {
      emitTableTerminated(updated.restaurantId, id, (req as any).user?.id);
    }
    await recordIdempotency(requestId, 'update-table-session', restaurantId, updated);
    res.json(updated);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to update table session" });
  }
});

// PATCH /api/tables/:id — update specific fields on a table (e.g. discount before billing)
router.patch("/:id", requireRole('CAPTAIN', 'CASHIER', 'ADMIN', 'OWNER', 'MANAGER') as any, invalidateCache(["tables:*", "sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    const { discount, number, capacity, sectionId, requestId } = req.body as {
      discount?: number;
      number?: number;
      capacity?: number;
      sectionId?: string;
      requestId?: string;
    };

    const restaurantId = getUserRestaurantId(req) ?? '';

    // ── Idempotency check ──
    const cached = await checkIdempotency(requestId, 'update-table', restaurantId);
    if (cached) {
      res.json(cached);
      return;
    }

    const table = await prisma.table.findFirst({ where: { id, restaurantId } });
    if (!table) {
      return res.status(404).json({ error: "Table not found" });
    }

    const updateData: Record<string, unknown> = {};

    // ── Table layout fields (number, capacity, sectionId) ──
    if (number !== undefined) {
      const parsedNumber = Number(number);
      if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) {
        return res.status(400).json({ error: "Table number must be a positive integer" });
      }
      updateData.number = parsedNumber;
    }
    if (capacity !== undefined) {
      const parsedCapacity = Number(capacity);
      if (!Number.isInteger(parsedCapacity) || parsedCapacity <= 0) {
        return res.status(400).json({ error: "Capacity must be a positive integer" });
      }
      updateData.capacity = parsedCapacity;
    }
    if (sectionId !== undefined && sectionId !== null && sectionId.trim()) {
      const section = await prisma.section.findFirst({ where: { id: sectionId, restaurantId } });
      if (!section) {
        return res.status(404).json({ error: "Section not found" });
      }
      updateData.sectionId = sectionId;
    }

    if (discount !== undefined) {
      const parsed = parseFloat(String(discount));
      const requestedDiscount = isNaN(parsed) ? null : Math.max(0, Math.min(100, parsed));

      if (requestedDiscount !== null && requestedDiscount > 0) {
        const userRole = req.user?.role;
        if (userRole === 'CAPTAIN') {
          const assignment = await prisma.captainAssignment.findUnique({
            where: { restaurantId_captainId: { restaurantId, captainId: req.user!.userId! } },
          });
          if (!assignment) {
            return res.status(403).json({ error: 'No discount limit assigned. Contact your manager.' });
          }
          const maxDiscount = Number(assignment.discountLimit);
          if (requestedDiscount > maxDiscount) {
            return res.status(403).json({ error: `Discount exceeds your limit of ${maxDiscount}%` });
          }
        }

        createAuditLog({
          userId: req.user?.userId,
          restaurantId,
          action: 'DISCOUNT_APPLIED',
          entityType: 'TABLE',
          entityId: id,
          metadata: { percent: requestedDiscount },
        });
      }

      updateData.discount = requestedDiscount;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const updated = await prisma.table.update({
      where: { id },
      data: updateData,
      include: tableInclude,
    });

    emitTableUpdated(updated.restaurantId, updated);
    emitConfigChange(updated.restaurantId, "table", "upsert", updated);
    const updateResult = { success: true, table: updated };
    await recordIdempotency(requestId, 'update-table', restaurantId, updateResult);
    res.json(updateResult);
  } catch (err) {
    logger.error({ err }, "[PATCH /tables/:id]");
    res.status(500).json({ error: "Failed to update table" });
  }
});

router.post("/:id/swap", invalidateCache(["tables:*", "sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    const { targetTableId, swappedBy } = req.body as {
      targetTableId?: string;
      swappedBy?: string;
    };
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (!targetTableId?.trim()) {
      res.status(400).json({ error: "targetTableId is required" });
      return;
    }

    if (id === targetTableId) {
      res.status(400).json({ error: "Source and destination tables must be different" });
      return;
    }

    // Fetch both tables in parallel
    const [sourceTable, targetTable] = await Promise.all([
      prisma.table.findUnique({ where: { id }, include: tableInclude }),
      prisma.table.findUnique({ where: { id: targetTableId }, include: tableInclude }),
    ]);

    if (!sourceTable) {
      res.status(404).json({ error: "Source table not found" });
      return;
    }
    if (!targetTable) {
      res.status(404).json({ error: "Target table not found" });
      return;
    }
    if (sourceTable.status === TableStatus.AVAILABLE) {
      res.status(400).json({ error: "Source table has no active session" });
      return;
    }
    if (targetTable.status !== TableStatus.AVAILABLE) {
      res.status(409).json({ error: "Target table is not free" });
      return;
    }

    // Atomic transaction: move session to target, clear source
    await prisma.$transaction(async (tx) => {
      // 1. Reassign all active orders to target table
      await tx.order.updateMany({
        where: {
          tableId: id,
          status: { in: ACTIVE_ORDER_STATUSES },
        },
        data: { tableId: targetTableId },
      });

      // 2. Copy session fields from source → target, and reassign Kots to target table
      await tx.kot.updateMany({
        where: { tableId: id },
        data: { tableId: targetTableId },
      });
      await tx.table.update({
        where: { id: targetTableId },
        data: {
          status: sourceTable.status,
          workflowStatus: sourceTable.workflowStatus,
          captainId: sourceTable.captainId,
          guests: sourceTable.guests,
          sessionStartedAt: sourceTable.sessionStartedAt,
          currentBill: sourceTable.currentBill,
          kotHistory: (sourceTable.kotHistory as object[]) ?? [],
        },
      });

      // 3. Clear source table
      await tx.table.update({
        where: { id },
        data: {
          status: TableStatus.AVAILABLE,
          workflowStatus: "Free",
          captainId: null,
          guests: 0,
          sessionStartedAt: null,
          currentBill: 0,
          kotHistory: [],
        },
      });
    }, { timeout: 15000, maxWait: 10000 });

    // Re-fetch both tables outside transaction for fresh socket payloads
    const [updatedSource, updatedTarget] = await Promise.all([
      prisma.table.findUnique({ where: { id }, include: tableInclude }),
      prisma.table.findUnique({ where: { id: targetTableId }, include: tableInclude }),
    ]);

    // Emit table:updated for both tables
    emitTableUpdated(restaurantId, updatedSource);
    emitTableUpdated(restaurantId, updatedTarget);

    // Emit table:swapped for any UI that wants to react specially
    getIo().to(restaurantId).emit("table:swapped", {
      restaurantId,
      sourceTableId: id,
      targetTableId,
      sourceTable: updatedSource,
      targetTable: updatedTarget,
      swappedBy: swappedBy || "Staff",
    });

    // Emit TABLE_SWAP print job → kitchen printer (via dedicated print room)
    const tableSwapEscposData = buildTableSwap({
      fromTableNumber: sourceTable.number,
      toTableNumber: targetTable.number,
      swappedBy: swappedBy || "Staff",
      timestamp: new Date().toISOString(),
    });

    const swapEventId = crypto.randomUUID();
    const swapEnvelope = {
      type: "TABLE_SWAP",
      eventId: swapEventId,
      data: {
        fromTableNumber: sourceTable.number,
        toTableNumber: targetTable.number,
        swappedBy: swappedBy || "Staff",
        timestamp: new Date().toISOString(),
        escposData: tableSwapEscposData,
        eventId: swapEventId,
      },
    };
    try { await bufferPrintJob(restaurantId, swapEnvelope); } catch (err) { logger.error({ err }, '[tables] bufferPrintJob failed for table swap'); }
    const swapTargetRoom = `print:${restaurantId}:TABLE_SWAP`;
    const swapGeneralRoom = `print:${restaurantId}`;
    getIo().to(swapTargetRoom).emit("print_job", swapEnvelope);
    const swapSockets = await (getIo() as any).adapter.sockets(new Set([swapTargetRoom]));
    if (swapSockets.size === 0) {
      getIo().to(swapGeneralRoom).emit("print_job", swapEnvelope);
    }


    res.json({
      success: true,
      sourceTable: updatedSource,
      targetTable: updatedTarget,
    });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to swap tables" });
  }
});

router.post("/:id/transfer-items", invalidateCache(["tables:*", "sections:*"]), async (req, res) => {
  try {
    const id = req.params.id as string;
    const { targetTableId, itemIds, transferredBy, requestId } = req.body;
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const result = await transferOrderItemsService({
      sourceTableId: id,
      targetTableId,
      itemIds,
      transferredBy,
      requestId,
      restaurantId,
    });

    res.json(result);
  } catch (error: any) {
    logger.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to transfer items" });
  }
});

// DELETE /api/tables/all — delete all tables for the restaurant (skips tables with active orders)
router.delete("/all", requireRole('ADMIN', 'OWNER') as any, invalidateCache(["tables:*", "sections:*"]), async (req, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    // Find tables with active orders (these will be skipped)
    const tablesWithActiveOrders = await prisma.table.findMany({
      where: {
        restaurantId,
        orders: { some: { status: { in: ACTIVE_ORDER_STATUSES } } },
      },
      select: { id: true },
    });
    const skipIds = tablesWithActiveOrders.map(t => t.id);

    // Get IDs of tables that will be deleted (for edge sync)
    const tablesToDelete = await prisma.table.findMany({
      where: {
        restaurantId,
        ...(skipIds.length > 0 ? { id: { notIn: skipIds } } : {}),
      },
      select: { id: true },
    });

    // Delete all tables that don't have active orders
    const result = await prisma.table.deleteMany({
      where: {
        restaurantId,
        ...(skipIds.length > 0 ? { id: { notIn: skipIds } } : {}),
      },
    });

    getIo().to(restaurantId).emit("tables:bulk-deleted", {
      restaurantId,
      deletedCount: result.count,
      skippedCount: skipIds.length,
    });

    // Notify edge servers of all deleted tables
    if (tablesToDelete.length > 0) {
      emitConfigBatch(restaurantId, tablesToDelete.map(t => ({ table: "table", operation: "delete", row: { id: t.id } })));
    }

    res.json({ deleted: result.count, skipped: skipIds.length });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to delete all tables" });
  }
});

router.delete("/:id", invalidateCache(["tables:*", "sections:*"]), async (req, res) => {
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
    emitConfigChange(existing.restaurantId, "table", "delete", { id });

    res.json({ success: true });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: "Failed to delete table" });
  }
});

/**
 * GET /api/tables/:id/qr-url — Returns signed QR URL for a table (admin-only)
 *
 * Requires authentication (enforced by router-level authenticate middleware).
 */
router.get("/:id/qr-url", async (req, res) => {
  try {
    const tableId = req.params.id as string;
    const restaurantId = (req as any).user?.activeRestaurantId ?? (req as any).user?.restaurantId;

    const table = await prisma.table.findUnique({
      where: { id: tableId },
      select: { number: true, restaurantId: true },
    });

    if (!table) {
      return res.status(404).json({ error: "Table not found" });
    }

    // Ensure table belongs to the authenticated restaurant
    if (restaurantId && table.restaurantId !== restaurantId) {
      return res.status(403).json({ error: "Table does not belong to your restaurant" });
    }

    const restaurant = await prisma.outlet.findUnique({
      where: { id: table.restaurantId },
      select: { slug: true, name: true },
    });

    if (!restaurant || !restaurant.slug) {
      return res.status(400).json({ error: "Restaurant has no slug configured" });
    }

    const { generateTableSignature } = await import("../lib/tableSignature");
    const sig = generateTableSignature(restaurant.slug, tableId, table.restaurantId);
    const url = `/user-menu/${restaurant.slug}/${tableId}/${sig}`;

    res.json({ sig, url, tableNumber: table.number, restaurantName: restaurant.name });
  } catch (error) {
    logger.error({ err: error }, "[tables/qr-url]");
    res.status(500).json({ error: "Failed to generate QR URL" });
  }
});

export default router;
