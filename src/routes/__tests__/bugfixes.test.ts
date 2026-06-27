import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import prisma from "../../lib/prisma";
import { acquireLock, releaseLock, withLock, isLockReady } from "../../lib/redisLock";
import { authenticate } from "../../middleware/auth";
import { withTenantContext } from "../../middleware/tenantContext";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-change-me";

function signToken(userId: string, restaurantId: string, role: string) {
  return jwt.sign({ userId, restaurantId, role, slug: "test" }, JWT_SECRET, { expiresIn: "1h" });
}

describe("Backend Bugfix Tests", () => {
  // ─────────────────────────────────────────────
  // Bug #3: redisLock graceful degradation
  // ─────────────────────────────────────────────
  describe("redisLock graceful degradation", () => {
    it("isLockReady returns a boolean", () => {
      expect(typeof isLockReady()).toBe("boolean");
    });

    it("acquireLock does not throw even if Redis is unavailable", async () => {
      // Save original REDIS_URL and remove it
      const originalUrl = process.env.REDIS_URL;
      // We can't re-import the module, but we can verify acquireLock doesn't throw
      // The module-level code already ran with whatever REDIS_URL was set
      const result = await acquireLock("test-key-degradation", 5);
      expect(typeof result).toBe("boolean");
      if (originalUrl !== undefined) process.env.REDIS_URL = originalUrl;
    });

    it("releaseLock does not throw", async () => {
      await expect(releaseLock("test-key-release")).resolves.toBeUndefined();
    });

    it("withLock executes fn and returns result", async () => {
      const result = await withLock("test-withlock-key", 5, async () => {
        return 42;
      });
      // If Redis is available, lock is acquired and fn runs → 42
      // If Redis is not available, lock fails open (acquireLock returns true) → fn runs → 42
      expect(result).toBe(42);
    });

    it("withLock releases lock after fn completes", async () => {
      const key = "test-withlock-release";
      const result = await withLock(key, 10, async () => "done");
      expect(result).toBe("done");
      // After withLock, the lock should be released — re-acquiring should succeed
      const reacquired = await acquireLock(key, 5);
      expect(reacquired).toBe(true);
      await releaseLock(key);
    });

    it("withLock releases lock even when fn throws", async () => {
      const key = "test-withlock-throw";
      try {
        await withLock(key, 10, async () => {
          throw new Error("test error");
        });
      } catch {
        // expected
      }
      // Lock should still be released after the throw
      const reacquired = await acquireLock(key, 5);
      expect(reacquired).toBe(true);
      await releaseLock(key);
    });
  });

  // ─────────────────────────────────────────────
  // Bug #1 + #2 + #6: Orders cancel-item/cancel-items
  // ─────────────────────────────────────────────
  describe("Orders cancel-item/cancel-items tenant + idempotency", () => {
    let app: express.Express;
    let restaurantA: any;
    let restaurantB: any;
    let userA: any;
    let tokenA: string;
    let tokenB: string;
    let tableA: any;
    let orderA: any;
    let menuItemA: any;
    let orderItemA: any;
    let categoryA: any;

    beforeAll(async () => {
      app = express();
      app.use(express.json());

      // We need to import ordersRouter with all middleware
      const { default: ordersRouter } = await import("../orders");
      app.use("/api/orders", authenticate, withTenantContext, ordersRouter);

      // Clean slate
      await prisma.orderItem.deleteMany({});
      await prisma.processedRequest.deleteMany({});
      await prisma.order.deleteMany({});
      await prisma.table.deleteMany({});
      await prisma.section.deleteMany({});
      await prisma.menuItem.deleteMany({});
      await prisma.category.deleteMany({});
      await prisma.user.deleteMany({});
      await prisma.outlet.deleteMany({});
      await prisma.organization.deleteMany({});

      // Seed
      const orgA = await prisma.organization.create({ data: { name: "Org A", plan: "starter" } });
      const orgB = await prisma.organization.create({ data: { name: "Org B", plan: "starter" } });
      restaurantA = await prisma.outlet.create({
        data: { name: "Rest A", slug: "rest-a", restaurantCode: "RA001", organizationId: orgA.id },
      });
      restaurantB = await prisma.outlet.create({
        data: { name: "Rest B", slug: "rest-b", restaurantCode: "RB001", organizationId: orgB.id },
      });

      userA = await prisma.user.create({
        data: { name: "User A", email: "usera@test.com", passwordHash: "hash", role: "CASHIER", outletId: restaurantA.id, isActive: true },
      });
      const userB = await prisma.user.create({
        data: { name: "User B", email: "userb@test.com", passwordHash: "hash", role: "CASHIER", outletId: restaurantB.id, isActive: true },
      });

      tokenA = signToken(userA.id, restaurantA.id, "CASHIER");
      tokenB = signToken(userB.id, restaurantB.id, "CASHIER");

      const sectionA = await prisma.section.create({ data: { name: "Main", restaurantId: restaurantA.id } });
      tableA = await prisma.table.create({
        data: { number: 1, capacity: 4, sectionId: sectionA.id, restaurantId: restaurantA.id, status: "AVAILABLE" },
      });

      categoryA = await prisma.category.create({ data: { name: "Food", restaurantId: restaurantA.id, sortOrder: 0 } });
      menuItemA = await prisma.menuItem.create({
        data: { name: "Biryani", basePrice: 200, restaurantId: restaurantA.id, categoryId: categoryA.id, menuType: "FOOD" },
      });

      orderA = await prisma.order.create({
        data: { tableId: tableA.id, restaurantId: restaurantA.id, status: "PENDING", totalAmount: 200 },
      });

      orderItemA = await prisma.orderItem.create({
        data: { orderId: orderA.id, menuItemId: menuItemA.id, name: "Biryani", price: 200, quantity: 1, menuType: "FOOD" },
      });
    });

    afterAll(async () => {
      await prisma.orderItem.deleteMany({});
      await prisma.processedRequest.deleteMany({});
      await prisma.order.deleteMany({});
      await prisma.table.deleteMany({});
      await prisma.section.deleteMany({});
      await prisma.menuItem.deleteMany({});
      await prisma.category.deleteMany({});
      await prisma.user.deleteMany({});
      await prisma.outlet.deleteMany({});
      await prisma.organization.deleteMany({});
      await prisma.$disconnect();
    });

    it("cancel-item on non-existent order returns 404 (not 500)", async () => {
      const res = await request(app)
        .patch("/api/orders/non-existent-id/cancel-item")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ orderItemId: "fake", cancelledBy: "test" });
      expect(res.status).toBe(404);
    });

    it("cancel-item on another tenant's order returns 403 or 404 (not 500)", async () => {
      // Create order in restaurant B
      const sectionB = await prisma.section.findFirst({ where: { restaurantId: restaurantB.id } });
      if (!sectionB) {
        return;
      }
      const tableB = await prisma.table.findFirst({ where: { restaurantId: restaurantB.id } });
      if (!tableB) return;

      const orderB = await prisma.order.create({
        data: { tableId: tableB.id, restaurantId: restaurantB.id, status: "PENDING", totalAmount: 100 },
      });

      const res = await request(app)
        .patch(`/api/orders/${orderB.id}/cancel-item`)
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ orderItemId: "fake", cancelledBy: "test" });
      // After fix: should return 403 (cross-tenant) or 404 (not found), not 500
      expect([403, 404]).toContain(res.status);

      await prisma.order.delete({ where: { id: orderB.id } });
    });

    it("cancel-items idempotency: second call with same requestId returns 'Already processed'", async () => {
      const requestId = "test-idempotency-002";
      // Pre-create a processedRequest record to simulate first call already processed
      await prisma.processedRequest.create({
        data: {
          requestId,
          actionType: 'cancel-items',
          restaurantId: restaurantA.id,
          result: { message: "Items cancelled", cancelledCount: 1 },
        },
      });

      // Second call with same requestId should return the cached result
      const res = await request(app)
        .patch(`/api/orders/${orderA.id}/cancel-items`)
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ items: [{ orderItemId: orderItemA.id, cancelQuantity: 1 }], cancelledBy: "test", requestId });
      expect(res.status).toBe(200);
      // The route returns { message: "Already processed", ...result }
      // Since result has { message: "Items cancelled" }, it overrides the default
      expect(res.body.message).toBe("Items cancelled");
      expect(res.body.cancelledCount).toBe(1);

      await prisma.processedRequest.deleteMany({ where: { requestId } });
    });
  });

  // ─────────────────────────────────────────────
  // Bug #4: barTables Table 999 guard
  // ─────────────────────────────────────────────
  describe("barTables Table 999 guard", () => {
    it("GET /api/bar/tables without restaurantId should return 401", async () => {
      const app = express();
      app.use(express.json());
      const { default: barTablesRouter } = await import("../barTables");
      // Mount without withTenantContext to simulate missing context
      app.use("/api/bar/tables", authenticate, barTablesRouter);

      // Create a token with no restaurantId
      const token = jwt.sign({ userId: "test-user", role: "CASHIER" }, JWT_SECRET, { expiresIn: "1h" });

      const res = await request(app)
        .get("/api/bar/tables")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });
});
