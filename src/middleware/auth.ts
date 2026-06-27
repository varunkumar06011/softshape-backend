import { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { cacheGet, cacheSet, cacheDelete } from "../lib/cache";
import prisma from "../lib/prisma";

export interface AuthUser {
  userId: string;
  role: string;
  /** @deprecated Use activeRestaurantId */
  restaurantId: string;
  activeRestaurantId?: string;
  organizationId?: string;
  restaurantCode?: string | null;
  slug: string;
  email?: string;
  name?: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("[Auth] FATAL: JWT_SECRET is not set. Set it in Railway environment variables before starting the server.");
}

const ACTIVE_CACHE_TTL = 60; // seconds
const activeCacheKey = (userId: string) => `auth:active:${userId}`;

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

export async function invalidateUserActiveCache(userId: string): Promise<void> {
  await cacheDelete(activeCacheKey(userId));
}

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
