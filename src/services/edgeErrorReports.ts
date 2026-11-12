// ─────────────────────────────────────────────────────────────────────────────
// Edge error reports — errors and refused KOTs sent up by a restaurant PC
// ─────────────────────────────────────────────────────────────────────────────
// Stored as audit-log rows (action EDGE_ERROR / EDGE_EVENT, entityType "edge") so
// they appear in the superadmin console under Audit Logs without a new table.
// A PC stuck in an error loop is capped per restaurant per day so it cannot fill
// the database.
// ─────────────────────────────────────────────────────────────────────────────

export const EDGE_REPORT_ACTIONS = ["EDGE_ERROR", "EDGE_EVENT"] as const;
export const MAX_REPORTS_PER_REQUEST = 50;
export const MAX_REPORTS_PER_DAY = 2000;

const text = (value: unknown, max: number): string => String(value ?? "").slice(0, max);
const whole = (value: unknown): number | null => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);

export interface EdgeErrorReportInput {
  restaurantId: string;
  deviceId?: unknown;
  appVersion?: unknown;
  reports?: unknown;
}

/** Saves the reports; returns how many were stored and how many were dropped. */
export async function recordEdgeErrorReports(
  db: any,
  input: EdgeErrorReportInput,
): Promise<{ accepted: number; dropped: number }> {
  const reports = Array.isArray(input.reports) ? input.reports.slice(0, MAX_REPORTS_PER_REQUEST) : [];
  if (reports.length === 0) return { accepted: 0, dropped: 0 };

  const recent = await db.auditLog.count({
    where: {
      restaurantId: input.restaurantId,
      action: { in: [...EDGE_REPORT_ACTIONS] },
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
  const room = Math.max(0, MAX_REPORTS_PER_DAY - recent);
  const keep = reports.slice(0, room);

  if (keep.length > 0) {
    await db.auditLog.createMany({
      data: keep.map((r: any) => ({
        restaurantId: input.restaurantId,
        action: r?.severity === "info" ? "EDGE_EVENT" : "EDGE_ERROR",
        entityType: "edge",
        entityId: text(input.deviceId, 100) || null,
        metadata: {
          kind: text(r?.kind, 60),
          message: text(r?.message, 500),
          context: r?.context && typeof r.context === "object" ? r.context : null,
          count: whole(r?.count) ?? 1,
          firstAt: whole(r?.firstAt),
          lastAt: whole(r?.lastAt),
          appVersion: text(input.appVersion, 30),
        },
      })),
    });
  }
  return { accepted: keep.length, dropped: reports.length - keep.length };
}
