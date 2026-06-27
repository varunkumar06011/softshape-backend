import prisma from './prisma';

interface AuditLogParams {
  userId?: string;
  restaurantId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, any>;
}

/**
 * Fire-and-forget audit logging. Never blocks the main operation.
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
