import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { basePrisma } from "../../lib/prisma";
import { authRouter } from "../auth";
import { onboardRouter } from "../onboard";
import { hashPassword } from "../../lib/auth";
import { issueVerificationProof } from "../../lib/verificationToken";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/onboard", onboardRouter);
  return app;
}

describe("Onboarding Data-Loss Protection", () => {
  let app: ReturnType<typeof createTestApp>;

  // First tenant fixtures
  let org: any;
  let outlet1: any;
  let user1: any;
  let payment1: any;
  let sessionId1: string;

  beforeAll(async () => {
    app = createTestApp();

    // Clean slate
    await basePrisma.outletAccess.deleteMany({});
    await basePrisma.user.deleteMany({});
    await basePrisma.outlet.deleteMany({});
    await basePrisma.organization.deleteMany({});
    await basePrisma.onboardingPayment.deleteMany({});

    const now = Date.now();
    sessionId1 = `session-1-${now}`;

    // Create a first tenant (simulating a completed onboarding)
    org = await basePrisma.organization.create({
      data: {
        name: "First Restaurant Org",
        plan: "starter",
        billingStatus: "active",
        paymentStatus: "PAID",
      },
    });

    outlet1 = await basePrisma.outlet.create({
      data: {
        name: "First Restaurant",
        slug: `first-${now}`,
        restaurantCode: `F1${now}`,
        organizationId: org.id,
        isActive: true,
      },
    });

    const hash = await hashPassword("OriginalPass123!");
    user1 = await basePrisma.user.create({
      data: {
        name: "First Owner",
        email: `owner-${now}@test.com`,
        passwordHash: hash,
        role: "OWNER",
        outletId: outlet1.id,
        isActive: true,
      },
    });

    await basePrisma.outletAccess.create({
      data: { userId: user1.id, outletId: outlet1.id, role: "OWNER" },
    });

    // Create the original payment record linked to this outlet
    payment1 = await basePrisma.onboardingPayment.create({
      data: {
        sessionId: sessionId1,
        restaurantId: outlet1.id,
        plan: "starter",
        numberOfOutlets: 1,
        amount: 0,
        currency: "INR",
        gateway: "MOCK",
        status: "SUCCESS",
      },
    });
  });

  afterAll(async () => {
    await basePrisma.outletAccess.deleteMany({});
    await basePrisma.user.deleteMany({});
    await basePrisma.outlet.deleteMany({});
    await basePrisma.organization.deleteMany({});
    await basePrisma.onboardingPayment.deleteMany({});
    await basePrisma.$disconnect();
  });

  it("rejects onboarding with an existing email and a different session/payment — 409, no data loss", async () => {
    // Create a second payment with a different session
    const sessionId2 = `session-2-${Date.now()}`;
    const payment2 = await basePrisma.onboardingPayment.create({
      data: {
        sessionId: sessionId2,
        plan: "starter",
        numberOfOutlets: 1,
        amount: 0,
        currency: "INR",
        gateway: "MOCK",
        status: "SUCCESS",
      },
    });

    const phoneProof = issueVerificationProof("phone", "9999999999", sessionId2);

    const payload = {
      restaurant: {
        name: "Attacker Restaurant",
        phone: "9999999999",
        restaurantType: "DINE_IN",
        outletCount: 1,
        barUnitMl: 30,
        fullBottleMl: 750,
        halfBottleMl: 375,
      },
      branding: { receiptHeader: "Test" },
      owner: {
        name: "Attacker Owner",
        email: user1.email,
        phone: "9999999999",
        password: "AttackerPass123!",
        termsAccepted: true,
      },
      captains: [],
      cashiers: [{ name: "Test Cashier", pin: "1234" }],
      sections: [{ name: "Main Hall" }],
      tables: [{ number: 1, capacity: 4, sectionIndex: 0 }],
      menu: {
        categories: [
          {
            name: "Starters",
            items: [{ name: "Test Item", price: 100, isVeg: true }],
          },
        ],
      },
      plan: "starter",
      paymentReference: payment2.id,
      sessionId: sessionId2,
      phoneVerificationProof: phoneProof,
    };

    const res = await request(app).post("/api/onboard").send(payload);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already registered");

    // Verify the original tenant is untouched
    const survivingUser = await basePrisma.user.findUnique({ where: { id: user1.id } });
    expect(survivingUser).not.toBeNull();
    expect(survivingUser!.email).toBe(user1.email);

    const survivingOutlet = await basePrisma.outlet.findUnique({ where: { id: outlet1.id } });
    expect(survivingOutlet).not.toBeNull();
    expect(survivingOutlet!.name).toBe("First Restaurant");

    // Cleanup
    await basePrisma.onboardingPayment.delete({ where: { id: payment2.id } });
  });

  it("allows re-onboarding with the same email when sessionId matches the linked payment — legitimate retry", async () => {
    // Use the same sessionId as the original — this simulates a retry of a failed onboarding
    const phoneProof = issueVerificationProof("phone", "9999999999", sessionId1);

    const payload = {
      restaurant: {
        name: "Retry Restaurant",
        phone: "9999999999",
        restaurantType: "DINE_IN",
        outletCount: 1,
        barUnitMl: 30,
        fullBottleMl: 750,
        halfBottleMl: 375,
      },
      branding: { receiptHeader: "Test" },
      owner: {
        name: "Retry Owner",
        email: user1.email,
        phone: "9999999999",
        password: "RetryPass123!",
        termsAccepted: true,
      },
      captains: [],
      cashiers: [{ name: "Test Cashier", pin: "1234" }],
      sections: [{ name: "Main Hall" }],
      tables: [{ number: 1, capacity: 4, sectionIndex: 0 }],
      menu: {
        categories: [
          {
            name: "Starters",
            items: [{ name: "Test Item", price: 100, isVeg: true }],
          },
        ],
      },
      plan: "starter",
      paymentReference: payment1.id,
      sessionId: sessionId1,
      phoneVerificationProof: phoneProof,
    };

    // This should NOT be rejected with 409 (it may fail later for other reasons like
    // the payment already having a restaurantId, but the email check should pass)
    const res = await request(app).post("/api/onboard").send(payload);

    // The email-reuse check should pass — we expect either success or a different error
    // (e.g., 409 from the idempotency guard since payment1 already has restaurantId)
    if (res.status === 409) {
      // If 409, it should be from the idempotency guard, not the email check
      expect(res.body.error).not.toContain("already registered");
    }
  });
});
