import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import prisma from "../../lib/prisma";
import tablesRouter from "../tables";
import menuRouter from "../menu";
import transactionRoutes from "../transactions";
import { authRouter } from "../auth";
import { authenticate, optionalAuth } from "../../middleware/auth";
import { withTenantContext } from "../../middleware/tenantContext";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-change-me";

function signToken(userId: string, restaurantId: string, role: string) {
  return jwt.sign({ userId, restaurantId, role, slug: "test" }, JWT_SECRET, { expiresIn: "1h" });
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/tables", authenticate, withTenantContext, tablesRouter);
  app.use("/api/menu", optionalAuth, menuRouter);
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
    await prisma.outlet.deleteMany({});

    // Seed Restaurant A
    const orgA = await prisma.organization.create({ data: { name: "Org A", plan: "starter" } });
    const orgB = await prisma.organization.create({ data: { name: "Org B", plan: "starter" } });
    restaurantA = await prisma.outlet.create({
      data: { name: "Restaurant A", slug: "restaurant-a", restaurantCode: "REST-A001", organizationId: orgA.id },
    });
    restaurantB = await prisma.outlet.create({
      data: { name: "Restaurant B", slug: "restaurant-b", restaurantCode: "REST-B001", organizationId: orgB.id },
    });

    userA = await prisma.user.create({
      data: { name: "User A", email: "user-a@test.com", passwordHash: "hash", role: "OWNER", outletId: restaurantA.id, isActive: true },
    });
    userB = await prisma.user.create({
      data: { name: "User B", email: "user-b@test.com", passwordHash: "hash", role: "OWNER", outletId: restaurantB.id, isActive: true },
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
    await prisma.outlet.deleteMany({});
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
    // assertTenantScope catches the cross-tenant restaurantId in query and returns 403
    expect([403, 404]).toContain(res.status);
    console.log("  [SAFE] menu/availability:", res.status, res.body?.error || res.body?.isAvailable);
  });

  it("PATCH /api/menu/items/:id — should NOT allow User A to update MenuItem B (even with B's restaurantId in body)", async () => {
    const res = await request(app)
      .patch(`/api/menu/items/${menuItemB.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "Hacked Name", restaurantId: restaurantB.id });
    // assertTenantScope catches the cross-tenant restaurantId in body and returns 403
    expect([403, 404]).toContain(res.status);
    console.log("  [SAFE] menu/patch:", res.status, res.body?.error || res.body?.name);
  });

  it("DELETE /api/menu/items/:id — should NOT allow User A to delete MenuItem B (even with B's restaurantId in body)", async () => {
    const res = await request(app)
      .delete(`/api/menu/items/${menuItemB.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ restaurantId: restaurantB.id });
    // assertTenantScope catches the cross-tenant restaurantId in body and returns 403
    expect([403, 404]).toContain(res.status);
    console.log("  [SAFE] menu/delete:", res.status, res.body?.error || res.body?.ok);
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

  // ─────────────────────────────────────────────
  // MENU BULK-IMPORT & UPLOAD — body restaurantId fallback removed
  // ─────────────────────────────────────────────

  it("POST /api/menu/bulk-import — should NOT allow User A to import with B's restaurantId in body", async () => {
    const res = await request(app)
      .post("/api/menu/bulk-import")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ rows: [{ name: "Hacked", price: 100, category: "Food" }], restaurantId: restaurantB.id });
    // assertTenantScope catches the cross-tenant restaurantId in body and returns 403
    expect([403, 401]).toContain(res.status);
    console.log("  [SAFE] menu/bulk-import:", res.status, res.body?.error);
  });

  it("POST /api/menu/bulk-import — should NOT allow import without authentication", async () => {
    const res = await request(app)
      .post("/api/menu/bulk-import")
      .send({ rows: [{ name: "Hacked", price: 100, category: "Food" }] });
    // No auth token, no restaurantId fallback — should reject
    expect(res.status).toBe(401);
    console.log("  [SAFE] menu/bulk-import-no-auth:", res.status, res.body?.error);
  });

  // ─────────────────────────────────────────────
  // MENU RECIPES — ownership check added
  // ─────────────────────────────────────────────

  it("POST /api/menu/recipes/:menuItemId — should NOT allow User A to set recipe for MenuItem B", async () => {
    const res = await request(app)
      .post(`/api/menu/recipes/${menuItemB.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ ingredients: [] });
    expect([403, 404]).toContain(res.status);
    console.log("  [SAFE] menu/recipes:", res.status, res.body?.error);
  });

  // ─────────────────────────────────────────────
  // MENU CATEGORIES — cross-tenant create/update/delete
  // ─────────────────────────────────────────────

  it("PATCH /api/menu/categories/:id — should NOT allow User A to update Category B", async () => {
    const res = await request(app)
      .patch(`/api/menu/categories/${categoryB.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "Hacked Category" });
    // Prisma extension auto-scopes findFirst by restaurantId, so cross-tenant item is not found
    expect([403, 404]).toContain(res.status);
    console.log("  [SAFE] menu/categories-patch:", res.status, res.body?.error);
  });

  it("DELETE /api/menu/categories/:id — should NOT allow User A to delete Category B", async () => {
    const res = await request(app)
      .delete(`/api/menu/categories/${categoryB.id}`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(res.status);
    console.log("  [SAFE] menu/categories-delete:", res.status, res.body?.error);
  });

  // ─────────────────────────────────────────────
  // PUBLIC MENU GET — should still work with query param (no auth)
  // ─────────────────────────────────────────────

  it("GET /api/menu — should allow public access with restaurantId in query", async () => {
    const res = await request(app)
      .get(`/api/menu?restaurantId=${restaurantA.id}`);
    expect(res.status).toBe(200);
    console.log("  [PUBLIC] menu/get:", res.status);
  });

  it("GET /api/menu/items — should allow public access with restaurantId in query", async () => {
    const res = await request(app)
      .get(`/api/menu/items?restaurantId=${restaurantA.id}`);
    expect(res.status).toBe(200);
    console.log("  [PUBLIC] menu/items:", res.status);
  });
});
