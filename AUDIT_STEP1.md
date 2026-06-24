# Multi-Tenant Security Audit — Step 1 (read-only)

## Executive Summary

This audit covers `prisma/schema.prisma` and every file in `src/routes/`, `src/lib/`, `src/middleware/`, `src/index.ts`, and `src/socket.ts`. The goal is to identify every place a query trusts a client-supplied ID without verifying tenant ownership via `restaurantId`.

**Critical finding**: Dozens of route handlers accept a resource `:id` and call `prisma.<model>.findUnique({ where: { id } })` without ever checking that the returned row belongs to `req.user.restaurantId`. Cross-tenant data leakage is structurally possible today.

**Secondary finding**: The deletion of the harmful `tenantContext.ts` file in Step 0 has left **broken imports** in `orders.ts`, `print.ts`, `reports.ts`, `analytics.ts`, `stats.ts`, `sections.ts`, `captainAssignments.ts`, `captainTargets.ts`, and `barTables.ts`. The app will not compile until these are removed or replaced.

---

## Part A — Schema Audit

### Models with `restaurantId` column

| Model | Has `restaurantId` | Has `@@unique([restaurantId, id])` | Notes |
|-------|-------------------|-----------------------------------|-------|
| `Restaurant` | N/A (root) | N/A | `@id` on `id`; `@unique` on `slug`, `restaurantCode` |
| `User` | Yes | **NO** | Only `@@index([restaurantId])` |
| `Category` | Yes | **NO** | Only `@@index([restaurantId])`, `@@index([restaurantId, isActive, sortOrder])` |
| `MenuItem` | Yes | **NO** | Only `@@index([restaurantId])`, `@@index([restaurantId, isAvailable, isDeleted])` |
| `MenuItemVariant` | No | N/A | Child of `MenuItem`; scoped implicitly via relation |
| `MenuItemAddon` | No | N/A | Child of `MenuItem`; scoped implicitly via relation |
| `Section` | Yes | **NO** | No indexes at all |
| `Table` | Yes | **NO** | Has `@@unique([restaurantId, sectionId, number])` but **NOT** `@@unique([restaurantId, id])` |
| `Order` | Yes | **NO** | Only `@@index([restaurantId, status])`, `@@index([restaurantId, isDeleted])` |
| `OrderItem` | No | N/A | Child of `Order`; scoped implicitly via relation |
| `Transaction` | Yes | **NO** | Only `@@index([restaurantId])`, `@@index([restaurantId, paidAt])`, `@@index([restaurantId, txnDate])` |
| `DailyCounter` | Yes | Yes | `@@unique([restaurantId, counterDate])` |
| `CaptainAssignment` | Yes | Yes | `@@unique([restaurantId, captainId])` |
| `CaptainTarget` | Yes | Yes | `@@unique([restaurantId, captainId])` |
| `InventoryItem` | Yes | **NO** | Only `@@index([restaurantId])`, `@@index([menuItemId])` |
| `InventoryTransaction` | Yes | **NO** | Only `@@index([restaurantId, transactionDate])`, `@@index([itemId])` |
| `DailyInventorySnapshot` | Yes | Yes | `@@unique([restaurantId, snapshotDate, itemId])` |
| `VenuePrice` | Yes (nullable) | **NO** | `@@unique([venueId, menuItemId])`; `restaurantId` is nullable |
| `GlobalCounter` | N/A | N/A | **Deleted in Step 0** |

### Models that MUST get `@@unique([restaurantId, id])` for safe `findUnique` auto-scoping

1. `User`
2. `Category`
3. `MenuItem`
4. `Section`
5. `Table`
6. `Order`
7. `Transaction`
8. `InventoryItem`
9. `InventoryTransaction`
10. `VenuePrice` (after making `restaurantId` non-nullable)

Child models (`MenuItemVariant`, `MenuItemAddon`, `OrderItem`) do not need this because they are reached through their parent and the parent’s composite unique will enforce scope.

---

## Part B — Route Handler Audit

### Legend

- **Secured** = Query includes `restaurantId` in the `where` clause, or the resource is verified against `req.user.restaurantId` before being returned or mutated.
- **Vulnerable** = Query uses a client-supplied ID (param or body) without verifying `restaurantId` ownership. A user from Restaurant A can access Restaurant B’s data by knowing the UUID.
- **Broken** = Code references the deleted `resolveTenantContext` import and will not compile.

---

### `src/routes/tables.ts`

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /` | `findMany({ where: { restaurantId } })` | query `restaurantId` | `requireRestaurantId()` checks presence but not ownership vs JWT | **Vulnerable** (query param not validated against token) |
| `GET /flat` | `findMany({ where: { restaurantId } })` | query `restaurantId` | Same as above | **Vulnerable** |
| `GET /sections` | `findMany({ where: { restaurantId } })` | query `restaurantId` | Same as above | **Vulnerable** |
| `POST /` | `findFirst({ where: { id: sectionId, restaurantId } })` | body `restaurantId` | `restaurantId` taken from body/query, not validated against JWT | **Vulnerable** |
| `PATCH /:id/status` | `findUnique({ where: { id } })` then `update({ where: { id } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `PATCH /:id/session` | `findUnique({ where: { id } })` then `update({ where: { id } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `PATCH /:id` | `findUnique({ where: { id } })` then `update({ where: { id } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `POST /:id/swap` | `findUnique({ where: { id } })` + `findUnique({ where: { id: targetTableId } })` | `req.params.id`, body `targetTableId` | **No `restaurantId` check on either table** | **Vulnerable** |
| `POST /:id/transfer-items` | Same pattern as swap | `req.params.id`, body `targetTableId` | **No `restaurantId` check** | **Vulnerable** |
| `DELETE /:id` | `findUnique({ where: { id } })` then `delete({ where: { id } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |

**Note**: `tables.ts` is mounted with `authenticate` in `index.ts`, so `req.user` exists, but the route never uses `req.user.restaurantId` to scope the `:id` lookups.

---

### `src/routes/orders.ts` (largest attack surface)

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /table/:tableId` | `findFirst({ where: { tableId, status: {...} } })` | `req.params.tableId` | **No `restaurantId` check** | **Vulnerable** |
| `POST /` (create) | `findFirst({ where: { id: tableId, restaurantId: tenantId } })` | body `tableId` | Uses `tenantId` from body/query, not validated against JWT | **Vulnerable** |
| `PATCH /:id/items` | `findUnique({ where: { id } })` then `assertOrderBelongsToTenant()` | `req.params.id` | `assertOrderBelongsToTenant` uses **deleted** `resolveTenantContext` | **Broken + Vulnerable** |
| `PATCH /:id/status` | `findUnique({ where: { id } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `POST /:id/request-billing` | `findUnique({ where: { id } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `PATCH /:id/settle` | `findUnique({ where: { id } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `PATCH /:id/bill-edit` | `findUnique({ where: { id } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `POST /:id/print-bill` | `findUnique({ where: { id: orderId } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `POST /:id/reprint-kot` | `findUnique({ where: { id: orderId } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `POST /:id/settle` | `findUnique({ where: { id: orderId } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `POST /:id/pay` | `findUnique({ where: { id } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `POST /:id` (update items) | `findUnique({ where: { id } })` then `assertOrderBelongsToTenant()` | `req.params.id` | Uses **deleted** `resolveTenantContext` | **Broken + Vulnerable** |
| `PATCH /:id/cancel-items` | `findUnique({ where: { id } })` | `req.params.id` | **No `restaurantId` check** | **Vulnerable** |
| `POST /terminate-table/:tableId` | `findFirst({ where: { tableId, status: {...} } })` | `req.params.tableId` | **No `restaurantId` check** | **Vulnerable** |

**Note**: `orders.ts` has **~15 broken `resolveTenantContext` imports/usages** that will cause compilation failures.

---

### `src/routes/menu.ts`

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /categories` | `findMany({ where: { restaurantId, isActive: true } })` | query `restaurantId` | `resolveRestaurantId()` pulls from query/body/user; no JWT cross-check | **Vulnerable** |
| `GET /items/admin` | `findMany({ where: { restaurantId, isDeleted: false } })` | query `restaurantId` | Same pattern | **Vulnerable** |
| `GET /items` | `findMany({ where: { restaurantId, ... } })` | query `restaurantId` | Same pattern | **Vulnerable** |
| `GET /pos-view` | `findMany({ where: { restaurantId, ... } })` | query `restaurantId` | Same pattern | **Vulnerable** |
| `PATCH /items/:id/availability` | `findFirst({ where: { id, restaurantId: resolveRestaurantId(req) } })` | `req.params.id` | **Partially secured** — uses `findFirst` with `restaurantId`, but then calls `update({ where: { id } })` without `restaurantId` | **Vulnerable** (update where-clause lacks scope) |
| `POST /items` | `findFirst({ where: { restaurantId, name } })` + `create` | body | `restaurantId` from body/query, not JWT-validated | **Vulnerable** |
| `PATCH /items/:id` | `findFirst({ where: { id, restaurantId } })` then `update({ where: { id } })` | `req.params.id` | **Partially secured** — `findFirst` has scope, but `update({ where: { id } })` does not | **Vulnerable** |
| `DELETE /items/:id` | `findFirst({ where: { id, restaurantId } })` then `update({ where: { id } })` | `req.params.id` | Same pattern | **Vulnerable** |
| `POST /upload-image` | N/A (Cloudinary proxy) | N/A | No DB query | **N/A** |
| `GET /unified` | `findMany({ where: { restaurantId, ... } })` | query `restaurantId` | `restaurantId` from query/user, not JWT-validated | **Vulnerable** |
| `GET /integrity-check` | `findMany({ where: { isDeleted: false } })` | N/A | **No `restaurantId` filter at all** | **Vulnerable** (reads ALL tenants) |

---

### `src/routes/barMenu.ts`

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /items` | `findMany({ where: { restaurantId: barId } })` | query/body/user | `barId` from query/body/user; no JWT cross-check | **Vulnerable** |
| `GET /pos-view` | `findMany({ where: { restaurantId: barId } })` | query/body/user | Same pattern | **Vulnerable** |
| `POST /items` | `findFirst({ where: { restaurantId: barId, name } })` + `create` | body | Same pattern | **Vulnerable** |
| `DELETE /items/:id` | `findFirst({ where: { id, restaurantId: barId } })` then `update({ where: { id } })` | `req.params.id` | `findFirst` scoped, `update` not | **Vulnerable** |
| `PATCH /items/:id` | `findFirst({ where: { id, restaurantId: barId } })` then `update({ where: { id } })` | `req.params.id` | Same pattern | **Vulnerable** |
| `PATCH /items/:id/availability` | Same pattern | `req.params.id` | Same pattern | **Vulnerable** |

---

### `src/routes/barTables.ts`

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /` | `findMany({ where: { restaurantId: resolveBarId(req) } })` | query/body/user | `resolveBarId()` from query/body/user; no JWT validation | **Vulnerable** |
| `GET /flat` | Same | query/body/user | Same | **Vulnerable** |
| `GET /sections` | Same | query/body/user | Same | **Vulnerable** |
| `POST /` | `findFirst({ where: { id: sectionId, restaurantId: resolveBarId(req) } })` | body | Same | **Vulnerable** |
| `PATCH /:id/status` | `findFirst({ where: { id, restaurantId: resolveBarId(req) } })` then `update({ where: { id } })` | `req.params.id` | `findFirst` scoped, `update` not | **Vulnerable** |
| `PATCH /:id/session` | Same pattern | `req.params.id` | Same | **Vulnerable** |
| `PATCH /:id` | `findUnique({ where: { id } })` then `update({ where: { id } })` | `req.params.id` | **No `restaurantId` check at all** | **Vulnerable** |
| `DELETE /:id` | `findFirst({ where: { id, restaurantId: resolveBarId(req) } })` then `delete({ where: { id } })` | `req.params.id` | `findFirst` scoped, `delete` not | **Vulnerable** |
| `POST /terminate-table/:tableId` | `findFirst({ where: { tableId, status: {...} } })` | `req.params.tableId` | **No `restaurantId` check** | **Vulnerable** |

**Note**: `barTables.ts` hardcodes fallback `|| 'bar-001'` on line 475.

---

### `src/routes/barInventory.ts`

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /items` | `findMany({ where: { restaurantId: resolveBarId(req) } })` | query/body/user | `resolveBarId()` not JWT-validated | **Vulnerable** |
| `GET /items/:id` | `findFirst({ where: { id, restaurantId: resolveBarId(req) } })` | `req.params.id` | `findFirst` scoped | **Partially secured** (response is scoped, but no `update` here) |
| `POST /items` | `findFirst({ where: { id: menuItemId, restaurantId: resolveBarId(req) } })` + `findUnique({ where: { menuItemId } })` | body | `findUnique` on `InventoryItem` by `menuItemId` is globally unique, but `menuItemId` lookup is scoped | **Partially secured** |
| `PATCH /items/:id` | `findFirst({ where: { id, restaurantId: resolveBarId(req) } })` then `update({ where: { id } })` | `req.params.id` | `findFirst` scoped, `update` not | **Vulnerable** |
| `DELETE /items/:id` | `findFirst({ where: { id, restaurantId: resolveBarId(req) } })` then `delete({ where: { id } })` | `req.params.id` | `findFirst` scoped, `delete` not | **Vulnerable** |
| `POST /adjust-stock` | `findFirst({ where: { id: itemId, restaurantId: resolveBarId(req) } })` then `update({ where: { id: itemId } })` | body `itemId` | `findFirst` scoped, `update` not | **Vulnerable** |
| `POST /record-purchase` | Same pattern | body `itemId` | Same | **Vulnerable** |
| `GET /transactions` | `findMany({ where: { restaurantId: resolveBarId(req) } })` | query | `resolveBarId()` not JWT-validated | **Vulnerable** |
| `GET /daily-report` | `findMany({ where: { restaurantId: resolveBarId(req) } })` | query | Same | **Vulnerable** |
| `GET /low-stock` | `findMany({ where: { restaurantId: resolveBarId(req) } })` | query | Same | **Vulnerable** |

---

### `src/routes/transactions.ts`

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `POST /` | `create` | body | `restaurantId` from body, not validated against JWT | **Vulnerable** |
| `GET /all` | `findMany({ where: { restaurantId } })` | query `restaurantId` | Not validated against JWT | **Vulnerable** |
| `GET /` | `findMany({ where: { restaurantId, ...date } })` | query `restaurantId` | Not validated against JWT | **Vulnerable** |
| `DELETE /:id` | `findUnique({ where: { id } })` then checks `existing.restaurantId !== String(restaurantId)` | `req.params.id` | **Manually checks after fetch** | **Secured** (only route that explicitly checks ownership) |

---

### `src/routes/print.ts`

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `POST /food-kot` | `findUnique({ where: { id: String(tableId) } })` | body `tableId` | **No `restaurantId` check** | **Vulnerable** |
| `POST /liquor-kot` | `findUnique({ where: { id: String(tableId) } })` | body `tableId` | **No `restaurantId` check** | **Vulnerable** |
| `POST /receipt` | `findUnique({ where: { id: orderId } })` | body `orderId` | **No `restaurantId` check** | **Vulnerable** |
| `POST /final-bill` | N/A (builds from body) | N/A | No DB query | **N/A** |
| `POST /final-bill-emit` | N/A (builds from body) | body `restaurantId` | `restaurantId` from body; uses deleted `resolveTenantContext` | **Broken + Vulnerable** |
| `POST /cancel-bill` | N/A (builds ESC/POS from body) | N/A | No DB query | **N/A** |
| `POST /reprint-by-transaction` | `findUnique({ where: { id: orderId } })` | body `orderId` | **No `restaurantId` check** | **Vulnerable** |

---

### `src/routes/venue.ts`

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /sections` | `findMany({ where: { restaurantId: resolveVenueId(req) } })` | query/body/user | `resolveVenueId()` not JWT-validated | **Vulnerable** |
| `GET /menu` | `findMany({ where: { restaurantId } })` | query `restaurantId` | `restaurantId` from `req.user?.restaurantId` or empty string | **Vulnerable** |
| `GET /table-label/:tableId` | `findFirst({ where: { id: tableId, restaurantId: resolveVenueId(req) } })` | `req.params.tableId` | `findFirst` scoped | **Partially secured** |
| `PUT /prices` | `upsert` on `VenuePrice` | body `venueId`, `menuItemId` | **No `restaurantId` check** | **Vulnerable** |
| `GET /all-prices` | `findMany({ where: { isActive: true } })` | N/A | **No `restaurantId` filter — returns ALL tenants** | **Vulnerable** |
| `POST /backfill-section-tags` | `findMany({ where: { restaurantId: resolveVenueId(req) } })` | body | `resolveVenueId()` not JWT-validated | **Vulnerable** |

**Note**: `venue.ts` header comment says "All sections live under restaurantId = 'venue-001'" — this is a legacy hardcoded assumption that must be eliminated.

---

### `src/routes/auth.ts`

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `POST /login` | `findUnique({ where: { restaurantCode } })` + `findFirst({ where: { email, restaurantId: restaurant.id } })` | body | Looks up by `restaurantCode`, then scopes user lookup | **Secured** (login is inherently cross-tenant lookup by credential) |
| `POST /captain-login` | `findUnique({ where: { id: restaurantId } })` + `findFirst({ where: { id: userId, restaurantId } })` | body | Same pattern | **Secured** (login) |
| `GET /me` | `findUnique({ where: { id: r.user!.userId } })` | token | Scopes to own user ID | **Secured** |
| `POST /forgot-password` | `findUnique({ where: { email } })` | body | No `restaurantId` in query; finds any user by email globally | **Vulnerable** (password-reset token leaks cross-tenant if emails collide) |
| `POST /reset-password` | `findFirst({ where: { resetToken: token } })` | body | No `restaurantId` check | **Vulnerable** |
| `GET /crew` | `findFirst({ where: { OR: [id, slug, restaurantCode] } })` then `findMany({ where: { restaurantId } })` | query `restaurantId` | `restaurantId` resolved from public query param, not JWT | **Vulnerable** (public endpoint by design, but returns all staff) |

---

### `src/routes/restaurant.ts`

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /by-code/:code` | `findUnique({ where: { restaurantCode: code } })` | `req.params.code` | Public lookup by code | **Secured** (public by design) |
| `GET /:slug/staff` | `findFirst({ where: { OR: [slug, restaurantCode] } })` then `findMany({ where: { restaurantId } })` | `req.params.slug` | Public lookup | **Secured** (public by design) |
| `GET /me` | `findUnique({ where: { id: restaurantId } })` | token `restaurantId` | Scopes to JWT restaurantId | **Secured** |

---

### `src/routes/sections.ts` (BROKEN IMPORTS)

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /` | `findMany({ where: { restaurantId } })` | query | `restaurantId` from `ctx.allIds` via deleted `resolveTenantContext` | **Broken + Vulnerable** |
| `POST /` | `create({ data: { name, restaurantId } })` | body | Same | **Broken + Vulnerable** |

---

### `src/routes/stats.ts` (BROKEN IMPORTS)

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /today` | `aggregate({ where: { restaurantId, txnDate } })` | query | `restaurantId` from `ctx.allIds` via deleted `resolveTenantContext` | **Broken + Vulnerable** |

---

### `src/routes/captainAssignments.ts` (BROKEN IMPORTS)

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /` | `findMany({ where: { restaurantId } })` | query | Uses deleted `resolveTenantContext` | **Broken + Vulnerable** |
| `GET /:captainId` | `findUnique({ where: { restaurantId_captainId } })` | `req.params.captainId` | Uses composite unique with `restaurantId` from `ctx.allIds` | **Broken** (composite unique helps, but import is broken) |
| `POST /` | `upsert({ where: { restaurantId_captainId } })` | body | Same | **Broken** |

---

### `src/routes/captainTargets.ts` (BROKEN IMPORTS)

Same patterns as `captainAssignments.ts`; also broken.

---

### `src/routes/reports.ts` (BROKEN IMPORTS)

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /daily-sales` | `findMany({ where: { restaurantId: { in: tenantIds } } })` | query | `tenantIds` from deleted `resolveTenantContext` | **Broken + Vulnerable** |
| `GET /itemwise-sales` | `findMany({ where: { order: { restaurantId: { in: tenantIds } } } })` | query | Same | **Broken + Vulnerable** |
| `GET /categorywise-sales` | Same | query | Same | **Broken + Vulnerable** |
| `GET /payment-methods` | Same | query | Same | **Broken + Vulnerable** |
| `GET /discount-report` | Same | query | Same | **Broken + Vulnerable** |
| `GET /gst-report` | Same | query | Same | **Broken + Vulnerable** |

**Note**: `reports.ts` uses `getOutletName()` which hardcodes `bar`/`venue` detection by string-matching `restaurantId`. This is fragile for multi-tenant.

---

### `src/routes/analytics.ts` (BROKEN IMPORTS)

| Route | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `GET /items-sold` | `findMany({ where: { restaurantId: String(restaurantId) } })` | query | `restaurantId` from `ctx.allIds` via deleted `resolveTenantContext` | **Broken + Vulnerable** |

---

### `src/index.ts` (Socket.io)

| Event | Method | Param | Verification | Status |
|-------|--------|-------|-------------|--------|
| `socket.on("join")` | `resolveTenantContext(decoded.restaurantId)` then `ctx.allIds.includes(room)` | socket handshake | Uses deleted `resolveTenantContext` | **Broken** |
| `socket.on("join:print")` | Same | socket handshake | Uses deleted `resolveTenantContext` | **Broken** |
| `socket.on("waiter:event")` | Checks `socket.rooms.has(room)` | socket data | Relies on prior `join` validation | **Broken** (because join is broken) |

---

## Part C — Summary of Broken Imports

Files that import `../lib/tenantContext` (which was deleted in Step 0) and will fail to compile:

1. `src/routes/orders.ts`
2. `src/routes/print.ts`
3. `src/routes/reports.ts`
4. `src/routes/analytics.ts`
5. `src/routes/stats.ts`
6. `src/routes/sections.ts`
7. `src/routes/captainAssignments.ts`
8. `src/routes/captainTargets.ts`
9. `src/routes/barTables.ts`
10. `src/index.ts`

---

## Part D — Vulnerability Summary by Severity

### Critical (cross-tenant data leakage possible with a UUID)

- `tables.ts` — `PATCH /:id/status`, `PATCH /:id/session`, `PATCH /:id`, `POST /:id/swap`, `POST /:id/transfer-items`, `DELETE /:id`
- `orders.ts` — `GET /table/:tableId`, `PATCH /:id/status`, `POST /:id/request-billing`, `PATCH /:id/settle`, `PATCH /:id/bill-edit`, `POST /:id/print-bill`, `POST /:id/reprint-kot`, `POST /:id/settle`, `POST /:id/pay`, `PATCH /:id/cancel-items`, `POST /terminate-table/:tableId`
- `menu.ts` — `PATCH /items/:id/availability`, `PATCH /items/:id`, `DELETE /items/:id`, `GET /integrity-check`
- `barMenu.ts` — `DELETE /items/:id`, `PATCH /items/:id`, `PATCH /items/:id/availability`
- `barTables.ts` — `PATCH /:id`, `POST /terminate-table/:tableId`
- `barInventory.ts` — `PATCH /items/:id`, `DELETE /items/:id`, `POST /adjust-stock`, `POST /record-purchase`
- `print.ts` — `POST /food-kot`, `POST /liquor-kot`, `POST /receipt`, `POST /reprint-by-transaction`
- `venue.ts` — `PUT /prices`, `GET /all-prices`
- `auth.ts` — `POST /forgot-password`, `POST /reset-password`
- `transactions.ts` — `POST /`, `GET /all`, `GET /` (relies on unvalidated `restaurantId` query param)

### High (broken imports — app will not compile)

All files listed in Part C.

### Medium (tenant scoping relies on client-supplied `restaurantId` instead of JWT)

- Nearly every `GET /` and `POST /` route that accepts `restaurantId` from `req.query` or `req.body` and uses it directly in the Prisma `where` clause without validating it against `req.user.restaurantId`.
- Examples: `tables.ts` `GET /`, `menu.ts` `GET /categories`, `barMenu.ts` `GET /items`, etc.

---

## Part E — Recommended Remediation Path

1. **Add `@@unique([restaurantId, id])`** to every tenant-scoped model (listed in Part A).
2. **Implement a Prisma Client extension** using `AsyncLocalStorage` that auto-injects `restaurantId` into every query’s `where` clause.
3. **Wire Express middleware** (after JWT auth) to set the tenant context from `req.user.restaurantId`.
4. **Remove all `resolveTenantContext` calls** and replace with the extension’s implicit scoping.
5. **Remove hardcoded venue/section IDs** like `section-parcel`, `section-bar-parcel`, `venue-001`, `bar-001`, etc., from `venue.ts`, `barTables.ts`, `print.ts`, and `menu.ts`.
6. **Delete the `orderCreateLimiter` keyGenerator** fallback in `index.ts` that uses `req.body?.restaurantId` without validation.
