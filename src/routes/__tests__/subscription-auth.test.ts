import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { basePrisma } from "../../lib/prisma";
import { authRouter } from "../auth";
import ordersRouter from "../orders";
import { authenticate } from "../../middleware/auth";
import { withTenantContext } from "../../middleware/tenantContext";
import { assertTenantScope } from "../../middleware/tenantScope";
import { assertSubscriptionActive } from "../../middleware/subscriptionCheck";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-change-me";

function signToken(userId: string, restaurantId: string, role: string) {
  return jwt.sign({ userId, restaurantId, role, slug: "test" }, JWT_SECRET, { expiresIn: "1h" });
}

describe("Subscription Enforcement & Auth Refresh", () => {
  let restaurantActive: any;
  let restaurantExpired: any;
  let userActive: any;
  let userExpired: any;
  let tokenActive: string;
  let tokenExpired: string;

  beforeAll(async () => {
    // Clean slate — use basePrisma so tenant scoping doesn't interfere
    await basePrisma.orderItem.deleteMany({});
    await basePrisma.transaction.deleteMany({});
    await basePrisma.order.deleteMany({});
    await basePrisma.user.deleteMany({});
    await basePrisma.restaurant.deleteMany({});

    const now = Date.now();
    restaurantActive = await basePrisma.restaurant.create({
      data: { name: "Active Restaurant", slug: `active-${now}`, restaurantCode: `ACT${now}`, billingStatus: "active" },
    });
    restaurantExpired = await basePrisma.restaurant.create({
      data: { name: "Expired Restaurant", slug: `expired-${now}`, restaurantCode: `EXP${now}`, billingStatus: "expired" },
    });

    userActive = await basePrisma.user.create({
      data: { name: "Active User", email: "active@test.com", passwordHash: "hash", role: "OWNER", restaurantId: restaurantActive.id, isActive: true },
    });
    userExpired = await basePrisma.user.create({
      data: { name: "Expired User", email: "expired@test.com", passwordHash: "hash", role: "OWNER", restaurantId: restaurantExpired.id, isActive: true },
    });

    tokenActive = signToken(userActive.id, restaurantActive.id, "OWNER");
    tokenExpired = signToken(userExpired.id, restaurantExpired.id, "OWNER");
  });

  afterAll(async () => {
    await basePrisma.orderItem.deleteMany({});
    await basePrisma.transaction.deleteMany({});
    await basePrisma.order.deleteMany({});
    await basePrisma.user.deleteMany({});
    await basePrisma.restaurant.deleteMany({});
    await basePrisma.$disconnect();
  });

  it("GET /api/orders — should allow reads even when subscription is expired", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/orders", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, ordersRouter);
    const res = await request(app)
      .get("/api/orders")
      .query({ restaurantId: restaurantExpired.id })
      .set("Authorization", `Bearer ${tokenExpired}`);
    expect(res.status).toBe(200);
  });

  it("POST /api/orders — should block writes when subscription is expired", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/orders", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, ordersRouter);
    const res = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${tokenExpired}`)
      .send({ items: [], totalAmount: 100 });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Subscription expired");
  });

  it("POST /api/orders — should allow writes when subscription is active", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/orders", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, ordersRouter);
    const res = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${tokenActive}`)
      .send({ items: [], totalAmount: 100 });
    // May fail validation but should NOT be blocked by subscription
    expect(res.status).not.toBe(403);
  });

  it("POST /api/auth/refresh — should return a new token extending expiry", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Authorization", `Bearer ${tokenActive}`);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    const decoded = jwt.decode(res.body.token) as any;
    expect(decoded.userId).toBe(userActive.id);
  });
});
