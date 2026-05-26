/**
 * Print routes
 *
 * POST /api/print/qz-sign      â€“ Sign a message for QZ Tray (server-side, using QZ_PRIVATE_KEY env var)
 * POST /api/print/food-kot     â€“ Build and return Food KOT ESC/POS data
 * POST /api/print/liquor-kot   â€“ Build and return Liquor KOT ESC/POS data
 * POST /api/print/receipt      â€“ Fetch complete order from DB and build full receipt
 *
 * IMPORTANT:
 *   â€“ The receipt endpoint fetches from DB by orderId. Never trust the frontend
 *     to send the complete item list for receipts.
 *   â€“ Item type (food vs liquor) comes from menuItem.menuType on the DB side.
 *     For KOT endpoints, the frontend sends items with a `type` field directly.
 */

import crypto from "crypto";
import { Router } from "express";
import { PrismaClient, MenuType } from "@prisma/client";
import {
  buildFoodKOT,
  buildLiquorKOT,
  buildReceipt,

  type PrintItem,
} from "../utils/escpos";

const router = Router();
const prisma = new PrismaClient();

// â”€â”€â”€ QZ Tray Signature â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * POST /api/print/qz-sign
 * Body: { toSign: string }
 * Response: { signature: string }
 *
 * Used by the QZ Tray security.setSignaturePromise callback in the frontend.
 * The private key must be stored in the QZ_PRIVATE_KEY environment variable
 * on Render, in PEM format (with actual newlines, not \\n literals).
 */
router.post("/qz-sign", (req, res) => {
  try {
    const { toSign } = req.body as { toSign?: string };

    if (typeof toSign !== "string" || !toSign) {
      res.status(400).json({ error: "toSign is required" });
      return;
    }

    const privateKey = process.env.QZ_PRIVATE_KEY;
    if (!privateKey) {
      console.error("[print/qz-sign] QZ_PRIVATE_KEY is not set");
      res.status(500).json({ error: "Signing key not configured on server" });
      return;
    }

    // QZ Tray expects SHA512 + RSA signing
    const sign = crypto.createSign("SHA512");
    sign.update(toSign);
    const signature = sign.sign(privateKey, "base64");

    res.json({ signature });
  } catch (err) {
    console.error("[print/qz-sign] Error:", err);
    res.status(500).json({ error: "Failed to sign message" });
  }
});

// â”€â”€â”€ Food KOT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * POST /api/print/food-kot
 * Body: { tableNumber, orderId, items: Array<{ name, quantity, notes?, type: 'food'|'liquor' }> }
 * Response: { data: Array | null }
 *
 * Returns null if there are no food items (kitchen printer stays silent).
 */
router.post("/food-kot", (req, res) => {
  try {
    const { tableNumber, orderId, items } = req.body as {
      tableNumber?: number | string;
      orderId?: string;
      items?: PrintItem[];
    };

    if (!tableNumber || !orderId || !Array.isArray(items)) {
      res.status(400).json({ error: "tableNumber, orderId, and items are required" });
      return;
    }

    const foodItems = items.filter((i) => i.type === "food");
    if (foodItems.length === 0) {
      // No food items â€“ kitchen printer stays silent
      res.json({ data: null });
      return;
    }

    const data = buildFoodKOT({ tableNumber, orderId, items });
    res.json({ data });
  } catch (err) {
    console.error("[print/food-kot] Error:", err);
    res.status(500).json({ error: "Failed to build food KOT" });
  }
});

// â”€â”€â”€ Liquor / Bar KOT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * POST /api/print/liquor-kot
 * Body: { tableNumber, orderId, items: Array<{ name, quantity, notes?, type: 'food'|'liquor' }> }
 * Response: { data: Array | null }
 *
 * Returns null if there are no liquor items (bar printer stays silent).
 */
router.post("/liquor-kot", (req, res) => {
  try {
    const { tableNumber, orderId, items } = req.body as {
      tableNumber?: number | string;
      orderId?: string;
      items?: PrintItem[];
    };

    if (!tableNumber || !orderId || !Array.isArray(items)) {
      res.status(400).json({ error: "tableNumber, orderId, and items are required" });
      return;
    }

    const liquorItems = items.filter((i) => i.type === "liquor");
    if (liquorItems.length === 0) {
      // No liquor items â€“ bar printer stays silent
      res.json({ data: null });
      return;
    }

    const data = buildLiquorKOT({ tableNumber, orderId, items });
    res.json({ data });
  } catch (err) {
    console.error("[print/liquor-kot] Error:", err);
    res.status(500).json({ error: "Failed to build liquor KOT" });
  }
});

// â”€â”€â”€ Receipt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * POST /api/print/receipt
 * Body: { orderId: string }
 * Response: { data: Array }
 *
 * Fetches the COMPLETE order from the DB (all items, all rounds).
 * Item type is derived from menuItem.menuType (FOOD | LIQUOR).
 * This is the source of truth â€“ the frontend never sends item list for receipts.
 */
router.post("/receipt", async (req, res) => {
  try {
    const { orderId } = req.body as { orderId?: string };

    if (!orderId) {
      res.status(400).json({ error: "orderId is required" });
      return;
    }

    // Fetch full order with all items + their menuItem (for type)
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        table: {
          include: {
            section: { select: { name: true } },
          },
        },
        items: {
          include: {
            menuItem: {
              select: { menuType: true },
            },
          },
          orderBy: { id: "asc" },
        },
      },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    // Map DB items â†’ PrintItem (resolve type from menuItem.menuType)
    // Filter out items that have been removed from the bill
    const printItems: PrintItem[] = order.items
      .filter((item) => !(item as any).removedFromBill)
      .map((item) => ({
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        notes: item.notes ?? null,
        // menuItem may be null if the orderItem was created with a synthetic/bar ID
        // that doesn't reference a real MenuItem row — fall back to 'food' safely.
        type: item.menuItem?.menuType === MenuType.LIQUOR ? "liquor" : "food",
      }));

    const orderData = {
      tableNumber: order.table.number,
      orderId: order.id,
      items: printItems,
      restaurantName: "V GRAND LOUNGE", // Update this or fetch from DB if needed
    };

    const foodItems = printItems.filter((i) => i.type === "food");
    const liquorItems = printItems.filter((i) => i.type === "liquor");
    const foodSubtotal = foodItems.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0);
    const liquorSubtotal = liquorItems.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0);
    const cgst = Math.round(foodSubtotal * 0.025 * 100) / 100;
    const sgst = Math.round(foodSubtotal * 0.025 * 100) / 100;
    const totalTax = cgst + sgst;
    const total = Math.round((foodSubtotal + liquorSubtotal + totalTax) * 100) / 100;

    const data = buildReceipt(orderData);
    res.json({ 
      data,
      breakdown: { foodSubtotal, liquorSubtotal, cgst, sgst, total }
    });
  } catch (err) {
    console.error("[print/receipt] Error:", err);
    res.status(500).json({ error: "Failed to build receipt" });
  }
});

export default router;
