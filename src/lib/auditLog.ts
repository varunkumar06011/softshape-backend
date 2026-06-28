// ─────────────────────────────────────────────────────────────────────────────
// Audit Logging
// ─────────────────────────────────────────────────────────────────────────────
// Provides fire-and-forget audit logging for tracking user actions across the app.
// Audit logs are written to the AuditLog table via Prisma and capture WHO did WHAT
// to WHICH entity, with optional metadata for context.
//
// Design principle: audit logging must NEVER block or fail the main operation.
// If the DB write fails, the error is silently swallowed. This ensures that
// critical operations (order creation, payment, etc.) are not affected by
// audit log infrastructure issues.
//
// Usage:
//   createAuditLog({
//     userId: req.user.id,
//     restaurantId: req.user.restaurantId,
//     action: 'MENU_ITEM_DELETE',
//     entityType: 'MenuItem',
//     entityId: itemId,
//     metadata: { name: item.name }
//   });
// ─────────────────────────────────────────────────────────────────────────────

import prisma from './prisma';

// Parameters for creating an audit log entry.
interface AuditLogParams {
  userId?: string;                          // ID of the user who performed the action
  restaurantId?: string;                    // Restaurant context for the action
  action: string;                           // Action name (e.g. 'ORDER_CREATE', 'MENU_ITEM_DELETE')
  entityType: string;                       // Type of entity affected (e.g. 'Order', 'MenuItem')
  entityId?: string;                        // ID of the affected entity
  metadata?: Record<string, any>;           // Additional context (before/after values, etc.)
}

/**
 * Fire-and-forget audit logging. Never blocks the main operation.
 * Creates an AuditLog record in the DB. If the write fails, the error is
 * silently caught so the caller's operation is unaffected.
 */
export function createAuditLog(params: AuditLogParams): void {
  prisma.auditLog.create({
    data: {
      userId: params.userId ?? null,
      restaurantId: params.restaurantId ?? null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      metadata: (params.metadata ?? null) as any,
    },
  }).catch(() => {
    // Silently ignore audit log failures — must never block main operations
  });
}
