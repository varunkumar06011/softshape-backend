import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { basePrisma } from "../../lib/prisma";
import { authenticate } from "../../middleware/auth";
import { withTenantContext } from "../../middleware/tenantContext";
import tablesRouter from "../tables";
import { hashPassword } from "../../lib/auth";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-change-me";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/tables", authenticate, withTenantContext, tablesRouter);
  return app;
}

function makeToken(userId: string, role: string, restaurantId: string, slug: string, orgId: string) {
  return jwt.sign(
    { userId, role, restaurantId, slug, organizationId: orgId },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

describe("Discount Limit Enforcement", () => {
  let app: ReturnType<typeof createTestApp>;
  let org: any;
  let outlet: any;
  let captainUser: any;
  let cashierUser: any;
  let section: any;
  let table: any;
  let captainAssignment: any;

  beforeAll(async () => {
    app = createTestApp();

    await basePrisma.captainAssignment.deleteMany({});
    await basePrisma.outletAccess.deleteMany({});
    await basePrisma.user.deleteMany({});
    await basePrisma.table.deleteMany({});
    await basePrisma.section.deleteMany({});
    await basePrisma.outlet.deleteMany({});
    await basePrisma.organization.deleteMany({});

    const now = Date.now();
    org = await basePrisma.organization.create({
      data: { name: "Test Org", plan: "starter", billingStatus: "active", paymentStatus: "PAID" },
    });

    outlet = await basePrisma.outlet.create({
      data: {
        name: "Test Outlet",
        slug: `test-outlet-${now}`,
        restaurantCode: `T${now}`,
        organizationId: org.id,
        isActive: true,
      },
    });

    const captainHash = await hashPassword("1234");
    captainUser = await basePrisma.user.create({
      data: {
        name: "Test Captain",
        email: `captain-${now}@test.com`,
        pin: captainHash,
        role: "CAPTAIN",
        outletId: outlet.id,
        isActive: true,
      },
    });

    const cashierHash = await hashPassword("5678");
    cashierUser = await basePrisma.user.create({
      data: {
        name: "Test Cashier",
        email: `cashier-${now}@test.com`,
        pin: cashierHash,
        role: "CASHIER",
        outletId: outlet.id,
        isActive: true,
      },
    });

    captainAssignment = await basePrisma.captainAssignment.create({
      data: {
        restaurantId: outlet.id,
        captainId: captainUser.id,
        revenueTarget: 10000,
        discountLimit: 10,
      },
    });

    section = await basePrisma.section.create({
      data: { name: "Main Hall", restaurantId: outlet.id },
    });

    table = await basePrisma.table.create({
      data: { number: 1, capacity: 4, sectionId: section.id, restaurantId: outlet.id, status: "AVAILABLE" },
    });
  });

  afterAll(async () => {
    await basePrisma.captainAssignment.deleteMany({});
    await basePrisma.outletAccess.deleteMany({});
    await basePrisma.user.deleteMany({});
    await basePrisma.table.deleteMany({});
    await basePrisma.section.deleteMany({});
    await basePrisma.outlet.deleteMany({});
    await basePrisma.organization.deleteMany({});
    await basePrisma.$disconnect();
  });

  it("captain under discount limit — succeeds", async () => {
    const token = makeToken(captainUser.id, "CAPTAIN", outlet.id, outlet.slug, org.id);
    const res = await request(app)
      .patch(`/api/tables/${table.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ discount: 5 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.table.discount).toBe(5);
  });

  it("captain at exactly the discount limit — succeeds", async () => {
    const token = makeToken(captainUser.id, "CAPTAIN", outlet.id, outlet.slug, org.id);
    const res = await request(app)
      .patch(`/api/tables/${table.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ discount: 10 });

    expect(res.status).toBe(200);
    expect(res.body.table.discount).toBe(10);
  });

  it("captain over discount limit — rejected with 403", async () => {
    const token = makeToken(captainUser.id, "CAPTAIN", outlet.id, outlet.slug, org.id);
    const res = await request(app)
      .patch(`/api/tables/${table.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ discount: 15 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("limit");
  });

  it("captain with no assignment — rejected for any discount > 0", async () => {
    // Create a second captain with no assignment
    const now = Date.now();
    const hash = await hashPassword("9999");
    const unassignedCaptain = await basePrisma.user.create({
      data: {
        name: "Unassigned Captain",
        email: `unassigned-${now}@test.com`,
        pin: hash,
        role: "CAPTAIN",
        outletId: outlet.id,
        isActive: true,
      },
    });

    const token = makeToken(unassignedCaptain.id, "CAPTAIN", outlet.id, outlet.slug, org.id);
    const res = await request(app)
      .patch(`/api/tables/${table.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ discount: 5 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("No discount limit");

    await basePrisma.user.delete({ where: { id: unassignedCaptain.id } });
  });

  it("cashier applying any discount — succeeds, no limit check", async () => {
    const token = makeToken(cashierUser.id, "CASHIER", outlet.id, outlet.slug, org.id);
    const res = await request(app)
      .patch(`/api/tables/${table.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ discount: 50 });

    expect(res.status).toBe(200);
    expect(res.body.table.discount).toBe(50);
  });

  it("setting discount to 0 — always succeeds regardless of role", async () => {
    const token = makeToken(captainUser.id, "CAPTAIN", outlet.id, outlet.slug, org.id);
    const res = await request(app)
      .patch(`/api/tables/${table.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ discount: 0 });

    expect(res.status).toBe(200);
    expect(res.body.table.discount).toBe(0);
  });

  it("kitchen role — rejected by requireRole middleware", async () => {
    const now = Date.now();
    const hash = await hashPassword("0000");
    const kitchenUser = await basePrisma.user.create({
      data: {
        name: "Kitchen Staff",
        email: `kitchen-${now}@test.com`,
        pin: hash,
        role: "KITCHEN",
        outletId: outlet.id,
        isActive: true,
      },
    });

    const token = makeToken(kitchenUser.id, "KITCHEN", outlet.id, outlet.slug, org.id);
    const res = await request(app)
      .patch(`/api/tables/${table.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ discount: 5 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Insufficient permissions");

    await basePrisma.user.delete({ where: { id: kitchenUser.id } });
  });
});
