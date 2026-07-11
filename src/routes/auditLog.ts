// ─────────────────────────────────────────────────────────────────────────────
// Audit Log Routes — Tenant-scoped read endpoint for financial audit trail
// ─────────────────────────────────────────────────────────────────────────────
// Provides a paginated, filterable read-only endpoint for audit log entries.
// Only ADMIN and OWNER roles can access this endpoint — no manager access.
//
// Endpoint:
//   GET /api/audit-log?page=1&limit=50&entityType=&action=&startDate=&endDate=
//
// All routes use authenticate + assertTenantScope + assertSubscriptionActive + withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { basePrisma } from "../lib/prisma";
import { authenticate, requireRole } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { withTenantContext } from "../middleware/tenantContext";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { resolveTenantContext } from "../lib/tenantContext";
import logger from "../lib/logger";

const router = Router();

router.use(authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext);

// ── GET /api/audit-log ────────────────────────────────────────────────────────
router.get("/", requireRole('ADMIN', 'OWNER') as any, async (req: any, res) => {
  try {
    const sessionRestaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
    if (!sessionRestaurantId) return res.status(400).json({ error: "restaurantId required" });

    // Resolve all tenant outlet IDs so audit logs from any outlet in the tenant are visible
    const ctx = await resolveTenantContext(sessionRestaurantId);
    const tenantIds = ctx.allIds ?? [sessionRestaurantId];

    // ── Parse query params ──
    const { entityType, action, startDate, endDate } = req.query;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    // Build the where clause
    const where: any = {
      restaurantId: { in: tenantIds },
    };

    if (entityType && typeof entityType === "string" && entityType.trim()) {
      where.entityType = entityType.trim();
    }

    if (action && typeof action === "string" && action.trim()) {
      where.action = action.trim();
    }

    // Date range filter on createdAt
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        const start = new Date(startDate as string);
        if (isNaN(start.getTime())) {
          return res.status(400).json({ error: "Invalid startDate" });
        }
        where.createdAt.gte = start;
      }
      if (endDate) {
        const end = new Date(endDate as string);
        if (isNaN(end.getTime())) {
          return res.status(400).json({ error: "Invalid endDate" });
        }
        // Include the entire end day
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    // ── Fetch logs with user join ──
    const [logs, total] = await Promise.all([
      basePrisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
        },
      } as any),
      basePrisma.auditLog.count({ where }),
    ]);

    // ── Format response ──
    const formattedLogs = logs.map((log: any) => ({
      id: log.id,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      metadata: log.metadata,
      createdAt: log.createdAt,
      user: log.user
        ? { id: log.user.id, name: log.user.name, email: log.user.email }
        : null,
    }));

    const totalPages = Math.ceil(total / limit);

    res.json({
      logs: formattedLogs,
      total,
      page,
      totalPages,
    });
  } catch (error: any) {
    logger.error({ err: error }, "[AuditLog] List failed");
    res.status(500).json({ error: error.message });
  }
});

export default router;
