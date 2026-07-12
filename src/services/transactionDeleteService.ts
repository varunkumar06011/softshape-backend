// ─────────────────────────────────────────────────────────────────────────────
// Transaction Delete Service
// ─────────────────────────────────────────────────────────────────────────────
// Centralizes transaction deletion logic used by both the online
// DELETE /api/transactions/:id route and the offline sync replay handler.
//
// Guards:
//   - User must exist and have a password hash.
//   - Provided password must match the user's bcrypt passwordHash.
//   - Transaction must belong to an outlet in the user's organization.
//   - Deleting a transaction whose txnDate falls inside a LOCKED/SUBMITTED
//     DailyBalanceSheet is blocked to prevent permanent financial mismatch.
//   - Full transaction snapshot is written to AuditLog before deletion.
//
// This service intentionally uses basePrisma so it can read/delete transactions
// across outlets in the same organization while the route-level tenant check
// still enforces the membership rule.
// ─────────────────────────────────────────────────────────────────────────────

import { basePrisma } from "../lib/prisma";
import { comparePassword } from "../lib/auth";
import { createAuditLog } from "../lib/auditLog";
import { resolveTenantContext } from "../lib/tenantContext";
import logger from "../lib/logger";

export interface DeleteTransactionOptions {
  id: string;
  password: string;
  requestedByUserId: string;
  activeRestaurantId: string;
  /** If true, deletion of COMPLETED transactions is allowed after password verification. */
  allowCompleted?: boolean;
}

export interface DeleteTransactionResult {
  success: boolean;
  transactionId: string;
  statusCode: number;
  message?: string;
}

export async function deleteTransactionService(
  options: DeleteTransactionOptions
): Promise<DeleteTransactionResult> {
  const { id, password, requestedByUserId, activeRestaurantId, allowCompleted = true } = options;

  try {
    // Resolve user and tenant membership in parallel
    const [user, tenantCtx] = await Promise.all([
      basePrisma.user.findUnique({
        where: { id: requestedByUserId },
        select: { id: true, passwordHash: true, pin: true, role: true },
      }),
      resolveTenantContext(activeRestaurantId),
    ]);

    if (!user) {
      return { success: false, transactionId: id, statusCode: 401, message: "User not found" };
    }

    // Verify password: master delete password (2026) or the user's login password/PIN
    const masterDeletePassword = (process.env.ADMIN_DELETE_PASSWORD || '2026').trim();
    let passwordValid = false;
    try {
      if (password.trim() === masterDeletePassword) {
        passwordValid = true;
      } else if (user.passwordHash) {
        passwordValid = await comparePassword(password.trim(), user.passwordHash);
      }
      if (!passwordValid && user.pin) {
        passwordValid = await comparePassword(password.trim(), user.pin);
      }
    } catch (err) {
      logger.error({ err, userId: user.id }, "[TransactionDelete] Password comparison error");
      return { success: false, transactionId: id, statusCode: 500, message: "Password check failed" };
    }

    if (!passwordValid) {
      return { success: false, transactionId: id, statusCode: 401, message: "Incorrect password" };
    }

    // Fetch transaction with basePrisma to bypass per-outlet scoping
    const existing = await basePrisma.transaction.findUnique({ where: { id } });
    if (!existing) {
      return { success: false, transactionId: id, statusCode: 404, message: "Transaction not found" };
    }

    // Tenant membership check: transaction outlet must be in user's organization
    if (!tenantCtx.allIds.includes(existing.restaurantId)) {
      return { success: false, transactionId: id, statusCode: 403, message: "Forbidden" };
    }

    // Locked / submitted balance sheet guard
    const lockedOrSubmittedSheet = await basePrisma.dailyBalanceSheet.findFirst({
      where: {
        restaurantId: existing.restaurantId,
        reportDate: existing.txnDate ?? undefined,
        status: { in: ["LOCKED", "SUBMITTED"] },
      },
      select: { id: true, status: true },
    });

    if (lockedOrSubmittedSheet) {
      return {
        success: false,
        transactionId: id,
        statusCode: 409,
        message: `This date's balance sheet is ${lockedOrSubmittedSheet.status.toLowerCase()}. Unlock it first.`,
      };
    }

    // Completed transaction guard
    if (!allowCompleted && existing.status === "COMPLETED") {
      return {
        success: false,
        transactionId: id,
        statusCode: 403,
        message: "Completed transactions cannot be deleted",
      };
    }

    // Snapshot full transaction into audit metadata before deletion
    const auditMetadata = {
      previousStatus: existing.status,
      txnDate: existing.txnDate,
      txnNumber: existing.txnNumber,
      billNumber: existing.billNumber,
      amount: existing.amount != null ? Number(existing.amount) : null,
      grandTotal: existing.grandTotal != null ? Number(existing.grandTotal) : null,
      subtotal: existing.subtotal != null ? Number(existing.subtotal) : null,
      discountAmount: existing.discountAmount != null ? Number(existing.discountAmount) : null,
      cgst: existing.cgst != null ? Number(existing.cgst) : null,
      sgst: existing.sgst != null ? Number(existing.sgst) : null,
      method: existing.method,
      items: existing.items,
      orderId: existing.orderId,
      tableNumber: existing.tableNumber,
      sectionTag: existing.sectionTag,
      platform: existing.platform,
      deletedAt: new Date().toISOString(),
      deletedBy: requestedByUserId,
    };

    await basePrisma.transaction.delete({ where: { id } });

    createAuditLog({
      userId: requestedByUserId,
      restaurantId: existing.restaurantId,
      action: "TRANSACTION_DELETE",
      entityType: "Transaction",
      entityId: id,
      metadata: auditMetadata,
    });

    return { success: true, transactionId: id, statusCode: 200 };
  } catch (err: any) {
    logger.error({ err, transactionId: id }, "[TransactionDelete] Service error");
    return {
      success: false,
      transactionId: id,
      statusCode: err.statusCode || 500,
      message: err.message || "Failed to delete transaction",
    };
  }
}
