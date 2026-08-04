// ─────────────────────────────────────────────────────────────────────────────
// Public Routes — Customer-facing endpoints (no auth required)
// ─────────────────────────────────────────────────────────────────────────────
// Provides endpoints for customer-facing interactions from the QR code menu:
//   POST /api/public/call-waiter — customer calls a waiter from their table
//   POST /api/public/accept-waiter-call — staff atomically claims a waiter call
//
// Security:
//   - HMAC signature verification on table QR URLs prevents URL tampering
//   - Rate limiting per IP (5 waiter calls/min, 30 menu fetches/min)
//   - DB-based cooldown (15 seconds between waiter calls from the same table)
//   - Cross-validation of slug + tableId to prevent mixing restaurants
//
// Waiter calls are emitted to the restaurant's staff socket room in real-time.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Response } from "express";
import logger from "../lib/logger";
import rateLimit from "express-rate-limit";
import prisma, { basePrisma } from "../lib/prisma";
import { getIo } from "../socket";
import { resolvePublicRestaurant } from "../lib/resolvePublicRestaurant";
import { verifyTableSignature } from "../lib/tableSignature";
import { optionalAuth, authenticate, type AuthRequest } from "../middleware/auth";
import { cacheGet, cacheSet, getRedisClient } from "../lib/cache";

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
 * GET /api/public/restaurant/:slug/outlets
 *
 * Returns active venues for the restaurant so the customer menu landing page
 * can decide whether to show food, bar, or both options.
 */
// ── Public: verify representative QR signature ──
router.get("/representative-qr/:slug/:entityId/:sig", publicMenuLimiter, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const entityId = String(req.params.entityId || "");
    const sig = String(req.params.sig || "");
    const restaurant = await basePrisma.outlet.findUnique({ where: { slug } });
    if (!restaurant || !restaurant.isActive) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const rep = await basePrisma.representativeQR.findFirst({
      where: { id: entityId, restaurantId: restaurant.id, isActive: true },
    });
    if (!rep) {
      return res.status(404).json({ error: "Representative QR not found" });
    }

    if (!verifyTableSignature(slug, entityId, restaurant.id, sig)) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    res.json({
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      slug: restaurant.slug,
      representativeId: rep.id,
      name: rep.name,
      outletType: rep.outletType,
    });
  } catch (err) {
    logger.error({ err }, "[public/representative-qr/verify]");
    res.status(500).json({ error: "Failed to verify representative QR" });
  }
});

// ── Public: call waiter from representative QR ──
router.post("/representative-call", waiterCallLimiter, async (req, res) => {
  try {
    const slug = String(req.body?.slug || "").trim();
    const entityId = String(req.body?.entityId || "").trim();
    const sig = String(req.body?.sig || "").trim();
    const callId = String(req.body?.callId || "").trim();
    const source = String(req.body?.source || "representative").trim();
    if (!slug || !entityId || !sig || !callId) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const restaurant = await basePrisma.outlet.findUnique({ where: { slug } });
    if (!restaurant || !restaurant.isActive) {
      return res.status(404).json({ success: false, error: "Restaurant not found" });
    }

    const rep = await basePrisma.representativeQR.findFirst({
      where: { id: entityId, restaurantId: restaurant.id, isActive: true },
    });
    if (!rep) {
      return res.status(404).json({ success: false, error: "Representative QR not found" });
    }

    if (!verifyTableSignature(slug, entityId, restaurant.id, sig)) {
      return res.status(403).json({ success: false, error: "Invalid signature" });
    }

    const lastCall = rep.lastCalledAt ? new Date(rep.lastCalledAt).getTime() : 0;
    const elapsed = Date.now() - lastCall;
    if (elapsed < COOLDOWN_MS) {
      const retryAfter = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      return res.status(429).json({ success: false, reason: "COOLDOWN", retryAfter });
    }

    await basePrisma.representativeQR.update({
      where: { id: rep.id },
      data: { lastCalledAt: new Date() },
    });

    const io = getIo();
    io.to(restaurant.id).emit("waiter:event", {
      type: "customer:representative_call",
      payload: {
        callId,
        representativeId: rep.id,
        representativeName: rep.name,
        outletType: rep.outletType,
        restaurantId: restaurant.id,
        source: source || "representative",
      },
    });

    res.json({ success: true, callId, representativeName: rep.name });
  } catch (err) {
    logger.error({ err }, "[public/representative-call]");
    res.status(500).json({ success: false, error: "Failed to process representative call" });
  }
});

router.get("/restaurant/:slug/outlets", publicMenuLimiter, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: "slug required" });

    const restaurant = await basePrisma.outlet.findUnique({
      where: { slug },
      select: { id: true, name: true, restaurantType: true, isActive: true }
    });
    if (!restaurant || !restaurant.isActive) {
      return res.status(404).json({ error: "Restaurant not found" });
    }

    const venues = await basePrisma.venue.findMany({
      where: { restaurantId: restaurant.id, isActive: true, isDeleted: false },
      select: { id: true, name: true, venueType: true },
      orderBy: { sortOrder: 'asc' }
    });

    // Fallback: if no venues exist, derive from restaurantType.
    const outletTypes = venues.length > 0
      ? venues.map(v => ({ id: v.id, name: v.name, type: v.venueType }))
      : [{ id: restaurant.id, name: restaurant.name, type: restaurant.restaurantType || 'DINE_IN' }];

    res.json({ restaurantId: restaurant.id, restaurantName: restaurant.name, outlets: outletTypes });
  } catch (error) {
    logger.error({ err: error }, "[public/outlets]");
    res.status(500).json({ error: "Failed to fetch outlets" });
  }
});

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
// Waiter Call Accept — server-authoritative atomic claim
// ─────────────────────────────────────────────────────────────────────────────
// In-memory fallback for the accept lock when Redis is not configured.
// Per-callId locks with TTL so abandoned accepts don't block forever.
const acceptLocksInMemory = new Map<string, { captainId: string; expiresAt: number }>();
const ACCEPT_LOCK_TTL_SEC = 120; // 2 minutes — long enough for the captain to reach the table

/**
 * POST /api/public/accept-waiter-call
 *
 * Staff-authenticated. Atomically claims a waiter call for the requesting captain.
 * Uses Redis SET NX (or in-memory Map fallback) so only the first captain wins;
 * concurrent accepts get a 409. The server then broadcasts the decision to all
 * captain panels via the restaurant's staff socket room — clients no longer
 * broadcast their own local guess.
 *
 * Body: { callId, tableId, captainName? }
 * Auth: Bearer JWT (CAPTAIN / CASHIER / ADMIN / OWNER)
 */
router.post("/accept-waiter-call", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { callId, tableId, captainName } = req.body || {};
    const captainId = req.user?.userId;
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;

    if (!callId || !tableId || !captainId || !restaurantId) {
      return res.status(400).json({ success: false, error: "callId, tableId are required" });
    }

    // Resolve the table to verify it belongs to the authenticated restaurant
    const table = await prisma.table.findUnique({
      where: { id: tableId },
      select: { number: true, restaurantId: true },
    });

    if (!table || table.restaurantId !== restaurantId) {
      return res.status(404).json({ success: false, error: "Table not found in this restaurant" });
    }

    const lockKey = `waiter_accept:${restaurantId}:${callId}`;
    const lockValue = JSON.stringify({ captainId, captainName: captainName || req.user?.name || "", acceptedAt: Date.now() });

    // ── Atomic claim via Redis SET NX (preferred) ──────────────────────────
    const redis = getRedisClient();
    let acquired = false;

    if (redis) {
      const result = await redis.set(lockKey, lockValue, "EX", ACCEPT_LOCK_TTL_SEC, "NX");
      acquired = result === "OK";
    } else {
      // ── In-memory fallback (single-instance deployments) ──────────────────
      const now = Date.now();
      const existing = acceptLocksInMemory.get(lockKey);
      if (!existing || existing.expiresAt < now) {
        acceptLocksInMemory.set(lockKey, { captainId, expiresAt: now + ACCEPT_LOCK_TTL_SEC * 1000 });
        acquired = true;
      } else if (existing.captainId === captainId) {
        // Same captain re-accepting (e.g. retry) — allow
        acquired = true;
      }
    }

    if (!acquired) {
      // Find who won so the loser can show their name in the notification
      let winnerCaptainId: string | undefined;
      let winnerCaptainName: string | undefined;
      if (redis) {
        const raw = await redis.get(lockKey);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            winnerCaptainId = parsed.captainId;
            winnerCaptainName = parsed.captainName;
          } catch { /* ignore */ }
        }
      } else {
        const existing = acceptLocksInMemory.get(lockKey);
        winnerCaptainId = existing?.captainId;
      }
      return res.status(409).json({
        success: false,
        reason: "ALREADY_ACCEPTED",
        acceptedBy: winnerCaptainId,
        acceptedByName: winnerCaptainName,
        message: "Another captain has already accepted this call",
      });
    }

    // ── Broadcast the server's decision to all captain panels ──────────────
    const io = getIo();
    io.to(restaurantId).emit("waiter:event", {
      type: "captain:accept_waiter_call",
      payload: {
        callId,
        tableId,
        tableNumber: table.number,
        captainId,
        captainName: captainName || req.user?.name || "",
        restaurantId,
      },
    });

    logger.info(
      `[accept-waiter-call] Call ${callId} for table ${table.number} accepted by captain ${captainId}` +
      ` (restaurant: ${restaurantId})`
    );

    res.json({
      success: true,
      callId,
      tableId,
      tableNumber: table.number,
      captainId,
    });
  } catch (error) {
    logger.error({ err: error }, "[accept-waiter-call]");
    res.status(500).json({ success: false, error: "Failed to accept waiter call" });
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
