# Phase 1 Backend Audit Report

**Audited:** `softshape-backend/src` (Express + Prisma + Socket.io)  
**Date:** 2026-06-26

---

## Severity Legend
- **CRITICAL** — Crashes, data corruption, security breaches, production downtime
- **HIGH** — Feature failures, incorrect business logic, data inconsistency
- **MEDIUM** — Degraded UX, performance issues, maintenance burden
- **LOW** — Code smell, minor inconsistency

---

## 1. CRITICAL ISSUES (7)

### 1.1 `process.exit(1)` on DB schema probe crashes server on startup drift
**File:** `src/index.ts:508`  
**Issue:** `probeDbSchema()` calls `process.exit(1)` if any checked column is missing. A single missing non-critical column (e.g., `VenuePrice` on an old tenant) kills the entire backend.  
**Fix:** Replace `process.exit(1)` with a health-check warning.

### 1.2 `barMenuRouter` has ZERO auth/tenant/subscription guards
**File:** `src/index.ts:257`  
**Issue:** `app.use("/api/bar/menu", barMenuRouter)` — no `authenticate`, `assertTenantScope`, `assertSubscriptionActive`, or `withTenantContext`. Anyone can read/write bar menus for any restaurant.  
**Fix:** Mount with full middleware chain.

### 1.3 `printRouter` has ZERO auth guards
**File:** `src/index.ts:260`  
**Issue:** `app.use("/api/print", printRouter)` — no `authenticate`. Unauthenticated callers can trigger print jobs, read receipts, emit socket events.  
**Fix:** Add `authenticate` at router mount; exempt `qz-sign` inside the router if needed.

### 1.4 `superadminRouter` — missing env var = open access
**File:** `src/index.ts:273`, `src/routes/superadmin.ts:6-14`  
**Issue:** `!SUPERADMIN_SECRET || secret !== SUPERADMIN_SECRET` evaluates `true` when `SUPERADMIN_SECRET` is undefined, granting full superadmin access.  
**Fix:** Throw at startup if `SUPERADMIN_SECRET` is missing. Add `authenticate` before `requireSuperAdmin`.

### 1.5 `kitchenInventoryRouter` missing subscription + tenant scope
**File:** `src/index.ts:264`  
**Issue:** Only `authenticate` is applied. Suspended tenants can still manage kitchen inventory.  
**Fix:** Add `assertTenantScope, assertSubscriptionActive, withTenantContext`.

### 1.6 `payrollRouter` missing subscription + tenant scope
**File:** `src/index.ts:263`  
**Issue:** Only `authenticate` is applied.  
**Fix:** Add `assertTenantScope, assertSubscriptionActive, withTenantContext`.

### 1.7 Razorpay webhook — `express.json()` overwrites raw body, breaking signature verification
**File:** `src/index.ts:141-142`, `src/routes/onboard.ts:516-589`  
**Issue:** `express.raw()` is registered first for the webhook path, but `express.json()` (line 142, no path filter) ALSO runs on that path and OVERWRITES `req.body` from Buffer to parsed object. The HMAC signature verification requires the raw body string — it will always fail.  
**Fix:** Exclude the webhook path from `express.json()`:
```ts
app.use((req, res, next) => {
  if (req.path === "/api/onboard/payment/razorpay-webhook") return next();
  express.json({ limit: "10mb" })(req, res, next);
});
```

---

## 2. HIGH ISSUES (20)

### 2.1 `prisma.ts` — `Restaurant` in `modelsWithRestaurantId` causes Prisma runtime errors
**File:** `src/lib/prisma.ts:10`  
**Issue:** `Restaurant` model has NO `restaurantId` field. The extension adds it to WHERE clauses, causing Prisma errors on every `Restaurant` query.  
**Fix:** Remove `"Restaurant"` from `modelsWithRestaurantId`.

### 2.2 `prisma.ts` — `CaptainTarget` in `modelsWithRestaurantId` but model does not exist
**File:** `src/lib/prisma.ts:20`  
**Issue:** Schema has no `CaptainTarget` model.  
**Fix:** Remove `"CaptainTarget"` from the set.

### 2.3 `auth.ts` — `forgot-password` uses `Math.random()` for reset tokens
**File:** `src/routes/auth.ts:305`  
**Issue:** `Math.random()` is NOT cryptographically secure. Tokens are predictable.  
**Fix:** Use `crypto.randomBytes(32).toString('hex')`.

### 2.4 `auth.ts` — `/me` handler wraps async IIFE without await -> unhandled rejections
**File:** `src/routes/auth.ts:238-270`  
**Issue:** `(req, res) => { (async () => { ... })(); }` — errors are unhandled rejections, not caught by Express.  
**Fix:** Make handler async: `router.get('/me', requireAuth, async (req, res) => { ... })`.

### 2.5 `orders.ts` — `reprint-kot` lacks order ownership validation
**File:** `src/routes/orders.ts:1443-1536`  
**Issue:** Authenticated users can reprint KOTs for orders from ANY restaurant.  
**Fix:** Validate `order.restaurantId === req.user.restaurantId`.

### 2.6 `orders.ts` — `settle` trusts frontend-calculated totals (only +/-0.50 check)
**File:** `src/routes/orders.ts:1640-1655`  
**Issue:** `bodyGrandTotal`, `bodySubtotal` from frontend are written to DB after minimal validation.  
**Fix:** Always compute totals server-side inside the transaction; reject frontend values entirely.

### 2.7 `orders.ts` — `getNextBillNumber` uses `gen_random_uuid()` (PostgreSQL 13+ only)
**File:** `src/routes/orders.ts:312-321`  
**Issue:** Raw SQL uses `gen_random_uuid()` which doesn't exist in PostgreSQL < 13.  
**Fix:** Use `uuid_generate_v4()` from `uuid-ossp` or Prisma client-side UUID.

### 2.8 `barMenu.ts` — GET endpoints return ALL restaurants' data (no tenant filter)
**File:** `src/routes/barMenu.ts:52-118`  
**Issue:** `menuItem.findMany({ where: { isDeleted: false } })` — no `restaurantId` filter.  
**Fix:** Add `restaurantId: resolveBarId(req)` to WHERE.

### 2.9 `barMenu.ts` — POST creates categories with empty `restaurantId` fallback
**File:** `src/routes/barMenu.ts:121-150`  
**Issue:** `restaurantId: getUserRestaurantId(req) ?? ''` falls back to empty string.  
**Fix:** Return 400 if `restaurantId` is missing.

### 2.10 `onboard.ts` — cleanup leaves orphan users
**File:** `src/routes/onboard.ts:503-513`  
**Issue:** Owner user is created before restaurant. On partial failure, restaurant is deleted but owner remains.  
**Fix:** Track created user IDs and delete them in cleanup.

### 2.11 `onboard.ts` — `allocateRestaurantCode` uses `Math.random()` with only 10 attempts
**File:** `src/routes/onboard.ts:14-25`  
**Issue:** Not CSPRNG; 10 attempts too few under concurrent load.  
**Fix:** Use `crypto.randomBytes()`; increase attempts to 100.

### 2.12 `onboard.ts` — `generateUniqueSlug` race condition
**File:** `src/routes/onboard.ts:247-255`  
**Issue:** Slug check-and-create is not atomic.  
**Fix:** Wrap in transaction with retry.

### 2.13 `print.ts` — `cancel-bill` has no auth
**File:** `src/routes/print.ts:597`  
**Issue:** No `authenticate`.  
**Fix:** Add auth to all non-public print routes.

### 2.14 `print.ts` — `receipt` has backward-compat auth bypass
**File:** `src/routes/print.ts:300-305`  
**Issue:** `if (authRestaurantId && ...)` skips check when `authRestaurantId` is undefined.  
**Fix:** Require auth unconditionally.

### 2.15 `verification.ts` — `/email/verify` has no rate limiting
**File:** `src/routes/verification.ts:65-89`  
**Issue:** 6-digit OTP can be brute-forced within the 5-minute TTL.  
**Fix:** Add `express-rate-limit` to the verify endpoint.

### 2.16 `subscriptionCheck.ts` — GET requests always allowed for suspended tenants
**File:** `src/middleware/subscriptionCheck.ts:10-14`  
**Issue:** `if (req.method === "GET") { next(); return; }` allows ALL GET requests for suspended tenants, including reports and analytics.  
**Fix:** Allow GET only for essential captain-shift data (menus, active orders), not reports/analytics.

### 2.17 `menu.ts` — `upsertVenuePrices` does not scope upsert by `restaurantId`
**File:** `src/routes/menu.ts:44-53`  
**Issue:** WHERE only uses `venueId_menuItemId`. Cross-tenant venue price corruption possible.  
**Fix:** Add `restaurantId` to WHERE or ensure venueIds are globally unique per restaurant.

### 2.18 `orders.ts` — `print-bill` does not verify caller owns the order
**File:** `src/routes/orders.ts:1187-1440`  
**Issue:** Takes `restaurantId` from `req.query` but never validates order ownership.  
**Fix:** Add `assertOrderBelongsToTenant(orderId, restaurantId)` check.

### 2.19 `tenantScope.ts` — GET requests without `restaurantId` in query may proceed unscoped
**File:** `src/middleware/tenantScope.ts:17-20`  
**Issue:** `assertTenantScope` only checks `req.body`, `req.query`, `req.params`. For GET requests without `restaurantId` in query, it injects `req.body.restaurantId` but GET has no body.  
**Fix:** For GET requests, enforce `req.query.restaurantId` or use `req.user.restaurantId` for all DB queries.

### 2.20 `kitchenInventory.ts` — `checkLowStock` uses incorrect Prisma query syntax
**File:** `src/routes/kitchenInventory.ts:207`  
**Issue:** `prisma.kitchenInventoryItem.fields.reorderLevel` is not a valid filter value.  
**Fix:** Fetch items and filter in JS, or use a raw query.

---

## 3. MEDIUM ISSUES (10)

### 3.1 `unhandledRejection` handler does NOT exit process
**File:** `src/index.ts:63-65`  
**Issue:** Process stays alive in zombie state after unhandled rejections.  
**Fix:** Add `process.exit(1)`.

### 3.2 Socket.io `agent:join` uses hardcoded `"fallback-secret"`
**File:** `src/index.ts:402`  
**Issue:** `process.env.JWT_SECRET || "fallback-secret"` — if env var is missing, tokens are trivially forgeable.  
**Fix:** Remove fallback; throw if `JWT_SECRET` is missing.

### 3.3 `print:ack` socket event relays without room membership check
**File:** `src/index.ts:378-389`  
**Issue:** Any socket can send `print:ack` with any `restaurantId`.  
**Fix:** Verify socket is in the room before relaying.

### 3.4 `emitToRestaurant` does not await `bufferPrintJob`
**File:** `src/routes/orders.ts:228`  
**Issue:** Fire-and-forget may miss buffering before socket emit.  
**Fix:** `await bufferPrintJob(...)` before emitting.

### 3.5 `cancel-item` and `cancel-items` emit stale `updatedTable` data
**File:** `src/routes/orders.ts:2522-2525`, `2694-2695`  
**Issue:** Post-transaction table updates (status reset on full cancel) are not reflected in emitted data.  
**Fix:** Fetch fresh table data before emitting.

### 3.6 `cache.ts` — `cacheClear` uses `redis.keys()` (O(N), blocks Redis)
**File:** `src/lib/cache.ts:59-72`  
**Issue:** `redis.keys()` scans ALL keys.  
**Fix:** Use `redis.scanStream()` or `SCAN` with pagination.

### 3.7 `escpos.ts` — corrupted Unicode characters in comments
**File:** `src/utils/escpos.ts`  
**Issue:** File has garbled encoding.  
**Fix:** Re-encode as UTF-8.

### 3.8 `restaurant.ts` — `PATCH /profile` missing `halfBottleMl` update field
**File:** `src/routes/restaurant.ts:124-167`  
**Issue:** `halfBottleMl` is missing from allowed update fields.  
**Fix:** Add it to the handler.

### 3.9 `transactions.ts` — `discountPercent` / `discountAmount` forced to 0 when null
**File:** `src/routes/transactions.ts:69-70`  
**Issue:** Schema allows null but code forces 0. Loses semantic distinction.  
**Fix:** Accept null as-is if frontend handles it.

### 3.10 `verification.ts` — `resend` instantiated with dummy key
**File:** `src/routes/verification.ts:10`  
**Issue:** `new Resend("re_dummy_key...")` is misleading.  
**Fix:** Lazy-instantiate Resend only when needed.

---

## 4. LOW ISSUES (6)

### 4.1 `orderCreateLimiter` silently falls back to IP on JWT errors
**File:** `src/index.ts:167-179`  
**Issue:** Acceptable behavior but masks token issues.

### 4.2 `auth.ts` — inconsistent status codes for inactive accounts
**File:** `src/routes/auth.ts:36-64`  
**Issue:** Inactive restaurant = 401, inactive user = 403. Confusing.

### 4.3 `orders.ts` — KOT ID not truly unique after 99 per day
**File:** `src/routes/orders.ts:166`  
**Issue:** `padStart(2, '0')` breaks format after 99.

### 4.4 `transactions.ts` — no upper bound on `limit` param
**File:** `src/routes/transactions.ts:172-174`  
**Issue:** `limit=999999` could cause memory issues.  
**Fix:** Cap at 500.

### 4.5 `index.ts` — duplicate CORS origins
**File:** `src/index.ts:67-86`  
**Issue:** `"http://localhost:3000"` appears twice (harmless due to `Set`).

### 4.6 `onboard.ts` — `gstin` regex may reject some valid GSTINs
**File:** `src/routes/onboard.ts:56`  
**Issue:** Regex is strict; some valid formats may be rejected.

---

## 5. SCHEMA ISSUES

### 5.1 `Order.inventoryDeducted` has stray comment
**File:** `prisma/schema.prisma:260`  
**Issue:** `// <- ADD THIS LINE` suggests manual add. Ensure migration exists.

### 5.2 Missing `CaptainTarget` model referenced in code
**File:** `src/lib/prisma.ts:20`  
**Issue:** Code references `CaptainTarget` but schema has no such model.

---

## 6. SECURITY CHECKLIST

| Check | Status |
|---|---|
| Hardcoded secrets | FAIL (`"fallback-secret"`) |
| SQL injection | PASS (Prisma ORM) |
| Auth on all routes | FAIL (`barMenu`, `print`, gaps) |
| Rate limiting | PARTIAL (OTP verify not limited) |
| CORS | PASS |
| Password hashing | PASS (bcrypt, 12 rounds) |
| JWT expiry | PASS (7d + refresh) |
| Input validation | PARTIAL (Zod only for onboard) |

---

## Summary

- **CRITICAL:** 7 — auth gaps, broken webhook, startup crash
- **HIGH:** 20 — cross-tenant leaks, predictable tokens, unhandled rejections, race conditions
- **MEDIUM:** 10 — Redis blocking, stale socket data, missing fields
- **LOW:** 6 — code smells, duplicates

**Top 5 immediate fixes:**
1. Fix Razorpay webhook body parsing (1.7)
2. Add auth to `barMenuRouter` and `printRouter` (1.2, 1.3)
3. Fix `superadminRouter` env check (1.4)
4. Remove `Restaurant` and `CaptainTarget` from `modelsWithRestaurantId` (2.1, 2.2)
5. Replace `Math.random()` with `crypto.randomBytes` (2.3, 2.11)
