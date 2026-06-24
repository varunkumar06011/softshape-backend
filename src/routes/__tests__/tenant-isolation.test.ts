import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import prisma from "../../lib/prisma";
import tablesRouter from "../tables";
import menuRouter from "../menu";
import transactionRoutes from "../transactions";
import { authRouter } from "../auth";
import { authenticate } from "../../middleware/auth";
import { withTenantContext } from "../../middleware/tenantContext";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-change-me";

function signToken(userId: string, restaurantId: string, role: string) {
  return jwt.sign({ userId, restaurantId, role, slug: "test" }, JWT_SECRET, { expiresIn: "1h" });
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/tables", authenticate, withTenantContext, tablesRouter);
  app.use("/api/menu", authenticate, withTenantContext, menuRouter);
  app.use("/api/transactions", authenticate, withTenantContext, transactionRoutes);
  app.use("/api/auth", authRouter);
  return app;
}

describe("Cross-Tenant Isolation Tests", () => {
  let app: ReturnType<typeof createTestApp>;
  let restaurantA: any;
  let restaurantB: any;
  let userA: any;
  let userB: any;
  let tokenA: string;
  let tableA: any;
  let tableB: any;
  let categoryA: any;
  let categoryB: any;
  let menuItemA: any;
  let menuItemB: any;
  let orderA: any;
  let orderB: any;
  let transactionA: any;
  let transactionB: any;

  beforeAll(async () => {
    app = createTestApp();

    // Clean slate
    await prisma.orderItem.deleteMany({});
    await prisma.transaction.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.table.deleteMany({});
    await prisma.section.deleteMany({});
    await prisma.menuItem.deleteMany({});
    await prisma.category.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.restaurant.deleteMany({});

    // Seed Restaurant A
    restaurantA = await prisma.restaurant.create({
      data: { name: "Restaurant A", slug: "restaurant-a", restaurantCode: "REST-A001" },
    });
    restaurantB = await prisma.restaurant.create({
      data: { name: "Restaurant B", slug: "restaurant-b", restaurantCode: "REST-B001" },
    });

    userA = await prisma.user.create({
      data: { name: "User A", email: "user-a@test.com", passwordHash: "hash", role: "OWNER", restaurantId: restaurantA.id, isActive: true },
    });
    userB = await prisma.user.create({
      data: { name: "User B", email: "user-b@test.com", passwordHash: "hash", role: "OWNER", restaurantId: restaurantB.id, isActive: true },
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

    categoryA = await prisma.category.create({ data: { name: "Food", restaurantId: restaurantA.id, sortOrder: 0 } });
    categoryB = await prisma.category.create({ data: { name: "Food", restaurantId: restaurantB.id, sortOrder: 0 } });

    menuItemA = await prisma.menuItem.create({
      data: { name: "Item A", basePrice: 100, restaurantId: restaurantA.id, categoryId: categoryA.id, menuType: "FOOD" },
    });
    menuItemB = await prisma.menuItem.create({
      data: { name: "Item B", basePrice: 200, restaurantId: restaurantB.id, categoryId: categoryB.id, menuType: "FOOD" },
    });

    orderA = await prisma.order.create({
      data: { tableId: tableA.id, restaurantId: restaurantA.id, status: "PENDING", totalAmount: 100 },
    });
    orderB = await prisma.order.create({
      data: { tableId: tableB.id, restaurantId: restaurantB.id, status: "PENDING", totalAmount: 200 },
    });

    transactionA = await prisma.transaction.create({
      data: { restaurantId: restaurantA.id, orderId: orderA.id, amount: 100, method: "CASH", txnDate: "2024-01-01", txnNumber: 1 },
    });
    transactionB = await prisma.transaction.create({
      data: { restaurantId: restaurantB.id, orderId: orderB.id, amount: 200, method: "CASH", txnDate: "2024-01-01", txnNumber: 1 },
    });
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany({});
    await prisma.transaction.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.table.deleteMany({});
    await prisma.section.deleteMany({});
    await prisma.menuItem.deleteMany({});
    await prisma.category.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.restaurant.deleteMany({});
    await prisma.$disconnect();
  });

  // ─────────────────────────────────────────────
  // TABLES (Critical — no restaurantId check on :id routes)
  // ─────────────────────────────────────────────

  it("PATCH /api/tables/:id/status — should NOT allow User A to update Table B", async () => {
    const res = await request(app)
      .patch(`/api/tables/${tableB.id}/status`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ status: "OCCUPIED" });
    // Currently it succeeds (200) because the route does not verify restaurantId
    // After the fix it should return 404
    expect(res.status).toBe(404);
    console.log("  [LEAK] tables/status:", res.status, res.body?.error || res.body?.status);
  });

  it("PATCH /api/tables/:id/session — should NOT allow User A to update Table B session", async () => {
    const res = await request(app)
      .patch(`/api/tables/${tableB.id}/session`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ status: "Occupied", captainId: userA.id, guests: 4 });
    expect(res.status).toBe(404);
    console.log("  [LEAK] tables/session:", res.status, res.body?.error || res.body?.workflowStatus);
  });

  it("PATCH /api/tables/:id — should NOT allow User A to patch Table B", async () => {
    const res = await request(app)
      .patch(`/api/tables/${tableB.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ discount: 10 });
    expect(res.status).toBe(404);
    console.log("  [LEAK] tables/patch:", res.status, res.body?.error || res.body?.table?.discount);
  });

  it("DELETE /api/tables/:id — should NOT allow User A to delete Table B", async () => {
    const res = await request(app)
      .delete(`/api/tables/${tableB.id}`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
    console.log("  [LEAK] tables/delete:", res.status, res.body?.error || res.body?.success);
  });

  // ─────────────────────────────────────────────
  // MENU (Critical — update/delete lacks scoped where)
  // ─────────────────────────────────────────────

  it("PATCH /api/menu/items/:id/availability — should NOT allow User A to toggle MenuItem B (even with B's restaurantId in query)", async () => {
    const res = await request(app)
      .patch(`/api/menu/items/${menuItemB.id}/availability?restaurantId=${restaurantB.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({});
    expect(res.status).toBe(404);
    console.log("  [LEAK] menu/availability:", res.status, res.body?.error || res.body?.isAvailable);
  });

  it("PATCH /api/menu/items/:id — should NOT allow User A to update MenuItem B (even with B's restaurantId in body)", async () => {
    const res = await request(app)
      .patch(`/api/menu/items/${menuItemB.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "Hacked Name", restaurantId: restaurantB.id });
    expect(res.status).toBe(404);
    console.log("  [LEAK] menu/patch:", res.status, res.body?.error || res.body?.name);
  });

  it("DELETE /api/menu/items/:id — should NOT allow User A to delete MenuItem B (even with B's restaurantId in body)", async () => {
    const res = await request(app)
      .delete(`/api/menu/items/${menuItemB.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ restaurantId: restaurantB.id });
    expect(res.status).toBe(404);
    console.log("  [LEAK] menu/delete:", res.status, res.body?.error || res.body?.ok);
  });

  // ─────────────────────────────────────────────
  // TRANSACTIONS (Contrast — this one IS manually checked)
  // ─────────────────────────────────────────────

  it("DELETE /api/transactions/:id — should NOT allow User A to delete Transaction B", async () => {
    const res = await request(app)
      .delete(`/api/transactions/${transactionB.id}?restaurantId=${restaurantA.id}`)
      .set("Authorization", `Bearer ${tokenA}`);
    // transactions.ts used to manually check restaurantId and return 403,
    // but now the Prisma extension auto-scopes findUnique so it returns 404
    // (which is better — no information leakage about other tenants).
    expect(res.status).toBe(404);
    console.log("  [SAFE] transactions/delete:", res.status, res.body?.error);
  });

  // ─────────────────────────────────────────────
  // AUTH (Public endpoints that leak cross-tenant)
  // ─────────────────────────────────────────────

  it("POST /api/auth/forgot-password — should NOT reset a user from another tenant", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: userB.email });
    // Currently it finds userB by email globally and generates a reset token
    // No restaurantId is ever checked.
    expect(res.status).not.toBe(200);
    console.log("  [LEAK] auth/forgot-password: returns 200 for cross-tenant email (status:", res.status, ")");
  });
});
