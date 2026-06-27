import { Router } from "express";
import logger from "../lib/logger";
import rateLimit from "express-rate-limit";
import prisma from "../lib/prisma";
import { getIo } from "../socket";
import { resolvePublicRestaurant } from "../lib/resolvePublicRestaurant";
import { verifyTableSignature } from "../lib/tableSignature";

const router = Router();

// Tight rate limiter for waiter calls — 5 per IP per minute
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

export { router as publicRouter };
