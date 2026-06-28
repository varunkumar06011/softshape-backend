// ─────────────────────────────────────────────────────────────────────────────
// Auth Middleware — JWT Authentication & Role-Based Access Control
// ─────────────────────────────────────────────────────────────────────────────
// Provides Express middleware functions for authentication:
//   1. authenticate     — requires a valid JWT, rejects if missing/invalid/inactive
//   2. optionalAuth     — parses JWT if present, but doesn't require it
//   3. authenticatePreAuth — validates pre-auth tokens (for outlet selection flow)
//   4. authenticateForOutletSwitch — accepts both pre-auth and regular JWTs
//   5. requireRole      — role-based authorization (OWNER, ADMIN, CAPTAIN, etc.)
//
// All auth functions check isUserActive() to ensure deactivated users can't
// access the API even with a valid (unexpired) JWT. Active status is cached
// in Redis for 60 seconds to avoid DB queries on every request.
//
// JWT_SECRET must be set — hard fail at module load if missing.
// ─────────────────────────────────────────────────────────────────────────────

import { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { cacheGet, cacheSet, cacheDelete } from "../lib/cache";
import prisma from "../lib/prisma";

// Authenticated user structure extracted from JWT payload
export interface AuthUser {
  userId: string;                    // User's database ID
  role: string;                      // Role: OWNER, ADMIN, CAPTAIN, CASHIER, etc.
  /** @deprecated Use activeRestaurantId */
  restaurantId: string;              // Home restaurant (legacy, use activeRestaurantId)
  activeRestaurantId?: string;       // Currently selected outlet (for multi-outlet users)
  organizationId?: string;           // Organization ID (for multi-outlet management)
  restaurantCode?: string | null;    // Restaurant join code
  slug: string;                      // Restaurant URL slug
  email?: string;                    // User's email
  name?: string;                     // User's display name
}

// Express Request augmented with the authenticated user
export interface AuthRequest extends Request {
  user?: AuthUser;
}

// JWT secret — hard fail if not set
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("[Auth] FATAL: JWT_SECRET is not set. Set it in Railway environment variables before starting the server.");
}

// Cache TTL for user active status (60 seconds)
const ACTIVE_CACHE_TTL = 60; // seconds
// Redis cache key for user active status
const activeCacheKey = (userId: string) => `auth:active:${userId}`;

// Checks if a user account is active (not deactivated).
// Results are cached in Redis for 60 seconds to avoid DB queries on every request.
// Returns true if the user exists and isActive is true.
async function isUserActive(userId: string): Promise<boolean> {
  const cached = await cacheGet<boolean>(activeCacheKey(userId));
  if (cached !== null) return cached;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isActive: true },
  });
  const active = !!user?.isActive;
  await cacheSet(activeCacheKey(userId), active, ACTIVE_CACHE_TTL);
  return active;
}

// Invalidates the cached active status for a user.
// Call this when a user is deactivated/reactivated to ensure immediate effect.
export async function invalidateUserActiveCache(userId: string): Promise<void> {
  await cacheDelete(activeCacheKey(userId));
}

// ── authenticate ─────────────────────────────────────────────────────────────
// Requires a valid Bearer JWT. Returns 401 if:
//   - No Authorization header or not Bearer type
//   - Token is invalid or expired
//   - User account has been deactivated
// On success, populates req.user with the decoded JWT payload.
export async function authenticate(req: any, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET!) as unknown as AuthUser;
    const active = await isUserActive(decoded.userId);
    if (!active) {
      res.status(401).json({ error: "Account has been deactivated" });
      return;
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── optionalAuth ──────────────────────────────────────────────────────────────
// Parses JWT if present but doesn't require it. If the token is valid and the
// user is active, populates req.user. If invalid or missing, continues without
// req.user (route handler can check req.user to determine auth state).
// Used for routes that serve both authenticated and anonymous requests (e.g. public menu).
export async function optionalAuth(req: any, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    next();
    return;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET!) as unknown as AuthUser;
    const active = await isUserActive(decoded.userId);
    if (active) {
      req.user = decoded;
    }
  } catch {
    // ignore invalid token for optional auth
  }
  next();
}

// ── authenticatePreAuth ──────────────────────────────────────────────────────
// Validates a pre-auth token (tokenType: 'PRE_AUTH_OUTLET_SELECT').
// These tokens are issued after email+password verification but before outlet
// selection. They allow the user to access the outlet selection endpoint only.
// Returns 401 if the token is not a pre-auth token or is invalid.
export async function authenticatePreAuth(req: any, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET!) as any;
    if (decoded.tokenType !== "PRE_AUTH_OUTLET_SELECT") {
      res.status(401).json({ error: "Invalid token type" });
      return;
    }
    const active = await isUserActive(decoded.userId);
    if (!active) {
      res.status(401).json({ error: "Account has been deactivated" });
      return;
    }
    req.user = { userId: decoded.userId, email: decoded.email, role: "", restaurantId: "", slug: "" };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── authenticateForOutletSwitch ──────────────────────────────────────────────
// Accepts both pre-auth and regular JWTs. Used by the outlet switch endpoint
// which can be called either before (pre-auth) or after (regular) outlet selection.
// If the token is a pre-auth token, populates req.user with minimal fields.
// Otherwise, populates req.user with the full decoded JWT payload.
export async function authenticateForOutletSwitch(req: any, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET!) as any;
    const active = await isUserActive(decoded.userId);
    if (!active) {
      res.status(401).json({ error: "Account has been deactivated" });
      return;
    }
    if (decoded.tokenType === "PRE_AUTH_OUTLET_SELECT") {
      req.user = { userId: decoded.userId, email: decoded.email, role: "", restaurantId: "", slug: "" };
    } else {
      req.user = decoded as AuthUser;
    }
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── requireRole ──────────────────────────────────────────────────────────────
// Role-based authorization middleware factory.
// Returns a middleware that checks req.user.role against the allowed roles.
// Must be used AFTER authenticate (which populates req.user).
// Returns 401 if not authenticated, 403 if role is not in the allowed list.
//
// Usage:
//   router.delete('/item/:id', authenticate, requireRole('OWNER', 'ADMIN'), handler);
export function requireRole(...roles: string[]) {
  return (req: any, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}
