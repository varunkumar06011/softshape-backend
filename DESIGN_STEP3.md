# Multi-Tenant Isolation Design Doc — Step 3

## Problem Statement (from Step 1 Audit)

- **No composite unique constraints**: Most tenant-scoped models have `restaurantId` but lack `@@unique([restaurantId, id])`, so `findUnique({ where: { id } })` can resolve rows from any tenant.
- **No tenant verification on `:id` routes**: ~30 route handlers accept a resource UUID and call `findUnique` or `update/delete({ where: { id } })` without ever checking `req.user.restaurantId`.
- **Client-controlled `restaurantId`**: Functions like `resolveRestaurantId(req)` read `req.query.restaurantId` / `req.body.restaurantId` first, allowing a user to inject a cross-tenant ID and bypass the JWT-scoped fallback.
- **Broken imports**: `resolveTenantContext` was deleted in Step 0 cleanup, leaving compilation errors in 10 files.
- **Hardcoded outlet assumptions**: `venue.ts`, `print.ts`, and `barTables.ts` contain hardcoded strings like `venue-001`, `bar-001`, `section-parcel`, etc.

## Goals

1. Any query that filters by `restaurantId` must use the **authenticated user's** `restaurantId`, never a client-supplied one.
2. Any `findUnique` / `update` / `delete` on a tenant-scoped model must include `restaurantId` in the `where` clause.
3. A single, minimal mechanism should enforce #1 and #2 without touching every single route file.
4. No hardcoded tenant IDs anywhere in code or migrations.
5. All Step 2 tests turn green.

## Proposed Architecture

### 1. Prisma Client Extension (Auto-Scoping)

Instead of modifying every route file, we extend the Prisma Client with an `$extends` middleware that automatically injects `restaurantId` into every query's `where` clause for models that have a `restaurantId` field.

```ts
// src/lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "async_hooks";

export const tenantStorage = new AsyncLocalStorage<{ restaurantId: string }>();

function autoScopeQueries(client: PrismaClient) {
  return client.$extends({
    query: {
      $allModels: {
        async findUnique({ args, query, model }) {
          const ctx = tenantStorage.getStore();
          if (ctx && "restaurantId" in (args.where || {})) {
            // Model has restaurantId field in schema
            args.where = { ...args.where, restaurantId: ctx.restaurantId };
          }
          return query(args);
        },
        async findFirst({ args, query, model }) {
          const ctx = tenantStorage.getStore();
          if (ctx && hasRestaurantId(model)) {
            args.where = { ...args.where, restaurantId: ctx.restaurantId };
          }
          return query(args);
        },
        async findMany({ args, query, model }) {
          const ctx = tenantStorage.getStore();
          if (ctx && hasRestaurantId(model)) {
            args.where = { ...args.where, restaurantId: ctx.restaurantId };
          }
          return query(args);
        },
        async update({ args, query, model }) {
          const ctx = tenantStorage.getStore();
          if (ctx && hasRestaurantId(model)) {
            args.where = { ...args.where, restaurantId: ctx.restaurantId };
          }
          return query(args);
        },
        async updateMany({ args, query, model }) {
          const ctx = tenantStorage.getStore();
          if (ctx && hasRestaurantId(model)) {
            args.where = { ...args.where, restaurantId: ctx.restaurantId };
          }
          return query(args);
        },
        async delete({ args, query, model }) {
          const ctx = tenantStorage.getStore();
          if (ctx && hasRestaurantId(model)) {
            args.where = { ...args.where, restaurantId: ctx.restaurantId };
          }
          return query(args);
        },
        async deleteMany({ args, query, model }) {
          const ctx = tenantStorage.getStore();
          if (ctx && hasRestaurantId(model)) {
            args.where = { ...args.where, restaurantId: ctx.restaurantId };
          }
          return query(args);
        },
      },
    },
  });
}

function hasRestaurantId(model: string): boolean {
  const modelsWithRestaurantId = new Set([
    "User", "Category", "MenuItem", "Section", "Table", "Order",
    "Transaction", "DailyCounter", "CaptainAssignment", "CaptainTarget",
    "InventoryItem", "InventoryTransaction", "DailyInventorySnapshot", "VenuePrice",
  ]);
  return modelsWithRestaurantId.has(model);
}

const basePrisma = new PrismaClient();
export const prisma = autoScopeQueries(basePrisma);
```

**Benefits**:
- Zero changes to route files for basic `findUnique`/`update`/`delete` scoping.
- Only one place to audit for scoping logic.
- Works for both authenticated API routes and background jobs (just wrap the job in `tenantStorage.run()`).

**Limitations**:
- Does NOT prevent a route from explicitly overriding `restaurantId` in the Prisma call (we'll catch those in code review).
- Does NOT scope raw queries (`$queryRaw`, `$executeRaw`).
- Does NOT scope `include` / `nested` reads unless the parent query is already scoped.

### 2. Express Middleware to Set Tenant Context

A single middleware runs immediately after `authenticate`. It extracts `req.user.restaurantId` and stores it in `AsyncLocalStorage`.

```ts
// src/middleware/tenantContext.ts
import { tenantStorage } from "../lib/prisma";
import { Request, Response, NextFunction } from "express";

export function withTenantContext(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user?.restaurantId) {
    return next(); // Unauthenticated routes proceed without scoping
  }
  tenantStorage.run({ restaurantId: user.restaurantId }, next);
}
```

**Mount order in `src/index.ts`**:
```ts
app.use("/api/menu", authenticate, withTenantContext, menuRouter);
app.use("/api/orders", authenticate, withTenantContext, ordersRouter);
app.use("/api/tables", authenticate, withTenantContext, tablesRouter);
// ... etc
```

**Important**: Routes that currently accept `restaurantId` from `req.query` or `req.body` must stop doing so. The middleware guarantees `restaurantId` comes from the JWT. Any explicit `restaurantId` in a Prisma `where` clause will be redundant (and harmless) because the extension will override it with the AsyncLocalStorage value.

### 3. Schema Changes

Add `@@unique([restaurantId, id])` to every model that has `restaurantId` and is queried by `id`:

```prisma
model User {
  // ... existing fields
  @@index([restaurantId])
  @@unique([restaurantId, id])        // NEW
}

model Category {
  // ... existing fields
  @@index([restaurantId])
  @@unique([restaurantId, id])        // NEW
}

model MenuItem {
  // ... existing fields
  @@index([restaurantId])
  @@unique([restaurantId, id])        // NEW
}

model Section {
  // ... existing fields
  @@unique([restaurantId, id])        // NEW
}

model Table {
  // ... existing fields
  @@unique([restaurantId, sectionId, number])
  @@unique([restaurantId, id])        // NEW
}

model Order {
  // ... existing fields
  @@index([restaurantId, status])
  @@unique([restaurantId, id])        // NEW
}

model Transaction {
  // ... existing fields
  @@index([restaurantId])
  @@unique([restaurantId, id])        // NEW
}

model InventoryItem {
  // ... existing fields
  @@index([restaurantId])
  @@unique([restaurantId, id])        // NEW
}

model InventoryTransaction {
  // ... existing fields
  @@index([restaurantId])
  @@unique([restaurantId, id])        // NEW
}

model DailyInventorySnapshot {
  // ... existing fields
  @@unique([restaurantId, snapshotDate, itemId])
  @@unique([restaurantId, id])        // NEW
}
```

`VenuePrice` already has `@@unique([venueId, menuItemId])`. We will also add `@@unique([restaurantId, id])` after making `restaurantId` non-nullable (see below).

`Restaurant`, `MenuItemVariant`, `MenuItemAddon`, `OrderItem`, `DailyCounter`, `CaptainAssignment`, `CaptainTarget` do not need `@@unique([restaurantId, id])` because:
- `Restaurant` is the root tenant table.
- Child models (`MenuItemVariant`, `MenuItemAddon`, `OrderItem`) are reached through their parent.
- `DailyCounter`, `CaptainAssignment`, `CaptainTarget` already have their own composite uniques.

### 4. `VenuePrice.restaurantId` Non-Nullable

Currently `VenuePrice.restaurantId` is `String?`. Change to `String` and backfill existing rows with the `menuItem.restaurantId` value.

```prisma
model VenuePrice {
  id           String   @id @default(uuid())
  venueId      String
  menuItemId   String
  price        Decimal  @default(0)
  isActive     Boolean  @default(true)
  restaurantId String   // CHANGED: was String?
  @@unique([venueId, menuItemId])
  @@unique([restaurantId, id])      // NEW
}
```

This requires a migration that backfills `restaurantId` on existing rows by looking up the associated `MenuItem`.

### 5. Code Changes by File

| File | Changes |
|------|---------|
| `src/lib/prisma.ts` | Add `tenantStorage` and `$extends` auto-scoping. Export the scoped `prisma` client. |
| `src/middleware/tenantContext.ts` | **NEW** — `withTenantContext` middleware. |
| `src/index.ts` | Mount `withTenantContext` after `authenticate` on all protected route prefixes. Remove `orderCreateLimiter` fallback that reads `req.body?.restaurantId`. Remove `resolveTenantContext` imports and all usages. |
| `prisma/schema.prisma` | Add `@@unique([restaurantId, id])` to models listed above. Make `VenuePrice.restaurantId` non-nullable. |
| `src/routes/tables.ts` | Remove `requireRestaurantId` that reads from `req.query`. All `:id` routes now auto-scoped by extension. Remove explicit `restaurantId` from `create` calls (it will be injected). |
| `src/routes/menu.ts` | Remove `resolveRestaurantId` function. All `findMany` / `findFirst` / `update` / `delete` auto-scoped. Remove explicit `restaurantId` from `create` calls. |
| `src/routes/orders.ts` | Remove `resolveTenantContext` import and `assertOrderBelongsToTenant`. All order queries auto-scoped. Remove `restaurantId` from `create` calls. |
| `src/routes/barMenu.ts` | Remove `resolveBarId`. All queries auto-scoped. |
| `src/routes/barTables.ts` | Remove `resolveBarId`. All queries auto-scoped. Remove hardcoded `|| 'bar-001'` fallback. |
| `src/routes/barInventory.ts` | Remove `resolveBarId`. All queries auto-scoped. |
| `src/routes/transactions.ts` | Remove manual `restaurantId` check in `DELETE /:id` (extension handles it). Remove `restaurantId` from `create` calls. |
| `src/routes/print.ts` | Remove `resolveTenantContext` import and `isBarOutlet` / `isVenueOutlet` calls. Use plain `restaurantId` from the order/table row. |
| `src/routes/reports.ts` | Remove `resolveTenantContext` import and `getTenantRestaurantIds`. Reports will be scoped to the single authenticated `restaurantId` (no cross-outlet reporting for now; can be re-added later with explicit design). |
| `src/routes/analytics.ts` | Remove `resolveTenantContext` import. Scope to single `restaurantId`. |
| `src/routes/stats.ts` | Remove `resolveTenantContext` import. Scope to single `restaurantId`. |
| `src/routes/sections.ts` | Remove `resolveTenantContext` import. All queries auto-scoped. |
| `src/routes/captainAssignments.ts` | Remove `resolveTenantContext` import. Use `req.user.restaurantId` directly. |
| `src/routes/captainTargets.ts` | Remove `resolveTenantContext` import. Use `req.user.restaurantId` directly. |
| `src/routes/venue.ts` | Remove all hardcoded section IDs (`section-parcel`, `section-bar-parcel`, etc.). Replace `resolveVenueId` with `req.user.restaurantId` or query param validated against it. `GET /all-prices` must add `restaurantId` filter. |
| `src/routes/auth.ts` | `forgot-password` and `reset-password` must require `restaurantId` in the request and verify the user belongs to that restaurant before sending a reset email. |
| `src/socket.ts` / `src/index.ts` socket handlers | Remove `resolveTenantContext` from socket `join` events. Validate `room` against `decoded.restaurantId` directly. |

### 6. Migration Order

1. **Schema migration**: Add `@@unique([restaurantId, id])` to all models, make `VenuePrice.restaurantId` non-nullable.
   - Generate migration: `prisma migrate dev --name add_composite_uniques`
   - The migration SQL will create the new unique indexes.
   - For `VenuePrice`, the migration SQL must update existing rows: `UPDATE "VenuePrice" SET "restaurantId" = sub."restaurantId" FROM (SELECT v.id, m."restaurantId" FROM "VenuePrice" v JOIN "MenuItem" m ON v."menuItemId" = m.id WHERE v."restaurantId" IS NULL) sub WHERE "VenuePrice".id = sub.id;` before making the column `NOT NULL`.
2. **Code changes**: Implement the Prisma extension, `withTenantContext` middleware, and update all route files (batch by route prefix).
3. **Test run**: `npm test` — all Step 2 tests should turn green.
4. **Manual smoke test**: Run the dev server, verify login, create an order, settle it.

## What We Are NOT Changing

- **No new tables or models** (except the unique indexes).
- **No changes to frontend**.
- **No changes to onboarding flow**.
- **No Outlet model refactoring**.
- **No raw SQL query changes** (unless they are explicitly tenant-scoped already).

## Test Expectations After Implementation

All 9 Step 2 tests will pass:
- Tables `PATCH /:id/status`, `PATCH /:id/session`, `PATCH /:id`, `DELETE /:id` → 404
- Menu `PATCH /items/:id/availability`, `PATCH /items/:id`, `DELETE /items/:id` → 404 (even with injected `restaurantId`)
- Transactions `DELETE /:id` → 403 (already passing)
- Auth `POST /forgot-password` → 400/404 (not 200)
