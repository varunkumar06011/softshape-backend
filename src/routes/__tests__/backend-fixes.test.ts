import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import prisma, { basePrisma } from "../../lib/prisma";
import { onboardRouter } from "../onboard";
import printRouter from "../print";
import { authenticate } from "../../middleware/auth";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-change-me";
const RAZORPAY_WEBHOOK_SECRET = "whsec_test_webhook_secret";

function signToken(userId: string, restaurantId: string, role: string) {
  return jwt.sign({ userId, restaurantId, role, slug: "test" }, JWT_SECRET, { expiresIn: "1h" });
}

describe("Backend Fixes Tests", () => {
  describe("GET /api/onboard/payment/config", () => {
    let app: express.Express;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      app.use("/api/onboard", onboardRouter);
    });

    it("returns RAZORPAY gateway when keys are present", async () => {
      const originalKeyId = process.env.RAZORPAY_KEY_ID;
      const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;
      process.env.RAZORPAY_KEY_ID = "rzp_test_key";
      process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";

      const res = await request(app).get("/api/onboard/payment/config");
      expect(res.status).toBe(200);
      expect(res.body.gateway).toBe("RAZORPAY");
      expect(res.body.keyId).toBe("rzp_test_key");

      process.env.RAZORPAY_KEY_ID = originalKeyId;
      process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
    });

    it("returns MOCK gateway when keys are absent", async () => {
      const originalKeyId = process.env.RAZORPAY_KEY_ID;
      const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;

      const res = await request(app).get("/api/onboard/payment/config");
      expect(res.status).toBe(200);
      expect(res.body.gateway).toBe("MOCK");
      expect(res.body.keyId).toBeNull();

      if (originalKeyId) process.env.RAZORPAY_KEY_ID = originalKeyId;
      if (originalKeySecret) process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
    });
  });

  describe("POST /api/onboard/payment/razorpay-webhook", () => {
    let app: express.Express;

    beforeAll(() => {
      app = express();
      app.use("/api/onboard/payment/razorpay-webhook", express.raw({ type: "application/json" }));
      app.use("/api/onboard", onboardRouter);
    });

    it("rejects invalid signature with 400", async () => {
      const originalSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;
      process.env.RAZORPAY_WEBHOOK_SECRET = RAZORPAY_WEBHOOK_SECRET;
      process.env.RAZORPAY_KEY_SECRET = "fallback_secret";

      const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { order_id: "order_123" } } } });
      const res = await request(app)
        .post("/api/onboard/payment/razorpay-webhook")
        .set("x-razorpay-signature", "invalid_signature")
        .set("Content-Type", "application/json")
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid signature");

      if (originalSecret) process.env.RAZORPAY_WEBHOOK_SECRET = originalSecret;
      else delete process.env.RAZORPAY_WEBHOOK_SECRET;
      if (originalKeySecret) process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
      else delete process.env.RAZORPAY_KEY_SECRET;
    });
  });

  describe("Print route tenant isolation", () => {
    let app: express.Express;
    let restaurantA: any;
    let restaurantB: any;
    let userA: any;
    let userB: any;
    let tokenA: string;
    let tableA: any;
    let tableB: any;

    beforeAll(async () => {
      app = express();
      app.use(express.json());
      app.use("/api/print", authenticate, printRouter);

      await prisma.orderItem.deleteMany({});
      await prisma.order.deleteMany({});
      await prisma.table.deleteMany({});
      await prisma.section.deleteMany({});
      await prisma.user.deleteMany({});
      await prisma.outlet.deleteMany({});

      const orgA = await prisma.organization.create({ data: { name: "Print Org A", plan: "starter" } });
      const orgB = await prisma.organization.create({ data: { name: "Print Org B", plan: "starter" } });

      restaurantA = await prisma.outlet.create({
        data: { name: "Print Restaurant A", slug: "print-a", restaurantCode: "PRINT-A001", organizationId: orgA.id },
      });
      restaurantB = await prisma.outlet.create({
        data: { name: "Print Restaurant B", slug: "print-b", restaurantCode: "PRINT-B001", organizationId: orgB.id },
      });

      userA = await prisma.user.create({
        data: { name: "Print User A", email: "print-a@test.com", passwordHash: "hash", role: "OWNER", outletId: restaurantA.id, isActive: true },
      });
      userB = await prisma.user.create({
        data: { name: "Print User B", email: "print-b@test.com", passwordHash: "hash", role: "OWNER", outletId: restaurantB.id, isActive: true },
      });

      tokenA = signToken(userA.id, restaurantA.id, "OWNER");

      const sectionA = await prisma.section.create({ data: { name: "Main", restaurantId: restaurantA.id } });
      const sectionB = await prisma.section.create({ data: { name: "Main", restaurantId: restaurantB.id } });

      tableA = await prisma.table.create({
        data: { number: 1, capacity: 4, sectionId: sectionA.id, restaurantId: restaurantA.id, status: "AVAILABLE" },
      });
      tableB = await prisma.table.create({
        data: { number: 1, capacity: 4, sectionId: sectionB.id, restaurantId: restaurantB.id, status: "AVAILABLE" },
      });
    });

    afterAll(async () => {
      await prisma.orderItem.deleteMany({});
      await prisma.order.deleteMany({});
      await prisma.table.deleteMany({});
      await prisma.section.deleteMany({});
      await prisma.user.deleteMany({});
      await prisma.outlet.deleteMany({});
    });

    it("POST /api/print/food-kot rejects cross-tenant table access", async () => {
      const res = await request(app)
        .post("/api/print/food-kot")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({
          tableId: tableB.id,
          orderId: "order-123",
          items: [{ name: "Biryani", quantity: 1, type: "food" }],
        });
      // After fix: tenant-filtered findFirst returns 404 (no info leakage)
      expect([403, 404]).toContain(res.status);
    });

    it("POST /api/print/liquor-kot rejects cross-tenant table access", async () => {
      const res = await request(app)
        .post("/api/print/liquor-kot")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({
          tableId: tableB.id,
          orderId: "order-123",
          items: [{ name: "Beer", quantity: 1, type: "liquor" }],
        });
      // After fix: tenant-filtered findFirst returns 404 (no info leakage)
      expect([403, 404]).toContain(res.status);
    });

    it("POST /api/print/final-bill-emit rejects cross-tenant restaurantId", async () => {
      const res = await request(app)
        .post("/api/print/final-bill-emit")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({
          restaurantId: restaurantB.id,
          billData: {
            items: [{ name: "Biryani", quantity: 1, price: 100 }],
            subtotal: 100,
            grandTotal: 100,
            tableNumber: "T1",
          },
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Cross-tenant access denied");
    });
  });

  describe("AuditLog helper", () => {
    it("createAuditLog swallows prisma errors gracefully", async () => {
      const { createAuditLog } = await import("../../lib/auditLog");
      const createSpy = vi.spyOn(basePrisma.auditLog, "create").mockRejectedValue(new Error("DB down"));

      // Should not throw
      expect(() => createAuditLog({ action: "TEST", entityType: "Test" })).not.toThrow();

      // Wait a tick for the promise to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(createSpy).toHaveBeenCalledTimes(1);
      createSpy.mockRestore();
    });
  });
});
