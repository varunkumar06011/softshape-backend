import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/auth";
import type { AuthRequest } from "../middleware/auth";

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("[Auth] FATAL: JWT_SECRET is not set");
}

function signToken(payload: { id: string; role: string; restaurantId: string; name: string; email: string }, expiresInSeconds: number) {
  return jwt.sign(payload, JWT_SECRET!, { expiresIn: expiresInSeconds });
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password, restaurantId } = req.body;
    if (!email || !password) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const user = await prisma.staffUser.findFirst({
      where: {
        email: email.trim().toLowerCase(),
        isActive: true,
        ...(restaurantId ? { restaurantId } : {}),
      },
    });

    if (!user || !user.passwordHash) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = signToken(
      { id: user.id, role: user.role, restaurantId: user.restaurantId, name: user.name, email: user.email },
      8 * 3600
    );

    res.json({
      token,
      user: { id: user.id, role: user.role, restaurantId: user.restaurantId, name: user.name, email: user.email },
      expiresIn: 8 * 3600,
    });
  } catch (err: any) {
    console.error("[Auth] login error:", err.message);
    res.status(401).json({ error: "Invalid credentials" });
  }
});

// POST /api/auth/captain-login
router.post("/captain-login", async (req, res) => {
  try {
    const { captainName, pin, restaurantId } = req.body;
    if (!captainName || !pin) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const user = await prisma.staffUser.findFirst({
      where: {
        name: captainName.trim(),
        role: "CAPTAIN",
        isActive: true,
        restaurantId: restaurantId || "restaurant-001",
      },
    });

    if (!user || !user.pin) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const valid = await bcrypt.compare(pin, user.pin);
    if (!valid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = signToken(
      { id: user.id, role: user.role, restaurantId: user.restaurantId, name: user.name, email: user.email },
      12 * 3600
    );

    res.json({
      token,
      user: { id: user.id, role: user.role, restaurantId: user.restaurantId, name: user.name, email: user.email },
      expiresIn: 12 * 3600,
    });
  } catch (err: any) {
    console.error("[Auth] captain-login error:", err.message);
    res.status(401).json({ error: "Invalid credentials" });
  }
});

// GET /api/auth/me
router.get("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const user = await prisma.staffUser.findUnique({
      where: { id: req.user.id },
      select: { id: true, restaurantId: true, email: true, role: true, name: true, isActive: true, createdAt: true, updatedAt: true },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(user);
  } catch (err: any) {
    console.error("[Auth] me error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/auth/logout
router.post("/logout", authenticate, (_req: AuthRequest, res) => {
  // Token invalidation is client-side for now (stateless JWT).
  // A Redis token blacklist can be added later for instant revocation.
  res.json({ success: true });
});

export default router;
