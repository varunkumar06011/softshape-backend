// ─────────────────────────────────────────────────────────────────────────────
// Representative QR Routes — Non-table QR codes for outlets/sections
// ─────────────────────────────────────────────────────────────────────────────
// Provides isolated QR + waiter-call handling for representatives (e.g. bar counter)
// without creating phantom Table rows that could leak into POS/billing UIs.
//
// Admin endpoints:
//   GET  /api/representative-qr            — list representatives for restaurant
//   POST /api/representative-qr            — create/update representative
//   GET  /api/representative-qr/:id/qr-url — generate signed QR URL
//
// Public endpoints (see src/routes/public.ts):
//   GET  /api/public/representative-qr/:slug/:entityId/:sig — validate QR
//   POST /api/public/representative-call  — call waiter from representative QR
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { basePrisma } from "../lib/prisma";
import logger from "../lib/logger";
import { authenticate, requireRole } from "../middleware/auth";
import { assertTenantScope } from "../middleware/tenantScope";
import { assertSubscriptionActive } from "../middleware/subscriptionCheck";
import { withTenantContext } from "../middleware/tenantContext";
import { generateTableSignature, verifyTableSignature } from "../lib/tableSignature";

const router = Router();

function getEntitySignatureUrl(slug: string, entityId: string, restaurantId: string, origin: string) {
  const sig = generateTableSignature(slug, entityId, restaurantId);
  return `${origin}/user-menu/rep/${encodeURIComponent(slug)}/${encodeURIComponent(entityId)}/${sig}`;
}

// ── Admin: list representatives ──
router.get(
  "/",
  authenticate as any,
  assertTenantScope as any,
  assertSubscriptionActive as any,
  requireRole("OWNER", "ADMIN") as any,
  withTenantContext as any,
  async (req: any, res) => {
    try {
      const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
      const reps = await basePrisma.representativeQR.findMany({
        where: { restaurantId, isActive: true },
        orderBy: { createdAt: "desc" },
      });
      res.json(reps);
    } catch (err) {
      logger.error({ err }, "[representative-qr/list]");
      res.status(500).json({ error: "Failed to fetch representative QR codes" });
    }
  }
);

// ── Admin: create/update representative ──
router.post(
  "/",
  authenticate as any,
  assertTenantScope as any,
  assertSubscriptionActive as any,
  requireRole("OWNER", "ADMIN") as any,
  withTenantContext as any,
  async (req: any, res) => {
    try {
      const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
      const { id, name, slug, outletType } = req.body;
      const normalizedName = String(name || "").trim();
      const normalizedOutletType = String(outletType || "FOOD").toUpperCase();
      const rawSlug = String(slug || "").trim().toLowerCase();
      const normalizedSlug = rawSlug
        .replace(/[^a-z0-9\-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      if (!normalizedName || !normalizedSlug) {
        return res.status(400).json({ error: "name and slug are required" });
      }
      if (normalizedName.length > 100) {
        return res.status(400).json({ error: "name must be 100 characters or less" });
      }
      if (normalizedSlug.length > 60) {
        return res.status(400).json({ error: "slug must be 60 characters or less" });
      }
      if (!["FOOD", "BAR"].includes(normalizedOutletType)) {
        return res.status(400).json({ error: "outletType must be FOOD or BAR" });
      }

      let rep;
      if (id) {
        rep = await basePrisma.representativeQR.update({
          where: { id, restaurantId },
          data: { name: normalizedName, slug: normalizedSlug, outletType: normalizedOutletType },
        });
      } else {
        rep = await basePrisma.representativeQR.create({
          data: { restaurantId, name: normalizedName, slug: normalizedSlug, outletType: normalizedOutletType },
        });
      }

      res.json(rep);
    } catch (err: any) {
      logger.error({ err }, "[representative-qr/save]");
      if (err.code === "P2002") {
        return res.status(409).json({ error: "Slug already exists for this restaurant" });
      }
      res.status(500).json({ error: "Failed to save representative QR" });
    }
  }
);

// ── Admin: generate signed QR URL ──
router.get(
  "/:id/qr-url",
  authenticate as any,
  assertTenantScope as any,
  assertSubscriptionActive as any,
  requireRole("OWNER", "ADMIN") as any,
  withTenantContext as any,
  async (req: any, res) => {
    try {
      const restaurantId = req.user!.activeRestaurantId ?? req.user!.restaurantId;
      const rep = await basePrisma.representativeQR.findFirst({
        where: { id: req.params.id, restaurantId, isActive: true },
      });
      if (!rep) return res.status(404).json({ error: "Representative QR not found" });

      const restaurant = await basePrisma.outlet.findUnique({
        where: { id: restaurantId },
        select: { slug: true, name: true },
      });
      if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });

      const origin = `${req.protocol}://${req.get("host")}`;
      const url = getEntitySignatureUrl(restaurant.slug, rep.id, restaurantId, origin);
      res.json({ id: rep.id, url, name: rep.name, slug: rep.slug, outletType: rep.outletType });
    } catch (err) {
      logger.error({ err }, "[representative-qr/qr-url]");
      res.status(500).json({ error: "Failed to generate QR URL" });
    }
  }
);

export default router;
