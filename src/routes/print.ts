/**
 * Print routes
 *
 * POST /api/print/qz-sign      — Sign a message for QZ Tray (server-side, using QZ_PRIVATE_KEY env var)
 * POST /api/print/food-kot     — Build and return Food KOT ESC/POS data
 * POST /api/print/liquor-kot   — Build and return Liquor KOT ESC/POS data
 * POST /api/print/receipt      — Fetch complete order from DB and build full receipt
 *
 * IMPORTANT:
 *   — The receipt endpoint fetches from DB by orderId. Never trust the frontend
 *     to send the complete item list for receipts.
 *   — Item type (food vs liquor) comes from menuItem.menuType on the DB side.
 *     For KOT endpoints, the frontend sends items with a `type` field directly.
 */

import crypto from "crypto";
import { Router } from "express";
import { PrismaClient, MenuType } from "@prisma/client";
import {
  buildFoodKOT,
  buildLiquorKOT,
  buildReceipt,
  buildFinalBill,
  type PrintItem,
  type BillData,
} from "../utils/escpos";

const router = Router();
const prisma = new PrismaClient();

/**
 * Format table number with prefix based on restaurantId
 * @param tableNumber - The table number (e.g., 3, "5")
 * @param restaurantId - The restaurant ID ("bar-001" or "restaurant-001")
 * @returns Formatted table number (e.g., "B3" for bar, "T5" for restaurant)
 */
/**
 * Format table number with prefix based on restaurantId and section.
 */
function formatTableLabel(
  tableNumber: number | string,
  restaurantId: string,
  sectionName?: string
): string {
  if (restaurantId === 'venue-001') {
    const sec = (sectionName || '').toLowerCase();
    if (sec.includes('conference hall 1') || sec.includes('conf1')) return 'CONF-1';
    if (sec.includes('conference hall 2') || sec.includes('conf2')) return 'CONF-2';
    if (sec.includes('pdr')) return `PDR-${tableNumber}`;
    if (sec.includes('parcel')) return 'PARCEL';
    return `V${tableNumber}`;
  }
  if (tableNumber === 999 || String(tableNumber) === '999') return 'Vijay Kumar (Counter)';
  const prefix = restaurantId === 'bar-001' ? 'B' : 'T';
  return `${prefix}${tableNumber}`;
}

// Keep the old name as an alias for backward compatibility
function formatTableNumber(tableNumber: number | string, restaurantId: string): string {
  return formatTableLabel(tableNumber, restaurantId, undefined);
}

// ─── QZ Tray Signature ──────────────────────────────────────────────────────

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

    const rawKey = process.env.QZ_PRIVATE_KEY;
    if (!rawKey) {
      console.error("[print/qz-sign] QZ_PRIVATE_KEY is not set");
      res.status(500).json({ error: "Signing key not configured on server" });
      return;
    }

    // Render/Vercel store env vars with literal \n — convert to real newlines
    // so Node's crypto module can parse the PEM correctly.
    const privateKey = rawKey.replace(/\\n/g, "\n");

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

// ─── Food KOT ───────────────────────────────────────────────────────────────

/**
 * POST /api/print/food-kot
 * Body: { tableId, orderId, kotId?, items: Array<{ name, quantity, notes?, type: 'food'|'liquor' }> }
 * Response: { data: Array | null }
 *
 * Returns null if there are no food items (kitchen printer stays silent).
 */
router.post("/food-kot", async (req, res) => {
  try {
    const { tableId, orderId, kotId, kotNumber, items } = req.body as {
      tableId?: number | string;  // Renamed for clarity - this is a UUID
      orderId?: string;
      kotId?: string;
      kotNumber?: number;
      items?: PrintItem[];
    };

    if (!tableId || !orderId || !Array.isArray(items)) {
      res.status(400).json({ error: "tableId, orderId, and items are required" });
      return;
    }

    const foodItems = items.filter((i) => i.type === "food");
    if (foodItems.length === 0) {
      // No food items — kitchen printer stays silent
      res.json({ data: null });
      return;
    }

    // Fetch table from database to get the real table number + section name
    const table = await prisma.table.findUnique({
      where: { id: String(tableId) },
      select: { number: true, restaurantId: true, section: { select: { name: true } } }
    });

    if (!table) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }

    // Format the table label (B3, T5, CONF-1, PDR-2, etc.)
    const formattedTableNumber = formatTableLabel(table.number, table.restaurantId, table.section?.name);

    const data = buildFoodKOT({
      tableNumber: formattedTableNumber,
      orderId,
      kotId: kotId || (kotNumber ? `KOT-${String(kotNumber).padStart(2, '0')}` : undefined),
      kotNumber,
      items
    });
    res.json({ data });
  } catch (err) {
    console.error("[print/food-kot] Error:", err);
    res.status(500).json({ error: "Failed to build food KOT" });
  }
});

// ─── Liquor / Bar KOT ───────────────────────────────────────────────────────

/**
 * POST /api/print/liquor-kot
 * Body: { tableId, orderId, kotId?, items: Array<{ name, quantity, notes?, type: 'food'|'liquor' }> }
 * Response: { data: Array | null }
 *
 * Returns null if there are no liquor items (bar printer stays silent).
 */
router.post("/liquor-kot", async (req, res) => {
  try {
    const { tableId, orderId, kotId, kotNumber, items } = req.body as {
      tableId?: number | string;  // Renamed for clarity - this is a UUID
      orderId?: string;
      kotId?: string;
      kotNumber?: number;
      items?: PrintItem[];
    };

    if (!tableId || !orderId || !Array.isArray(items)) {
      res.status(400).json({ error: "tableId, orderId, and items are required" });
      return;
    }

    const liquorItems = items.filter((i) => i.type === "liquor");
    if (liquorItems.length === 0) {
      // No liquor items — bar printer stays silent
      res.json({ data: null });
      return;
    }

    // Fetch table from database to get the real table number + section name
    const table = await prisma.table.findUnique({
      where: { id: String(tableId) },
      select: { number: true, restaurantId: true, section: { select: { name: true } } }
    });

    if (!table) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }

    // Format the table label (B3, T5, CONF-1, PDR-2, etc.)
    const formattedTableNumber = formatTableLabel(table.number, table.restaurantId, table.section?.name);

    const data = buildLiquorKOT({
      tableNumber: formattedTableNumber,
      orderId,
      kotId: kotId || (kotNumber ? `KOT-${String(kotNumber).padStart(2, '0')}` : undefined),
      kotNumber,
      items
    });
    res.json({ data });
  } catch (err) {
    console.error("[print/liquor-kot] Error:", err);
    res.status(500).json({ error: "Failed to build liquor KOT" });
  }
});

// ─── Receipt ────────────────────────────────────────────────────────────────

/**
 * POST /api/print/receipt
 * Body: { orderId: string }
 * Response: { data: Array }
 *
 * Fetches the COMPLETE order from the DB (all items, all rounds).
 * Item type is derived from menuItem.menuType (FOOD | LIQUOR).
 * This is the source of truth — the frontend never sends item list for receipts.
 */
router.post("/receipt", async (req, res) => {
  try {
    const { orderId } = req.body as { orderId?: string };

    if (!orderId) {
      res.status(400).json({ error: "orderId is required" });
      return;
    }

    // Fetch full order with all items + their menuItem (for type) + table captain info
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

    const txn = await prisma.transaction.findFirst({
      where: { orderId: order.id },
      select: { txnNumber: true, txnDate: true },
    });

    // Map DB items → PrintItem (resolve type from menuItem.menuType)
    // Filter out items that have been removed from the bill
    const printItems: PrintItem[] = order.items
      .filter((item) => !(item as any).removedFromBill)
      .map((item) => ({
        name: item.name,
        price: Number(item.price),
        quantity: item.quantity,
        notes: item.notes ?? null,
        // menuItem may be null if the orderItem was created with a synthetic/bar ID
        // that doesn't reference a real MenuItem row — fall back to 'food' safely.
        type: item.menuItem?.menuType === MenuType.LIQUOR ? "liquor" : "food",
      }));

    // Captain name mapping (frontend has: C1=Ajay Kumar, C2=Raja Behera, etc.)
    const captainMap: Record<string, string> = {
      'C1': 'Ajay Kumar',
      'C2': 'Raja Behera',
      'C3': 'Sagar',
      'C4': 'Durga Prasad',
      'C5': 'Subbaiah',
      'C6': 'Happy',
    };

    const orderData = {
      tableNumber: formatTableLabel(order.table.number, order.restaurantId, order.table.section?.name),
      orderId: order.id,
      items: printItems,
      restaurantName: "V GRAND LOUNGE",
      txnNumber: txn?.txnNumber ?? undefined,
      txnDate: txn?.txnDate ?? undefined,
      captainId: order.table.captainId ?? undefined,
      captainName: order.table.captainId ? (captainMap[order.table.captainId] || order.table.captainId) : undefined,
    };

    const foodItems = printItems.filter((i) => i.type === "food");
    const liquorItems = printItems.filter((i) => i.type === "liquor");
    const foodSubtotal = foodItems.reduce((sum, i) => sum + Number(i.price ?? 0) * i.quantity, 0);
    const liquorSubtotal = liquorItems.reduce((sum, i) => sum + Number(i.price ?? 0) * i.quantity, 0);
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

// ─── Final Bill ────────────────────────────────────────────────────────────────

/**
 * POST /api/print/final-bill
 * Body: { billData: BillData }
 * Response: { data: Array }
 *
 * Builds ESC/POS data for the new final bill format (separate from settlement).
 */
router.post("/final-bill", async (req, res) => {
  try {
    const { billData } = req.body as { billData?: BillData };

    // Validate required fields
    if (!billData || !billData.items || billData.items.length === 0) {
      res.status(400).json({
        error: "Bill data with items is required"
      });
      return;
    }

    // Validate bill number and table number
    if (!billData.billNumber || !billData.tableNumber) {
      res.status(400).json({
        error: "Bill number and table number are required"
      });
      return;
    }

    // Validate date and time
    if (!billData.date || !billData.time) {
      res.status(400).json({
        error: "Date and time are required"
      });
      return;
    }

    // Validate numeric fields
    if (typeof billData.subtotal !== 'number' || typeof billData.grandTotal !== 'number') {
      res.status(400).json({
        error: "Subtotal and grand total must be numbers"
      });
      return;
    }

    // Validate tax information
    if (!billData.tax || typeof billData.tax.total !== 'number') {
      res.status(400).json({
        error: "Tax information is required"
      });
      return;
    }

    // kotNumbers is optional (array of KOT IDs from session) - not required

    // Generate ESC/POS commands using new buildFinalBill function
    const escposData = buildFinalBill(billData);

    // Return raw printer data
    res.json({ data: escposData });
  } catch (error: any) {
    console.error("[Print] Final bill error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to generate bill"
    });
  }
});

export default router;
