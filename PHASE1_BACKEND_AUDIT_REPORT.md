# Phase 1 Backend Audit Report — Critical Errors & API Flow Issues

**Audited:** `softshape-backend/src` (Express + Prisma + Socket.io)
**Date:** 2026-06-26
**Method:** Static code review of routes, middleware, schema, services, and utilities

---

## Severity Legend
- **CRITICAL** — Will cause crashes, data corruption, security breaches, or production downtime
- **HIGH** — Will cause feature failures, incorrect business logic, or data inconsistency
- **MEDIUM** — Will cause degraded UX, performance issues, or maintenance burden
- **LOW** — Code smell, minor inconsistency, or defensive-coding gap

---

## 1. CRITICAL ISSUES

### 1.1 `process.exit(1)` on DB schema probe failure will crash the server on every startup if any column is missing
**File:** `src/index.ts:508`
**Issue:** The `probeDbSchema()` function calls `process.exit(1)` if any checked column/table is missing. This is a startup blocker — if a single non-critical column is missing (e.g., `VenuePrice` table on an older tenant), the entire backend crashes instead of running migrations or warning.
**Impact:** Complete downtime on any schema drift, even for features a tenant doesn't use.
**Fix:** Remove `process.exit(1)`; log a loud warning and emit a health-check flag instead.

### 1.2 `barMenuRouter` has ZERO auth/tenant/subscription guards
**File:** `src/index.ts:257`
**Issue:** `app.use("/api/bar/menu", barMenuRouter)` — no `authenticate`, no `assertTenantScope`, no `assertSubscriptionActive`, no `withTenantContext`. Anyone can read/write bar menu data for ANY restaurant by guessing IDs.
**Impact:** Data leak + unauthorized mutation of bar menus across tenants.
**Fix:** Add middleware chain: `authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext`.

### 1.3 `printRouter` has ZERO auth guards
**File:** `src/index.ts:260`
**Issue:** `app.use("/api/print", printRouter)` — no `authenticate`. Any unauthenticated caller can trigger print jobs, read receipts, and emit socket events to any restaurant room.
**Impact:** Unauthorized print spam, receipt data exposure, socket event injection.
**Fix:** Add `authenticate` middleware. Individual endpoints like `qz-sign` that need public access should be exempted inside the router.

### 1.4 `superadminRouter` has ZERO auth guards at the index level
**File:** `src/index.ts:273`
**Issue:** `app.use("/api/superadmin", superadminRouter)` — while the router has its own `requireSuperAdmin`, the route is exposed without any Express-level auth. The `requireSuperAdmin` only checks `x-superadmin-secret` header. If `SUPERADMIN_SECRET` is undefined, any request passes because `!SUPERADMIN_SECRET || secret !== SUPERADMIN_SECRET` evaluates to `true` when `SUPERADMIN_SECRET` is falsy.
**Impact:** If env var is missing, full superadmin access is open to anyone.
**Fix:** Ensure `SUPERADMIN_SECRET` is mandatory at startup (throw if missing). Add `authenticate` before `requireSuperAdmin`.

### 1.5 `kitchenInventoryRouter` has no `assertSubscriptionActive`
**File:** `src/index.ts:264`
**Issue:** `app.use("/api/inventory/kitchen", authenticate, kitchenInventoryRouter)` — missing `assertSubscriptionActive` and `assertTenantScope`. Any authenticated user (even from a suspended tenant) can access/modify kitchen inventory.
**Impact:** Subscription bypass + potential cross-tenant data access.
**Fix:** Add `assertTenantScope, assertSubscriptionActive, withTenantContext`.

### 1.6 `payrollRouter` has no `assertSubscriptionActive` or `assertTenantScope`
**File:** `src/index.ts:263`
**Issue:** `app.use("/api/payroll", authenticate, payrollRouter)` — missing subscription and tenant scope checks.
**Impact:** Suspended tenants can still manage payroll; no cross-tenant guard.
**Fix:** Add `assertTenantScope, assertSubscriptionActive, withTenantContext`.

### 1.7 `onboardRouter` Razorpay webhook uses `req.body` as Buffer but `express.json()` runs BEFORE the raw body middleware for this route
**File:** `src/index.ts:141`
**Issue:** The raw body middleware `express.raw({ type: "application/json" })` is applied to `/api/onboard/payment/razorpay-webhook`, BUT `express.json()` is called at line 142 — AFTER the raw middleware. Wait, actually the raw middleware is at line 141 and `express.json()` is at line 142, so the raw middleware runs first for that specific path. That seems correct.
BUT inside `src/routes/onboard.ts:526`, the code does `const body = req.body as Buffer;` then `JSON.parse(body.toString())`. If `express.raw()` is used, `req.body` is indeed a Buffer. However, if someone accidentally reorders middleware, this breaks. The current order is correct, so this is LOW severity.
Actually, re-reading: the raw middleware is `app.use("/api/onboard/payment/razorpay-webhook", express.raw(...))` and then `app.use(express.json())` on line 142. Since Express middleware runs in order, the raw body middleware runs first for that path, then `express.json()` would also run on the same path because it's not excluded. This means `req.body` would be overwritten by `express.json()` to a parsed object, NOT a Buffer.
**Impact:** The Razorpay webhook will fail because `req.body` will be a parsed JS object, not a Buffer, and `JSON.parse(body.toString())` may still work (since `.toString()` on a plain object gives `[object Object]`), but the HMAC signature verification will fail because the raw body string is lost.
**Fix:** Move `express.json()` BEFORE the raw middleware, OR exclude the webhook path from `express.json()`. Correct order:
```ts
app.use(express.json()); // general
app.use("/api/onboard/payment/razorpay-webhook", express.raw({ type: "application/json" })); // overrides for specific path
```
Actually no — Express runs matching middleware in order. If `express.json()` is registered first, it will match `/api/onboard/payment/razorpay-webhook` too and parse the body. Then the raw middleware won't help because the body stream is already consumed.
The CORRECT pattern is:
```ts
app.use("/api/onboard/payment/razorpay-webhook", express.raw({ type: "application/json" }));
app.use(express.json());
```
But the current code HAS this order. However, `express.json()` doesn't have a path filter, so it ALSO runs for `/api/onboard/payment/razorpay-webhook`. Since middleware runs in registration order, raw runs first, then json runs second and OVERRIDES req.body.
**This IS a CRITICAL bug.** The signature verification will fail because the raw body is lost.

### 1.8 `orderCreateLimiter` uses `jwt.verify()` with `process.env.JWT_SECRET!` but `JWT_SECRET` could theoretically be undefined
**File:** `src/index.ts:174`
**Issue:** `jwt.verify(token, process.env.JWT_SECRET!)` — the `!` suppresses TypeScript but doesn't protect at runtime. If `JWT_SECRET` is undefined, `jwt.verify` will throw. The catch block silently falls through, but this is only in rate limiting, not auth.
**Impact:** Rate limiter falls back to IP-based limiting if JWT_SECRET is missing. Not critical by itself, but indicates poor env validation.
**Fix:** Already handled by auth.ts throwing on missing JWT_SECRET, so this is defensive only.

---

## 2. HIGH ISSUES

### 2.1 `orders.ts` — `print-bill` endpoint does not verify caller owns the order
**File:** `src/routes/orders.ts:1187-1440`
**Issue:** The `POST /:id/print-bill` endpoint takes `restaurantId` from `req.query` but never validates that the order actually belongs to that restaurant. A malicious actor with a valid order ID from another tenant could print bills.
**Fix:** Add `assertOrderBelongsToTenant(orderId, restaurantId)` check.

### 2.2 `orders.ts` — `reprint-kot` endpoint has NO auth at all
**File:** `src/routes/orders.ts:1443-1536`
**Issue:** `router.post("/:id/reprint-kot", async (req, res) => { ... })` — no `authenticate`, no `assertTenantScope`. Any unauthenticated user can reprint KOTs if they know an order ID.
**Fix:** Add `authenticate` and validate order ownership.

### 2.3 `orders.ts` — `settle` endpoint trusts frontend-calculated totals without full server-side recalculation inside transaction
**File:** `src/routes/orders.ts:1538-2069`
**Issue:** The settle endpoint accepts `bodyGrandTotal`, `bodySubtotal`, etc. from the frontend and only validates them within ±0.50. A frontend bug or manipulation could result in incorrect transaction records.
**Fix:** Always compute totals server-side inside the transaction and ignore frontend values. Use frontend values only for display/comparison, not for DB writes.

### 2.4 `orders.ts` — `pay` endpoint has no tenant scope or subscription check
**File:** `src/routes/orders.ts:2071-2354`
**Issue:** `router.post("/:id/pay", ...)` has no `assertTenantScope` or `assertSubscriptionActive`. It's behind the route-level middleware in `index.ts` which has those checks, BUT wait — the orders router is mounted WITH those checks in index.ts:
`app.use("/api/orders", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, ordersRouter);`
So this IS protected. However, the `print-bill`, `reprint-kot`, and some other sub-routes that use `req.query.restaurantId` bypass the injected `req.body.restaurantId` from `assertTenantScope`. They should still use the route-level auth.
Actually, `reprint-kot` at line 1443 has NO `authenticate` middleware on the individual route, but the parent router IS protected by `authenticate` at the index level. So it IS authenticated. But it doesn't validate order ownership.

### 2.5 `orders.ts` — `getNextBillNumber` uses raw SQL with `gen_random_uuid()` which may not exist in all PostgreSQL versions
**File:** `src/routes/orders.ts:312-321`
**Issue:** `gen_random_uuid()` is a PostgreSQL 13+ feature. If running on an older version, this fails.
**Impact:** Bill number generation crashes on older PostgreSQL.
**Fix:** Use `uuid_generate_v4()` extension or Prisma's `cuid()` / `uuid()` client-side.

### 2.6 `orders.ts` — `kotEntryFromItems` uses `String(kotNumber).padStart(2, '0')` for `id` which causes duplicate KOT IDs per day
**File:** `src/routes/orders.ts:166`
**Issue:** KOT entries use `String(kotNumber).padStart(2, '0')` as the `id` field. If there are 100+ KOTs in a day, IDs go "01", "02", ..., "99", "100". The `id` is just a display string, but it's stored in JSON `kotHistory` and used for reprint matching. Not truly unique.
**Impact:** Not critical but could cause confusion in reprint logic.
**Fix:** Use actual unique IDs + display numbers.

### 2.7 `auth.ts` — `forgot-password` uses `Math.random()` for reset token
**File:** `src/routes/auth.ts:305`
**Issue:** `Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)` — `Math.random()` is NOT cryptographically secure. Reset tokens could be predicted.
**Impact:** Account takeover via predictable reset tokens.
**Fix:** Use `crypto.randomBytes(32).toString('hex')` or `crypto.randomUUID()`.

### 2.8 `auth.ts` — `/me` endpoint has `requireAuth as any` then wraps handler in IIFE without `await`
**File:** `src/routes/auth.ts:238-270`
**Issue:** The route handler is synchronous: `(req: Request, res: Response) => { (async () => { ... })(); }`. If the async IIFE throws, the error is an unhandled rejection, NOT caught by the Express error handler. Also, `requireAuth` is imported from `../lib/auth` (different from `authenticate`), and it's cast with `as any`.
**Impact:** Unhandled promise rejections on DB errors in `/me`.
**Fix:** Make the handler `async` directly: `router.get('/me', requireAuth as any, async (req, res) => { ... })`.

### 2.9 `auth.ts` — `refresh` endpoint signs token with `user.email!` but `email` is nullable in Prisma schema
**File:** `src/routes/auth.ts:429-437`
**Issue:** `email: user.email!` — `email` is `String?` in the User model. If a captain (who may not have an email) tries to refresh, this could cause issues.
**Impact:** Token refresh may include `undefined` email, causing downstream JWT parsing issues.
**Fix:** Use `email: user.email || undefined` or ensure email is always present for refresh.

### 2.10 `menu.ts` — `upsertVenuePrices` uses `prisma.venuePrice.upsert` without `restaurantId` in the WHERE clause
**File:** `src/routes/menu.ts:44-53`
**Issue:** The upsert uses `where: { venueId_menuItemId: { venueId, menuItemId } }` — the unique index is `@@unique([venueId, menuItemId])`. But `restaurantId` is only in `create` data. If two restaurants share the same `venueId` and `menuItemId` (unlikely but possible if venueIds are not globally unique), there's a collision risk. More importantly, the `restaurantId` in `create` comes from the authenticated user, but the WHERE clause doesn't scope to that restaurant, so if a venuePrice exists for another restaurant with the same venueId+menuItemId, it updates THAT record instead of creating a new one.
**Impact:** Cross-tenant venue price corruption.
**Fix:** Add `restaurantId` to the WHERE clause, or ensure venue IDs are globally unique per restaurant.

### 2.11 `menu.ts` — GET `/items/admin` and `/items` use `req.query.restaurantId` without validation when `req.user` is absent
**File:** `src/routes/menu.ts:63, 214`
**Issue:** `const restaurantId = (req.query.restaurantId as string) || (req.user?.restaurantId as string) || ""` — if neither is present, `restaurantId` becomes `""`, which could leak data or return empty results incorrectly. The route has `optionalAuth` for GETs, so unauthenticated requests with a missing `restaurantId` query param get `""` and Prisma returns nothing. Not a leak, but a confusing API behavior.
**Impact:** Degraded UX — queries with missing params return empty arrays silently.
**Fix:** Return 400 if `restaurantId` is empty after resolution.

### 2.12 `transactions.ts` — GET `/all` and `/` have no auth at all
**File:** `src/routes/transactions.ts:95-196`
**Issue:** The router is mounted with auth middleware in `index.ts`:
`app.use("/api/transactions", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, transactionRoutes);`
So auth IS present. However, the route uses `req.query.restaurantId` directly without `req.user.restaurantId` fallback. If `assertTenantScope` injects `req.body.restaurantId` but GET requests don't have a body, then `req.query.restaurantId` must be present. If missing, the route returns 400. This is acceptable behavior.

### 2.13 `onboard.ts` — cleanup on partial failure only deletes restaurants, not users created before the restaurant
**File:** `src/routes/onboard.ts:503-513`
**Issue:** The cleanup loop deletes `createdRestaurantIds`, but the owner user is created BEFORE the restaurant (line 358). If the restaurant creation succeeds but a later step fails, the cleanup deletes the restaurant but leaves the owner user as an orphan.
**Impact:** Orphan user records in the database.
**Fix:** Track created user IDs and delete them in cleanup too.

### 2.14 `onboard.ts` — `restaurantCode` allocation uses `Math.random()` for 6-char codes with only 10 attempts
**File:** `src/routes/onboard.ts:14-25`
**Issue:** `allocateRestaurantCode()` uses `Math.random()` and only 10 attempts. With ~36^6 ≈ 2.1 billion possible codes, collision is unlikely, but `Math.random()` is not CSPRNG. More importantly, 10 attempts is too few — under high concurrent load, collisions could exhaust retries.
**Impact:** Onboarding fails under concurrent load with "Failed to allocate unique restaurantCode after 10 attempts".
**Fix:** Use `crypto.randomBytes()` and increase attempts to 100.

### 2.15 `onboard.ts` — `generateUniqueSlug` does not use a transaction, causing race-condition slug collisions
**File:** `src/routes/onboard.ts:247-255`
**Issue:** The slug generation does `while (await tx.restaurant.findUnique({ where: { slug } }))` in a loop, but it's called outside any transaction, and even inside the onboarding handler there's no transaction wrapping the entire flow.
**Impact:** Two concurrent onboardings could generate the same slug before either creates the restaurant, causing a unique constraint violation on one of them.
**Fix:** Wrap slug generation and restaurant creation in a transaction, or use a retry loop around the entire creation.

### 2.16 `barMenu.ts` — GET `/items` and `/pos-view` have no `restaurantId` filter in queries
**File:** `src/routes/barMenu.ts:52-118`
**Issue:** `prisma.menuItem.findMany({ where: { isDeleted: false, category: { isActive: true } } })` — NO `restaurantId` filter. This returns ALL bar menu items across ALL tenants.
**Impact:** Cross-tenant data leak — any authenticated user can see every other restaurant's bar menu.
**Fix:** Add `restaurantId: resolveBarId(req)` to the where clause.

### 2.17 `barMenu.ts` — POST `/items` uses `getUserRestaurantId(req) ?? ''` which falls back to empty string
**File:** `src/routes/barMenu.ts:121-150`
**Issue:** If `req.user` is undefined (shouldn't happen because `authenticate` is applied), `restaurantId` becomes `""`, and the category is created for an empty restaurantId. More importantly, the route doesn't check if the `category` belongs to the requesting restaurant.
**Impact:** Potential cross-tenant category pollution.
**Fix:** Validate category ownership or create categories scoped to the restaurant.

### 2.18 `tables.ts` — GET `/` uses `req.user?.restaurantId` which is undefined for unauthenticated requests, but route has no auth
**File:** `src/routes/tables.ts:99-120`
**Issue:** The `tablesRouter` is mounted with auth in `index.ts`:
`app.use("/api/tables", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, tablesRouter);`
So this IS protected. Not an issue.

### 2.19 `print.ts` — `cancel-bill` endpoint has NO auth
**File:** `src/routes/print.ts:597`
**Issue:** `router.post("/cancel-bill", async (req, res) => { ... })` — no `authenticate`. The print router is mounted without auth in `index.ts`.
**Impact:** Anyone can trigger cancel-bill print jobs.
**Fix:** Add `authenticate` middleware to all print routes except truly public ones.

### 2.20 `print.ts` — `receipt` endpoint auth check is weak — only checks `authRestaurantId` if present
**File:** `src/routes/print.ts:263-366`
**Issue:** `if (authRestaurantId && order.restaurantId !== authRestaurantId)` — if `authRestaurantId` is undefined (e.g., old frontend without auth), the check is skipped entirely for "backward compat". This backward compat is a security hole.
**Impact:** Unauthenticated access to any order's receipt data.
**Fix:** Remove backward compat skip; require auth unconditionally.

### 2.21 `verification.ts` — `resend` instance created with dummy key if env var missing
**File:** `src/routes/verification.ts:10`
**Issue:** `const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy_key_to_prevent_crash")` — the dummy key prevents a crash at module load, but attempts to send email will fail silently or throw at runtime. The code does check `process.env.RESEND_API_KEY` before sending, but the dummy key approach is misleading.
**Impact:** Confusing behavior — module loads fine but emails fail.
**Fix:** Only instantiate Resend when needed, or handle the missing key more explicitly.

### 2.22 `verification.ts` — Email OTP has no rate-limiting on verification attempts
**File:** `src/routes/verification.ts:65-89`
**Issue:** `/email/verify` has no rate limiter. An attacker can brute-force the 6-digit OTP (1 million combinations) without any throttling beyond the 5-attempt cache key.
**Impact:** OTP brute-force is possible within the 5-minute window.
**Fix:** Add express-rate-limit to the verify endpoint, or implement exponential backoff.

### 2.23 `tenantContext.ts` — `withTenantContext` runs `next()` inside `tenantStorage.run()` but if `next()` throws, the error is lost
**File:** `src/middleware/tenantContext.ts:4-11`
**Issue:** `tenantStorage.run({ restaurantId: user.restaurantId }, next)` — if `next()` throws synchronously, it's caught by Express. But if an async error occurs, the async local storage context may leak or not propagate correctly. This is a minor concern with AsyncLocalStorage.
**Impact:** Potential tenant context leakage in error scenarios.
**Fix:** Use `next()` callback pattern correctly; AsyncLocalStorage should handle this, but verify with tests.

### 2.24 `prisma.ts` — Tenant-scoped `findUnique`/`update` mutations silently add `restaurantId` to WHERE, breaking lookups by non-restaurantId unique fields
**File:** `src/lib/prisma.ts:57-128`
**Issue:** The Prisma extension intercepts `findUnique`, `update`, `delete`, etc. and adds `restaurantId` to the WHERE clause. If a query uses a non-restaurantId unique field (e.g., `findUnique({ where: { email: 'foo@bar.com' } })` on the User model), the extension adds `restaurantId` to the WHERE, creating a composite condition `email AND restaurantId`. But `email` might not be unique per restaurant (the schema has `@@unique([restaurantId, email])`), so this works for User. However, for models where the unique field is globally unique (e.g., `MenuItem` has `@@unique([restaurantId, id])` but `id` itself is `@id @default(uuid())` globally unique), adding `restaurantId` doesn't break the query but could cause unexpected behavior if the ID belongs to another restaurant — Prisma would return `null` instead of the wrong record, which is actually GOOD behavior.
However, for `findUnique({ where: { id: someId } })` on `Order` (which has `@@unique([restaurantId, id])`), the extension adds `restaurantId`. If the caller passes an order ID from another tenant, it correctly returns null. This is actually a SECURITY feature, not a bug.
But for `findUnique` on `Restaurant` itself (which is in `modelsWithRestaurantId`), `where: { id: restaurantId }` would become `where: { id: restaurantId, restaurantId: restaurantId }`. The `Restaurant` model does NOT have a `restaurantId` field! This would cause a Prisma error.
**Impact:** ANY query on the `Restaurant` model through the extended prisma client will BREAK because `Restaurant` doesn't have a `restaurantId` field.
**Fix:** Remove `"Restaurant"` from `modelsWithRestaurantId` in `prisma.ts`.

### 2.25 `prisma.ts` — `modelsWithRestaurantId` includes `CaptainTarget` but schema has no `CaptainTarget` model
**File:** `src/lib/prisma.ts:20`
**Issue:** `"CaptainTarget"` is in `modelsWithRestaurantId` but `schema.prisma` has no `CaptainTarget` model. Prisma extension will attempt to add `restaurantId` to WHERE for a non-existent model, which may cause runtime errors or be silently ignored.
**Impact:** Potential runtime errors if any code queries `CaptainTarget` through the extended client.
**Fix:** Remove `"CaptainTarget"` from the set.

### 2.26 `prisma.ts` — `modelsWithRestaurantId` includes `OnboardingPayment` which is NOT in the set but is queried via `basePrisma`
**File:** `src/lib/prisma.ts`
**Issue:** `OnboardingPayment` is NOT in `modelsWithRestaurantId`, which is correct because it doesn't have `restaurantId` at creation time. But it IS queried through `basePrisma` in onboard.ts, not the extended `prisma`. This is actually correct design.

### 2.27 `escpos.ts` — File contains corrupted/malformed Unicode characters in comments
**File:** `src/utils/escpos.ts:1-100`
**Issue:** The file starts with garbled Unicode: `NO image/logo/canvas/pixel blocks â€
