import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { basePrisma } from "../../lib/prisma";
import { authRouter } from "../auth";
import { authenticate } from "../../middleware/auth";
import { withTenantContext } from "../../middleware/tenantContext";
import tablesRouter from "../tables";
import { hashPassword } from "../../lib/auth";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-change-me";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/tables", authenticate, withTenantContext, tablesRouter);
  return app;
}

describe("Organization, Outlet & OutletAccess Integration", () => {
  let app: ReturnType<typeof createTestApp>;

  // Test fixtures
  let org: any;
  let outletA: any;
  let outletB: any;
  let ownerUser: any;
  let singleOutletUser: any;
  let ownerPassword: string;
  let singleOutletPassword: string;

  beforeAll(async () => {
    app = createTestApp();
    ownerPassword = "TestPass123!";
    singleOutletPassword = "SinglePass123!";

    // Clean slate — use basePrisma to bypass tenant scoping during setup
    await basePrisma.outletAccess.deleteMany({});
    await basePrisma.user.deleteMany({});
    await basePrisma.outlet.deleteMany({});
    await basePrisma.organization.deleteMany({});

    const now = Date.now();

    // 1. Organization holds billing fields; Outlet does NOT
    org = await basePrisma.organization.create({
      data: {
        name: "Test Org",
        plan: "starter",
        billingStatus: "active",
        paymentStatus: "PAID",
      },
    });

    outletA = await basePrisma.outlet.create({
      data: {
        name: "Outlet A",
        slug: `outlet-a-${now}`,
        restaurantCode: `A${now}`,
        organizationId: org.id,
        isActive: true,
      },
    });

    outletB = await basePrisma.outlet.create({
      data: {
        name: "Outlet B",
        slug: `outlet-b-${now}`,
        restaurantCode: `B${now}`,
        organizationId: org.id,
        isActive: true,
      },
    });

    // 2. Owner user with access to BOTH outlets
    const ownerHash = await hashPassword(ownerPassword);
    ownerUser = await basePrisma.user.create({
      data: {
        name: "Multi Outlet Owner",
        email: `multi-${now}@test.com`,
        passwordHash: ownerHash,
        role: "OWNER",
        outletId: outletA.id,
        isActive: true,
      },
    });

    await basePrisma.outletAccess.create({
      data: { userId: ownerUser.id, outletId: outletA.id, role: "OWNER" },
    });
    await basePrisma.outletAccess.create({
      data: { userId: ownerUser.id, outletId: outletB.id, role: "OWNER" },
    });

    // 3. Single-outlet user
    const singleHash = await hashPassword(singleOutletPassword);
    singleOutletUser = await basePrisma.user.create({
      data: {
        name: "Single Outlet Owner",
        email: `single-${now}@test.com`,
        passwordHash: singleHash,
        role: "OWNER",
        outletId: outletA.id,
        isActive: true,
      },
    });

    await basePrisma.outletAccess.create({
      data: { userId: singleOutletUser.id, outletId: outletA.id, role: "OWNER" },
    });
  });

  afterAll(async () => {
    await basePrisma.outletAccess.deleteMany({});
    await basePrisma.user.deleteMany({});
    await basePrisma.outlet.deleteMany({});
    await basePrisma.organization.deleteMany({});
    await basePrisma.$disconnect();
  });

  // ── Schema / Model Assertions ────────────────────────────────────────────

  it("Organization model stores billingStatus; Outlet does not", async () => {
    const fetchedOrg = await basePrisma.organization.findUnique({
      where: { id: org.id },
      select: { billingStatus: true, paymentStatus: true },
    });
    expect(fetchedOrg?.billingStatus).toBe("active");
    expect(fetchedOrg?.paymentStatus).toBe("PAID");

    // Outlet should not have billing fields (TypeScript compile-time guard)
    // Runtime: ensure Outlet row has no billingStatus key
    const fetchedOutlet = await basePrisma.outlet.findUnique({
      where: { id: outletA.id },
    });
    expect(fetchedOutlet).not.toHaveProperty("billingStatus");
    expect(fetchedOutlet?.organizationId).toBe(org.id);
  });

  it("OutletAccess model has @@unique([userId, outletId]) enforced", async () => {
    // Duplicate insert should throw unique-constraint error
    let errorCaught = false;
    try {
      await basePrisma.outletAccess.create({
        data: { userId: ownerUser.id, outletId: outletA.id, role: "OWNER" },
      });
    } catch (e: any) {
      errorCaught = true;
      expect(e.code).toBe("P2002"); // Prisma unique constraint violation
    }
    expect(errorCaught).toBe(true);
  });

  it("OutletAccess indexes allow fast lookup by userId and by outletId", async () => {
    const byUser = await basePrisma.outletAccess.findMany({
      where: { userId: ownerUser.id },
    });
    expect(byUser.length).toBe(2);

    const byOutlet = await basePrisma.outletAccess.findMany({
      where: { outletId: outletB.id },
    });
    expect(byOutlet.length).toBe(1);
    expect(byOutlet[0].userId).toBe(ownerUser.id);
  });

  // ── Login & Multi-Outlet Flow ────────────────────────────────────────────

  it("POST /api/auth/login — multi-outlet user returns preAuthToken and accessibleOutlets", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: ownerUser.email,
      password: ownerPassword,
      restaurantCode: outletA.restaurantCode,
    });

    expect(res.status).toBe(200);
    expect(res.body.accessibleOutlets).toBeDefined();
    expect(res.body.accessibleOutlets.length).toBe(2);
    expect(res.body.preAuthToken).toBeDefined();
    expect(res.body.token).toBeUndefined();

    const ids = res.body.accessibleOutlets.map((o: any) => o.id);
    expect(ids).toContain(outletA.id);
    expect(ids).toContain(outletB.id);

    // Verify the preAuthToken has the correct type and no role/restaurantId
    const decoded = jwt.decode(res.body.preAuthToken) as any;
    expect(decoded.tokenType).toBe("PRE_AUTH_OUTLET_SELECT");
    expect(decoded.userId).toBe(ownerUser.id);
    expect(decoded.role).toBeUndefined();
    expect(decoded.restaurantId).toBeUndefined();
  });

  it("POST /api/auth/login — preAuthToken is rejected by other authenticated routes", async () => {
    const loginRes = await request(app).post("/api/auth/login").send({
      email: ownerUser.email,
      password: ownerPassword,
      restaurantCode: outletA.restaurantCode,
    });

    expect(loginRes.body.preAuthToken).toBeDefined();

    // Try to use the preAuthToken on a normal authenticated route (GET /api/tables)
    const res = await request(app)
      .get("/api/tables")
      .set("Authorization", `Bearer ${loginRes.body.preAuthToken}`);

    expect(res.status).toBe(401);
  });

  it("POST /api/auth/login — single-outlet user returns token directly", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: singleOutletUser.email,
      password: singleOutletPassword,
      restaurantCode: outletA.restaurantCode,
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.accessibleOutlets).toBeUndefined();

    const decoded = jwt.decode(res.body.token) as any;
    expect(decoded.userId).toBe(singleOutletUser.id);
    expect(decoded.restaurantId).toBe(outletA.id);
    expect(decoded.organizationId).toBe(org.id);
  });

  // ── Switch-Outlet Endpoint ───────────────────────────────────────────────

  it("POST /api/auth/switch-outlet — switches to an accessible outlet using preAuthToken and returns new token with activeRestaurantId", async () => {
    // First login to get a preAuthToken
    const loginRes = await request(app).post("/api/auth/login").send({
      email: ownerUser.email,
      password: ownerPassword,
      restaurantCode: outletA.restaurantCode,
    });

    // Multi-outlet user gets preAuthToken + accessibleOutlets
    expect(loginRes.body.preAuthToken).toBeDefined();
    expect(loginRes.body.accessibleOutlets).toBeDefined();

    // Use the preAuthToken to switch to outletB
    const res = await request(app)
      .post("/api/auth/switch-outlet")
      .set("Authorization", `Bearer ${loginRes.body.preAuthToken}`)
      .send({ outletId: outletB.id });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.restaurantId).toBe(outletB.id);
    expect(res.body.restaurant.id).toBe(outletB.id);

    const decoded = jwt.decode(res.body.token) as any;
    expect(decoded.activeRestaurantId).toBe(outletB.id);
    expect(decoded.restaurantId).toBe(outletA.id); // preserved home outlet
    expect(decoded.organizationId).toBe(org.id);
    expect(decoded.tokenType).toBeUndefined(); // full token, not pre-auth
  });

  it("POST /api/auth/switch-outlet — uses per-outlet role from OutletAccess, not base User.role", async () => {
    // Create a user who is ADMIN at outletA but CASHIER at outletB
    const mixedPassword = "MixedPass123!";
    const mixedHash = await hashPassword(mixedPassword);
    const mixedUser = await basePrisma.user.create({
      data: {
        name: "Mixed Role User",
        email: `mixed-${Date.now()}@test.com`,
        passwordHash: mixedHash,
        role: "ADMIN",
        outletId: outletA.id,
        isActive: true,
      },
    });
    await basePrisma.outletAccess.create({
      data: { userId: mixedUser.id, outletId: outletA.id, role: "ADMIN" },
    });
    await basePrisma.outletAccess.create({
      data: { userId: mixedUser.id, outletId: outletB.id, role: "CASHIER" },
    });

    // Login — multi-outlet, gets preAuthToken
    const loginRes = await request(app).post("/api/auth/login").send({
      email: mixedUser.email,
      password: mixedPassword,
      restaurantCode: outletA.restaurantCode,
    });
    expect(loginRes.body.preAuthToken).toBeDefined();

    // Switch to outletB — should get CASHIER role, not ADMIN
    const switchRes = await request(app)
      .post("/api/auth/switch-outlet")
      .set("Authorization", `Bearer ${loginRes.body.preAuthToken}`)
      .send({ outletId: outletB.id });

    expect(switchRes.status).toBe(200);
    expect(switchRes.body.user.role).toBe("CASHIER");

    const decoded = jwt.decode(switchRes.body.token) as any;
    expect(decoded.role).toBe("CASHIER");

    // Cleanup
    await basePrisma.outletAccess.deleteMany({ where: { userId: mixedUser.id } });
    await basePrisma.user.delete({ where: { id: mixedUser.id } });
  });

  it("POST /api/auth/switch-outlet — returns 403 for outlet user has no access to", async () => {
    // Create a third outlet the user does NOT have access to
    const outletC = await basePrisma.outlet.create({
      data: {
        name: "Outlet C",
        slug: `outlet-c-${Date.now()}`,
        restaurantCode: `C${Date.now()}`,
        organizationId: org.id,
        isActive: true,
      },
    });

    const token = jwt.sign(
      {
        userId: ownerUser.id,
        restaurantId: outletA.id,
        role: "OWNER",
        slug: outletA.slug,
        organizationId: org.id,
      },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .post("/api/auth/switch-outlet")
      .set("Authorization", `Bearer ${token}`)
      .send({ outletId: outletC.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Access denied");

    await basePrisma.outlet.delete({ where: { id: outletC.id } });
  });

  it("POST /api/auth/switch-outlet — returns 404 for inactive outlet", async () => {
    const inactiveOutlet = await basePrisma.outlet.create({
      data: {
        name: "Inactive Outlet",
        slug: `inactive-${Date.now()}`,
        restaurantCode: `I${Date.now()}`,
        organizationId: org.id,
        isActive: false,
      },
    });

    // Give owner access to this outlet so the 403 is NOT triggered by missing access
    await basePrisma.outletAccess.create({
      data: { userId: ownerUser.id, outletId: inactiveOutlet.id, role: "OWNER" },
    });

    const token = jwt.sign(
      {
        userId: ownerUser.id,
        restaurantId: outletA.id,
        role: "OWNER",
        slug: outletA.slug,
        organizationId: org.id,
      },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .post("/api/auth/switch-outlet")
      .set("Authorization", `Bearer ${token}`)
      .send({ outletId: inactiveOutlet.id });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("inactive");

    await basePrisma.outletAccess.deleteMany({ where: { outletId: inactiveOutlet.id } });
    await basePrisma.outlet.delete({ where: { id: inactiveOutlet.id } });
  });

  // ── Tenant Context Middleware ────────────────────────────────────────────

  it("withTenantContext uses activeRestaurantId when present, falling back to restaurantId", async () => {
    // Create a table in outletB to verify scoping
    const sectionB = await basePrisma.section.create({
      data: { name: "Main", restaurantId: outletB.id },
    });
    const tableB = await basePrisma.table.create({
      data: { number: 99, capacity: 4, sectionId: sectionB.id, restaurantId: outletB.id, status: "AVAILABLE" },
    });

    // Token with activeRestaurantId = outletB but restaurantId = outletA
    const token = jwt.sign(
      {
        userId: ownerUser.id,
        restaurantId: outletA.id,
        activeRestaurantId: outletB.id,
        role: "OWNER",
        slug: outletB.slug,
        organizationId: org.id,
      },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    // GET /api/tables should scope to outletB (activeRestaurantId)
    const res = await request(app)
      .get("/api/tables")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // GET /api/tables returns sections with nested tables — flatten to get table IDs
    const tableIds = res.body.flatMap((s: any) => (s.tables ?? []).map((t: any) => t.id));
    expect(tableIds).toContain(tableB.id);

    await basePrisma.table.deleteMany({ where: { restaurantId: outletB.id } });
    await basePrisma.section.deleteMany({ where: { restaurantId: outletB.id } });
  });

  it("signToken embeds organizationId and activeRestaurantId into JWT", async () => {
    const { signToken } = await import("../../lib/auth");
    const token = signToken({
      userId: ownerUser.id,
      email: ownerUser.email,
      role: "OWNER",
      restaurantId: outletA.id,
      activeRestaurantId: outletB.id,
      restaurantCode: outletB.restaurantCode,
      slug: outletB.slug,
      organizationId: org.id,
    });

    const decoded = jwt.decode(token) as any;
    expect(decoded.organizationId).toBe(org.id);
    expect(decoded.activeRestaurantId).toBe(outletB.id);
    expect(decoded.restaurantId).toBe(outletA.id);
  });
});
