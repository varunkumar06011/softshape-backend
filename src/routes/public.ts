// ─────────────────────────────────────────────────────────────────────────────
// Public Routes — Customer-facing endpoints (no auth required)
// ─────────────────────────────────────────────────────────────────────────────
// Provides endpoints for customer-facing interactions from the QR code menu:
//   POST /api/public/call-waiter — customer calls a waiter from their table
//
// Security:
//   - HMAC signature verification on table QR URLs prevents URL tampering
//   - Rate limiting per IP (5 waiter calls/min, 30 menu fetches/min)
//   - DB-based cooldown (15 seconds between waiter calls from the same table)
//   - Cross-validation of slug + tableId to prevent mixing restaurants
//
// Waiter calls are emitted to the restaurant's staff socket room in real-time.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import logger from "../lib/logger";
import rateLimit from "express-rate-limit";
import prisma, { basePrisma } from "../lib/prisma";
import { getIo } from "../socket";
import { resolvePublicRestaurant } from "../lib/resolvePublicRestaurant";
import { verifyTableSignature } from "../lib/tableSignature";
import { optionalAuth } from "../middleware/auth";
import { cacheGet, cacheSet } from "../lib/cache";

const router = Router();

// Tight rate limiter for waiter calls — 5 per IP per minute.
// Prevents spam from a single customer or malicious actor.
const waiterCallLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || "unknown",
  message: { success: false, error: "Too many waiter calls, please wait" },
});

// Looser limiter for menu fetches — 30 per IP per minute
const publicMenuLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || "unknown",
  message: { error: "Too many requests" },
});

// Cooldown between waiter calls from the same table (15 seconds).
// Enforced via the Table.lastWaiterCallAt DB field.
const COOLDOWN_MS = 15_000;

/**
 * POST /api/public/call-waiter
 *
 * Body: { slug, tableId, sig, callId, source }
 *
 * Validates HMAC signature, resolves restaurant+table, enforces DB-based
 * cooldown, and emits waiter:event to the restaurant's staff socket room.
 */
router.post("/call-waiter", waiterCallLimiter, async (req, res) => {
  try {
    const { slug, tableId, sig, callId, source } = req.body;

    if (!slug || !tableId || !sig || !callId) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    // Resolve restaurant + cross-validate table belongs to it
    const resolved = await resolvePublicRestaurant(tableId, slug);
    if (!resolved) {
      return res.status(404).json({ success: false, error: "Restaurant or table not found" });
    }

    // Verify HMAC signature
    if (!verifyTableSignature(slug, tableId, resolved.restaurantId, sig)) {
      return res.status(403).json({ success: false, error: "Invalid table signature" });
    }

    // Check cooldown via DB field
    const table = await prisma.table.findUnique({
      where: { id: tableId },
      select: { number: true, lastWaiterCallAt: true },
    });

    if (!table) {
      return res.status(404).json({ success: false, error: "Table not found" });
    }

    if (table.lastWaiterCallAt) {
      const elapsed = Date.now() - table.lastWaiterCallAt.getTime();
      if (elapsed < COOLDOWN_MS) {
        const retryAfter = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({
          success: false,
          reason: "COOLDOWN",
          retryAfter,
          message: `Please wait ${retryAfter}s before calling again`,
        });
      }
    }

    // Update lastWaiterCallAt
    await prisma.table.update({
      where: { id: tableId },
      data: { lastWaiterCallAt: new Date() },
    });

    // Emit waiter:event to the restaurant's staff room
    const io = getIo();
    const payload = {
      tableId,
      tableNumber: table.number,
      callId,
      timestamp: Date.now(),
      source: source || "restaurant",
      restaurantId: resolved.restaurantId,
    };

    io.to(resolved.restaurantId).emit("waiter:event", {
      type: "customer:call_waiter",
      payload,
    });

    logger.info(
      `[call-waiter] Table ${table.number} (id: ${tableId}) called waiter — ` +
      `restaurant: ${resolved.restaurantId}, source: ${source}`
    );

    res.json({ success: true, callId, tableNumber: table.number });
  } catch (error) {
    logger.error({ err: error }, "[call-waiter]");
    res.status(500).json({ success: false, error: "Failed to process waiter call" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Public Announcements — active banners for admin UI (no auth required)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/announcements — returns active announcements for the requesting outlet
router.get("/announcements", optionalAuth, async (req: any, res) => {
  try {
    const now = new Date();
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;

    const announcements = await basePrisma.announcement.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ activeFrom: null }, { activeFrom: { lte: now } }] },
          { OR: [{ activeUntil: null }, { activeUntil: { gte: now } }] },
        ],
      },
      orderBy: { createdAt: "desc" },
    });

    const filtered = restaurantId
      ? announcements.filter(a => a.target === "all" || a.target === restaurantId)
      : announcements.filter(a => a.target === "all");

    return res.json({ announcements: filtered });
  } catch (error) {
    logger.error({ err: error }, "[public/announcements]");
    return res.status(500).json({ error: "Failed to fetch announcements" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Public Feature Flags — returns whether a flag is enabled for a restaurant
// ─────────────────────────────────────────────────────────────────────────────

const FLAG_CACHE_TTL = 60; // 60 seconds

// GET /api/feature-flags/:key — returns { key, enabled } for the requesting outlet
router.get("/feature-flags/:key", optionalAuth, async (req: any, res) => {
  try {
    const { key } = req.params;
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;
    const cacheKey = `ff:${key}:${restaurantId ?? "anon"}`;

    const cached = await cacheGet<{ key: string; enabled: boolean }>(cacheKey);
    if (cached) return res.json(cached);

    const flag = await basePrisma.featureFlag.findUnique({ where: { key } });
    if (!flag) {
      const result = { key, enabled: false };
      await cacheSet(cacheKey, result, FLAG_CACHE_TTL);
      return res.json(result);
    }

    const enabled = flag.enabledGlobally || (restaurantId ? flag.enabledRestaurants.includes(restaurantId) : false);
    const result = { key, enabled };
    await cacheSet(cacheKey, result, FLAG_CACHE_TTL);
    return res.json(result);
  } catch (error) {
    logger.error({ err: error }, "[public/feature-flags]");
    return res.status(500).json({ error: "Failed to fetch feature flag" });
  }
});

export { router as publicRouter };
