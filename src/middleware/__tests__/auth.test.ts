/**
 * Tests for auth middleware — authenticate, optionalAuth, requireRole
 * Run: npx vitest run src/middleware/__tests__/auth.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-change-me";

// Mock cache module — must be before any imports that use it
vi.mock("../../lib/cache", () => ({
  cacheGet: vi.fn().mockResolvedValue(true),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelete: vi.fn().mockResolvedValue(undefined),
}));

// Mock prisma to avoid DB connection
vi.mock("../../lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ isActive: true }),
    },
  },
}));

describe("Auth Middleware", () => {
  let app: express.Express;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    const { authenticate, optionalAuth, requireRole } = await import("../auth");

    app = express();
    app.use(express.json());

    // Route that requires authentication
    app.get("/protected", authenticate, (req: any, res) => {
      res.json({ user: req.user });
    });

    // Route with optional auth
    app.get("/optional", optionalAuth, (req: any, res) => {
      res.json({ user: req.user ?? null });
    });

    // Route that requires OWNER role
    app.get("/owner-only", authenticate, requireRole("OWNER"), (req: any, res) => {
      res.json({ ok: true });
    });

    // Route that requires CASHIER or OWNER
    app.get("/cashier-or-owner", authenticate, requireRole("CASHIER", "OWNER"), (req: any, res) => {
      res.json({ ok: true });
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  function signToken(payload: any) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });
  }

  describe("authenticate", () => {
    it("should reject requests without Authorization header", async () => {
      const res = await request(app).get("/protected");
      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it("should reject requests with malformed Authorization header", async () => {
      const res = await request(app).get("/protected").set("Authorization", "Basic abc");
      expect(res.status).toBe(401);
    });

    it("should reject requests with invalid JWT token", async () => {
      const res = await request(app).get("/protected").set("Authorization", "Bearer invalid-token");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid or expired token");
    });

    it("should accept requests with valid JWT token", async () => {
      const token = signToken({ userId: "u1", role: "OWNER", restaurantId: "r1", slug: "test" });
      const res = await request(app).get("/protected").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.user.userId).toBe("u1");
    });
  });

  describe("optionalAuth", () => {
    it("should pass through without auth header", async () => {
      const res = await request(app).get("/optional");
      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });

    it("should set req.user when valid token is provided", async () => {
      const token = signToken({ userId: "u2", role: "CASHIER", restaurantId: "r1", slug: "test" });
      const res = await request(app).get("/optional").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.user).not.toBeNull();
      expect(res.body.user.userId).toBe("u2");
    });

    it("should pass through with invalid token without error", async () => {
      const res = await request(app).get("/optional").set("Authorization", "Bearer invalid");
      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });
  });

  describe("requireRole", () => {
    it("should reject when no user is set (no auth)", async () => {
      const res = await request(app).get("/owner-only");
      expect(res.status).toBe(401);
    });

    it("should allow when user has required role", async () => {
      const token = signToken({ userId: "u1", role: "OWNER", restaurantId: "r1", slug: "test" });
      const res = await request(app).get("/owner-only").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("should reject when user has wrong role", async () => {
      const token = signToken({ userId: "u2", role: "CASHIER", restaurantId: "r1", slug: "test" });
      const res = await request(app).get("/owner-only").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Insufficient permissions");
    });

    it("should allow when user has one of multiple required roles", async () => {
      const token = signToken({ userId: "u3", role: "CASHIER", restaurantId: "r1", slug: "test" });
      const res = await request(app).get("/cashier-or-owner").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });
});
