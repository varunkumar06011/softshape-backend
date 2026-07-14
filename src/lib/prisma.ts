// ─────────────────────────────────────────────────────────────────────────────
// Prisma Client — Database Access with Automatic Tenant Scoping
// ─────────────────────────────────────────────────────────────────────────────
// Creates two Prisma client instances:
//   1. basePrisma — raw Prisma client without tenant scoping (for system-level
//      operations like seeding, schema probes, and cross-tenant queries in superadmin)
//   2. prisma (default export) — extended Prisma client that AUTOMATICALLY injects
//      restaurantId into all queries for tenant-scoped models when running within
//      a tenantStorage AsyncLocalStorage context.
//
// The tenant scoping works via Prisma's $extends query interceptor:
//   - When tenantStorage has a value (set by withTenantContext middleware),
//     all find*/update/delete/count/aggregate/create/upsert operations on
//     tenant-scoped models automatically get restaurantId added to their where/data.
//   - When no tenant context is active, queries pass through unmodified.
//
// This prevents accidental cross-tenant data access at the ORM level — even if
// a route handler forgets to filter by restaurantId, the Prisma extension enforces it.
//
// Connection pooling:
//   - Uses DATABASE_URL (Supabase transaction pooler, port 6543) for runtime queries.
//   - DIRECT_URL (session pooler, port 5432) is reserved for migrations only.
//   - connection_limit and pool_timeout are configurable via env vars.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "async_hooks";
import logger from "./logger";

// Tenant context type stored in AsyncLocalStorage
export interface TenantStore {
  restaurantId: string;
}

// AsyncLocalStorage instance for per-request tenant isolation.
// The withTenantContext middleware wraps each request in this storage so that
// the Prisma extension can automatically scope queries to the correct restaurant.
export const tenantStorage = new AsyncLocalStorage<TenantStore>();

// Set of Prisma models that have a restaurantId column and should be auto-scoped.
// Models not in this set (e.g. Organization, SuperadminLog) are not tenant-scoped.
const modelsWithRestaurantId = new Set([
  "Category",
  "MenuItem",
  "MenuItemVariant",
  "MenuItemAddon",
  "Section",
  "Table",
  "Order",
  "Transaction",
  "DailyCounter",
  "CaptainAssignment",
  "InventoryItem",
  "InventoryTransaction",
  "DailyInventorySnapshot",
  "VenuePrice",
  "Employee",
  "PayrollRecord",
  "Attendance",
  "PrintQueue",
  "ProcessedRequest",
  "Venue",
  "Floor",
  "PriceProfile",
  "PriceProfileItem",
  "TaxProfile",
  "Expenditure",
  "LedgerCategory",
  "VenueMenuItemAvailability",
  "KitchenInventoryItem",
  "MenuItemRecipe",
  "InventoryDailyEntry",
  "DailyBalanceSheet",
  "OpeningBalance",
  "OpeningBalanceLine",
  "Vendor",
  "PurchaseOrder",
  "PurchaseOrderItem",
  "PurchaseOrderPayment",
  "DailyCogsEntry",
  "FixedAsset",
  "DepreciationEntry",
  "Liability",
  "LiabilityPayment",
  "EquityAdjustment",
  "RepresentativeQR",
  "OrderConflict",
]);

// Checks if a given Prisma model name has a restaurantId column (and should be auto-scoped)
function hasRestaurantId(model: string): boolean {
  return modelsWithRestaurantId.has(model);
}

// ── Conditional scope injection ───────────────────────────────────────────────
// If the caller already specified a restaurantId filter (e.g. { in: [...] } for
// a legitimate cross-outlet query), don't clobber it — but log a warning, since
// inside tenant context this is almost always accidental. Use withOrgScope /
// withOutletScope for intentional cross-outlet queries.
function scopeWhere(args: any, ctx: TenantStore, model: string): void {
  const where = (args as any).where;
  if (where?.restaurantId !== undefined) {
    logger.warn(
      { model, existingFilter: where.restaurantId, sessionOutlet: ctx.restaurantId },
      "[PrismaExtension] Query inside tenant context already specifies restaurantId — leaving as-is. Use withOrgScope/withOutletScope for intentional cross-outlet queries."
    );
    return;
  }
  (args as any).where = { ...where, restaurantId: ctx.restaurantId };
}

// Connection pool configuration — configurable via env vars
const connectionLimit = Number(process.env.PRISMA_CONNECTION_LIMIT) || 50;
const poolTimeout = Number(process.env.PRISMA_POOL_TIMEOUT) || 60;

// Base Prisma client — no tenant scoping. Used for system operations (seeding, schema probes, superadmin).
// Appends connection_limit and pool_timeout query params to the database URL.
const basePrismaInstance = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  datasources: {
    db: {
      // Use DATABASE_URL (transaction pooler, port 6543) for the runtime client.
      // DIRECT_URL (session pooler, port 5432) is reserved for migrations only —
      // the session pool has a hard limit of 25 connections, so using it for both
      // runtime and migrations causes "max clients reached" errors.
      url:
        (process.env.DATABASE_URL || process.env.DIRECT_URL || "") +
        ((process.env.DATABASE_URL || process.env.DIRECT_URL)?.includes("?") ? "&" : "?") +
        `connection_limit=${connectionLimit}&pool_timeout=${poolTimeout}`,
    },
  },
});

// Export the base (unscoped) client for system-level operations
export const basePrisma = basePrismaInstance;

// ── Tenant-Scoped Prisma Extension ───────────────────────────────────────────
// Extends the base client to automatically inject restaurantId into all queries
// on tenant-scoped models when running within a tenantStorage context.
// This is the default export used by all route handlers and lib functions.
const prisma = basePrismaInstance.$extends({
  query: {
    $allModels: {
      async findUnique({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          const result = await query(args);
          if (result && (result as any).restaurantId !== undefined && (result as any).restaurantId !== ctx.restaurantId) {
            logger.warn(
              { model, recordRestaurantId: (result as any).restaurantId, sessionOutlet: ctx.restaurantId },
              "[PrismaExtension] findUnique cross-tenant access blocked"
            );
            return null;
          }
          return result;
        }
        return query(args);
      },
      async findUniqueOrThrow({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          const result = await query(args);
          if (result && (result as any).restaurantId !== undefined && (result as any).restaurantId !== ctx.restaurantId) {
            logger.warn(
              { model, recordRestaurantId: (result as any).restaurantId, sessionOutlet: ctx.restaurantId },
              "[PrismaExtension] findUniqueOrThrow cross-tenant access blocked"
            );
            throw new (require("@prisma/client").PrismaClientKnownRequestError)(
              "No record found for the current tenant",
              { code: "P2025", clientVersion: require("@prisma/client").Prisma.prismaVersion.client }
            );
          }
          return result;
        }
        return query(args);
      },
      async findFirst({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          scopeWhere(args, ctx, model);
        }
        return query(args);
      },
      async findFirstOrThrow({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          scopeWhere(args, ctx, model);
        }
        return query(args);
      },
      async findMany({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          scopeWhere(args, ctx, model);
        }
        return query(args);
      },
      async update({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          const existing = await (basePrismaInstance as any)[model].findUnique({
            where: (args as any).where,
            select: { restaurantId: true },
          });
          if (!existing || existing.restaurantId !== ctx.restaurantId) {
            logger.warn(
              { model, where: (args as any).where, sessionOutlet: ctx.restaurantId },
              "[PrismaExtension] update cross-tenant access blocked"
            );
            throw new (require("@prisma/client").PrismaClientKnownRequestError)(
              "No record found for the current tenant",
              { code: "P2025", clientVersion: require("@prisma/client").Prisma.prismaVersion.client }
            );
          }
        }
        return query(args);
      },
      async updateMany({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          scopeWhere(args, ctx, model);
        }
        return query(args);
      },
      async delete({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          const existing = await (basePrismaInstance as any)[model].findUnique({
            where: (args as any).where,
            select: { restaurantId: true },
          });
          if (!existing || existing.restaurantId !== ctx.restaurantId) {
            logger.warn(
              { model, where: (args as any).where, sessionOutlet: ctx.restaurantId },
              "[PrismaExtension] delete cross-tenant access blocked"
            );
            throw new (require("@prisma/client").PrismaClientKnownRequestError)(
              "No record found for the current tenant",
              { code: "P2025", clientVersion: require("@prisma/client").Prisma.prismaVersion.client }
            );
          }
        }
        return query(args);
      },
      async deleteMany({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          scopeWhere(args, ctx, model);
        }
        return query(args);
      },
      async count({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          scopeWhere(args, ctx, model);
        }
        return query(args);
      },
      async aggregate({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          scopeWhere(args, ctx, model);
        }
        return query(args);
      },
      async create({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).data = { ...(args as any).data, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async createMany({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          const data = Array.isArray((args as any).data) ? (args as any).data : [(args as any).data];
          (args as any).data = data.map((d: any) => ({ ...d, restaurantId: ctx.restaurantId }));
        }
        return query(args);
      },
      async upsert({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          const existing = await (basePrismaInstance as any)[model].findUnique({
            where: (args as any).where,
            select: { restaurantId: true },
          });
          if (existing && existing.restaurantId !== ctx.restaurantId) {
            logger.warn(
              { model, where: (args as any).where, sessionOutlet: ctx.restaurantId },
              "[PrismaExtension] upsert cross-tenant access blocked"
            );
            throw new (require("@prisma/client").PrismaClientKnownRequestError)(
              "No record found for the current tenant",
              { code: "P2025", clientVersion: require("@prisma/client").Prisma.prismaVersion.client }
            );
          }
          (args as any).create = { ...(args as any).create, restaurantId: ctx.restaurantId };
          (args as any).update = { ...(args as any).update, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
    },
  },
});

// Export the tenant-scoped client as default — this is what all route handlers use.
export default prisma;

// ── Explicit Scope Helpers ────────────────────────────────────────────────────
// These helpers return a Prisma client that is explicitly scoped to the given
// outlet(s), bypassing the AsyncLocalStorage extension entirely. The scope is
// injected into every query on tenant-scoped models, so even if a developer
// forgets to write `where: { restaurantId: ... }`, the filter is still applied.
//
// If the caller already specifies `restaurantId` in their where clause, the
// explicit value is respected (not overwritten). The injection is a safety net
// for the case where it's missing entirely.
//
// Usage:
//   const orgPrisma = withOrgScope(organizationId, [outletA, outletB]);
//   await orgPrisma.menuItem.findMany({ where: { isDeleted: false } });
//   // → automatically becomes { where: { isDeleted: false, restaurantId: { in: [outletA, outletB] } } }
//
//   const outletPrisma = withOutletScope(outletA);
//   await outletPrisma.order.findMany({});
//   // → automatically becomes { where: { restaurantId: outletA } }

type ScopeFilter = { restaurantId: string } | { restaurantId: { in: string[] } };

function getScopeId(scope: ScopeFilter): string | null {
  if (typeof scope.restaurantId === 'string') return scope.restaurantId;
  return null;
}

function getScopeIds(scope: ScopeFilter): string[] | null {
  if (typeof scope.restaurantId !== 'string') return scope.restaurantId.in;
  return null;
}

const _outletScopeCache = new Map<string, any>();
const _orgScopeCache = new Map<string, any>();

function injectScopeIntoWhere(args: any, scope: ScopeFilter): void {
  if (!args) return;
  const where = args.where;
  if (!where) {
    args.where = { ...scope };
  } else if (where.restaurantId === undefined) {
    args.where = { ...where, ...scope };
  }
}

function injectScopeIntoData(args: any, scope: ScopeFilter): void {
  if (!args) return;
  if (Array.isArray(args.data)) {
    args.data = args.data.map((d: any) =>
      d.restaurantId === undefined ? { ...d, ...scope } : d
    );
  } else if (args.data && args.data.restaurantId === undefined) {
    args.data = { ...args.data, ...scope };
  }
}

function createScopedClient(scope: ScopeFilter): any {
  return basePrismaInstance.$extends({
    query: {
      $allModels: {
        async findFirst({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoWhere(args, scope);
          return query(args);
        },
        async findFirstOrThrow({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoWhere(args, scope);
          return query(args);
        },
        async findMany({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoWhere(args, scope);
          return query(args);
        },
        async findUnique({ args, query, model }) {
          if (hasRestaurantId(model)) {
            const result = await query(args);
            if (result && (result as any).restaurantId !== undefined) {
              const scopeId = getScopeId(scope);
              const scopeIds = getScopeIds(scope);
              const recordId = (result as any).restaurantId;
              if (scopeId && recordId !== scopeId) return null;
              if (scopeIds && !scopeIds.includes(recordId)) return null;
            }
            return result;
          }
          return query(args);
        },
        async findUniqueOrThrow({ args, query, model }) {
          if (hasRestaurantId(model)) {
            const result = await query(args);
            if (result && (result as any).restaurantId !== undefined) {
              const scopeId = getScopeId(scope);
              const scopeIds = getScopeIds(scope);
              const recordId = (result as any).restaurantId;
              if ((scopeId && recordId !== scopeId) || (scopeIds && !scopeIds.includes(recordId))) {
                throw new (require("@prisma/client").PrismaClientKnownRequestError)(
                  "No record found within the requested scope",
                  { code: "P2025", clientVersion: require("@prisma/client").Prisma.prismaVersion.client }
                );
              }
            }
            return result;
          }
          return query(args);
        },
        async update({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoWhere(args, scope);
          return query(args);
        },
        async updateMany({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoWhere(args, scope);
          return query(args);
        },
        async delete({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoWhere(args, scope);
          return query(args);
        },
        async deleteMany({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoWhere(args, scope);
          return query(args);
        },
        async count({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoWhere(args, scope);
          return query(args);
        },
        async aggregate({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoWhere(args, scope);
          return query(args);
        },
        async create({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoData(args, scope);
          return query(args);
        },
        async createMany({ args, query, model }) {
          if (hasRestaurantId(model)) injectScopeIntoData(args, scope);
          return query(args);
        },
        async upsert({ args, query, model }) {
          if (hasRestaurantId(model)) {
            injectScopeIntoWhere(args, scope);
            const scopeId = getScopeId(scope);
            if (scopeId) {
              if (args.create && (args.create as any).restaurantId === undefined) {
                (args as any).create = { ...(args.create as any), restaurantId: scopeId };
              }
              if (args.update && (args.update as any).restaurantId === undefined) {
                (args as any).update = { ...(args.update as any), restaurantId: scopeId };
              }
            }
          }
          return query(args);
        },
      },
    },
  });
}

export function withOutletScope(outletId: string): typeof basePrisma {
  const cached = _outletScopeCache.get(outletId);
  if (cached) return cached;

  const scoped = createScopedClient({ restaurantId: outletId });
  _outletScopeCache.set(outletId, scoped);
  return scoped;
}

export function withOrgScope(_organizationId: string | undefined, outletIds: string[]): typeof basePrisma {
  const cacheKey = outletIds.slice().sort().join(',');
  const cached = _orgScopeCache.get(cacheKey);
  if (cached) return cached;

  const scoped = createScopedClient({ restaurantId: { in: outletIds } });
  _orgScopeCache.set(cacheKey, scoped);
  return scoped;
}
