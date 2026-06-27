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
import jwt from "jsonwebtoken";
import { Router } from "express";
import { MenuType } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  buildFoodKOT,
  buildLiquorKOT,
  buildReceipt,
  buildFinalBill,
  type PrintItem,
  type BillData,
} from "../utils/escpos";
import { getCaptainName } from "../utils/captainMap";
import { getIo } from "../socket";
import { bufferPrintJob, getRecentPrintJobs } from "../lib/printQueue";
import { authenticate, requireRole } from "../middleware/auth";
import { resolveTenantContext, isBarOutlet, isVenueOutlet, type TenantContext } from "../lib/tenantContext";
import { getGstBreakdown, getEffectiveGstRate, getGstBreakdownWithRate } from "../utils/gst";
import { signAgentToken, verifyAgentToken } from "../lib/agentToken";

const router = Router();

import { acquireLock } from "../lib/redisLock";

const PRINT_LOCK_KEY = (key: string) => `print_lock:print:${key}`;
const PRINT_LOCK_TTL = 5; // seconds

const EMIT_LOCK_KEY = (key: string) => `emit_lock:print:${key}`;
const EMIT_LOCK_TTL = 10; // seconds

/**
 * Format table number with prefix based on restaurantId
 * @param tableNumber - The table number (e.g., 3, "5")
 * @param restaurantId - The restaurant ID from the authenticated tenant context
 * @returns Formatted table number (e.g., "B3" for bar, "T5" for restaurant)
 */
/**
 * Format table number with prefix based on restaurantId and section.
 */
function formatTableLabel(
  tableNumber: number | string,
  restaurantId: string,
  sectionName?: string,
  ctx?: TenantContext
): string {
  if (ctx && isVenueOutlet(restaurantId, ctx) && sectionName) {
    const sec = (sectionName || '').toLowerCase();
    if (sec.includes('conference')) return `C${tableNumber}`;
    if (sec.includes('pdr')) return `PDR${tableNumber}`;
    if (sec.includes('room')) return `R${tableNumber}`;
    if (sec.includes('bar') || sec.includes('main hall')) return `B${tableNumber}`;
    if (sec.includes('family restaurant')) return `F${tableNumber}`;
    if (sec.includes('gobox') || sec.includes('go box')) return `GB${tableNumber}`;
    if (sec.includes('parcel')) return `P1`;
    return `V${tableNumber}`;
  }
  if (tableNumber === 999 || String(tableNumber) === '999') return 'Counter';
  const prefix = ctx && isBarOutlet(restaurantId, ctx) ? 'B' : 'T';
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
router.post("/food-kot", authenticate, async (req, res) => {
  try {
    const { tableId, orderId, kotId, kotNumber, items, captainName } = req.body as {
      tableId?: number | string;  // Renamed for clarity - this is a UUID
      orderId?: string;
      kotId?: string;
      kotNumber?: number;
      items?: PrintItem[];
      captainName?: string;
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
      select: { number: true, restaurantId: true, sectionTag: true, section: { select: { name: true } } }
    });

    if (!table) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }

    // Format the table label (B3, T5, CONF-1, PDR-2, etc.)
    const ctx = await resolveTenantContext(table.restaurantId);
    const formattedTableNumber = formatTableLabel(table.number, table.restaurantId, table.section?.name, ctx);

    const data = buildFoodKOT({
      tableNumber: formattedTableNumber,
      orderId,
      kotId: kotId || (kotNumber ? `KOT-${String(kotNumber).padStart(2, '0')}` : undefined),
      kotNumber,
      items,
      sectionName: table.section?.name,
      captainName: captainName || undefined,
      sectionTag: table.sectionTag || undefined,
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
router.post("/liquor-kot", authenticate, async (req, res) => {
  try {
    const { tableId, orderId, kotId, kotNumber, items, captainName } = req.body as {
      tableId?: number | string;  // Renamed for clarity - this is a UUID
      orderId?: string;
      kotId?: string;
      kotNumber?: number;
      items?: PrintItem[];
      captainName?: string;
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
      select: { number: true, restaurantId: true, sectionTag: true, section: { select: { name: true } } }
    });

    if (!table) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }

    // Format the table label (B3, T5, CONF-1, PDR-2, etc.)
    const ctx = await resolveTenantContext(table.restaurantId);
    const formattedTableNumber = formatTableLabel(table.number, table.restaurantId, table.section?.name, ctx);

    const data = buildLiquorKOT({
      tableNumber: formattedTableNumber,
      orderId,
      kotId: kotId || (kotNumber ? `KOT-${String(kotNumber).padStart(2, '0')}` : undefined),
      kotNumber,
      items,
      sectionName: table.section?.name,
      captainName: captainName || undefined,
      sectionTag: table.sectionTag || undefined,
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
router.post("/receipt", authenticate, async (req, res) => {
  try {
    const { orderId } = req.body as { orderId?: string };

    if (!orderId) {
      res.status(400).json({ error: "orderId is required" });
      return;
    }

    const authRestaurantId = (req as any).user?.restaurantId;

    // Fetch full order with all items + their menuItem (for type) + table captain info + latest transaction
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
        transactions: { take: 1, select: { txnNumber: true, txnDate: true } },
      },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    // Validate caller is from the same restaurant
    if (order.restaurantId !== authRestaurantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const txn = order.transactions?.[0];

    // Map DB items → PrintItem (resolve type from menuItem.menuType)
    // Filter out items that have been removed from the bill
    const rawPrintItems: PrintItem[] = order.items
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

    // Group by name so duplicate items (e.g. same water bottle added twice) merge into one line
    const printItems: PrintItem[] = Object.values(
      rawPrintItems.reduce((acc, item) => {
        if (!acc[item.name]) {
          acc[item.name] = { ...item, quantity: 0 };
        }
        acc[item.name].quantity += item.quantity;
        return acc;
      }, {} as Record<string, PrintItem>)
    );

    // Captain name mapping (using shared utility)
    const captainName = order.table.captainId ? await getCaptainName(order.table.captainId) || order.table.captainId : undefined;

    const ctx = await resolveTenantContext(order.restaurantId);
    const orderData = {
      tableNumber: formatTableLabel(order.table.number, order.restaurantId, order.table.section?.name, ctx),
      orderId: order.id,
      items: printItems,
      txnNumber: txn?.txnNumber ?? undefined,
      txnDate: txn?.txnDate ?? undefined,
      captainId: order.table.captainId ?? undefined,
      captainName: captainName,
      sectionTag: (order.table as any)?.sectionTag || null,
    };

    const foodItems = printItems.filter((i) => i.type === "food");
    const liquorItems = printItems.filter((i) => i.type === "liquor");
    const foodSubtotal = foodItems.reduce((sum, i) => sum + Number(i.price ?? 0) * i.quantity, 0);
    const liquorSubtotal = liquorItems.reduce((sum, i) => sum + Number(i.price ?? 0) * i.quantity, 0);
    const effectiveRate = getEffectiveGstRate(ctx.gstRate, ctx.gstCategory, ctx.gstRegistered);
    const { cgst, sgst, tax: totalTax, baseAmount } = getGstBreakdownWithRate(foodSubtotal, effectiveRate, !!ctx.pricesIncludeGst);
    const total = Math.round((baseAmount + liquorSubtotal + totalTax) * 100) / 100;

    const data = buildReceipt(orderData, { cgst, sgst, total: totalTax });
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
router.post("/final-bill", authenticate, async (req, res) => {
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

// ─── Final Bill Emit (Cashier → Socket → PrintStation) ────────────────────────

/**
 * POST /api/print/final-bill-emit
 * Body: { billData: Partial<BillData>, restaurantId: string }
 * Response: { success: boolean }
 *
 * Cashier calls this instead of talking to QZ Tray directly.
 * Backend builds ESC/POS data and emits a print_job (type FINAL_BILL)
 * to the dedicated print room so the PrintStation handles QZ Tray.
 */
router.post("/final-bill-emit", authenticate, async (req, res) => {
  try {
    const { billData, restaurantId } = req.body as {
      billData?: Partial<BillData> & {
        items: Array<{ name: string; quantity: number; price: number; menuType?: string }>;
        subtotal: number;
        grandTotal: number;
        tableNumber: string;
      };
      restaurantId?: string;
    };

    if (!restaurantId) {
      res.status(400).json({ error: "restaurantId is required" });
      return;
    }
    if (!billData || !Array.isArray(billData.items) || billData.items.length === 0) {
      res.status(400).json({ error: "billData with items is required" });
      return;
    }

    const ctx = await resolveTenantContext(restaurantId);

    // Server-side print lock to prevent duplicate final-bill-emit calls
    const lockKey = `${restaurantId}-${billData.tableNumber}-${billData.items.length}`;
    const printAcquired = await acquireLock(PRINT_LOCK_KEY(lockKey), PRINT_LOCK_TTL);
    if (!printAcquired) {
      return res.status(429).json({ error: "Duplicate print request — please wait" });
    }

    const now = new Date();
    const date = now.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });
    const time = now.toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    });

    // Normalise items
    const items = billData.items.map((item) => ({
      name: item.name || "Unknown",
      quantity: Math.max(0, Math.round(Number(item.quantity || 0))),
      price: Number(item.price || 0),
      amount: Number(item.price || 0) * Math.max(0, Math.round(Number(item.quantity || 0))),
      menuType: ((item.menuType || "FOOD") as string).toUpperCase() as "FOOD" | "LIQUOR",
    }));

    const itemCount = items.length;
    const qtyCount = items.reduce((sum, i) => sum + i.quantity, 0);
    const subtotal = Number(
      billData.subtotal || items.reduce((sum, i) => sum + i.amount, 0)
    );

    // Tax: CGST + SGST on food only, after discount
    const foodItems = items.filter((i) => i.menuType === "FOOD");
    const foodSubtotal = foodItems.reduce((sum, i) => sum + i.amount, 0);
    const discount = billData.discount || null;
    const discountAmount = discount
      ? discount.amount || Math.round(foodSubtotal * (discount.percent / 100) * 100) / 100
      : 0;
    const taxableAmount = Math.max(0, foodSubtotal - discountAmount);
    const effectiveRate = getEffectiveGstRate(ctx.gstRate, ctx.gstCategory, ctx.gstRegistered);
    const { cgst, sgst, tax: taxTotal, baseAmount } = getGstBreakdownWithRate(taxableAmount, effectiveRate, !!ctx.pricesIncludeGst);
    const liquorSubtotal = subtotal - foodSubtotal;
    const displayedSubtotal = Math.round((baseAmount + liquorSubtotal) * 100) / 100;
    const grandTotal = Number(
      billData.grandTotal || Math.round((displayedSubtotal + taxTotal) * 100) / 100
    );

    const fullBillData: BillData = {
      billNumber: billData.billNumber || `WALKIN-${Date.now().toString(36).toUpperCase()}`,
      date,
      time,
      kotNumbers: billData.kotNumbers || [],
      tableNumber: billData.tableNumber || "Walk-in",
      captain: (billData as any).captain || "Walk-in",
      items,
      subtotal: displayedSubtotal,
      discount: discount ? { percent: discount.percent, amount: discountAmount } : undefined,
      tax: { cgst, sgst, total: taxTotal },
      grandTotal,
      section: (billData as any).section || "Walk-in",
      sectionTag: (billData as any).sectionTag || null,
      itemCount,
      qtyCount,
      ...(billData.gstIn ? { gstIn: billData.gstIn } : (ctx.gstin ? { gstIn: ctx.gstin } : {})),
    };

    const escposData = buildFinalBill(fullBillData);

    // Emit-level lock to prevent duplicate emissions
    const requestId = (billData as any).requestId || '';
    const emitKey = `${restaurantId}-FINAL_BILL-${fullBillData.tableNumber}-${itemCount}-${requestId}`;
    const emitAcquired = await acquireLock(EMIT_LOCK_KEY(emitKey), EMIT_LOCK_TTL);
    if (!emitAcquired) {
      return res.json({ success: true, skipped: true });
    }

    const enriched = {
      type: "FINAL_BILL",
      data: {
        orderId: (billData as any).orderId || `walkin-${Date.now()}`,
        tableNumber: fullBillData.tableNumber,
        restaurantId,
        sectionTag: fullBillData.sectionTag || null,
        escposData,
      },
      eventId: crypto.randomUUID(),
    };
    bufferPrintJob(restaurantId, enriched);
    getIo().to(`print:${restaurantId}`).emit("print_job", enriched);

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Print] Final bill emit error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to emit final bill",
    });
  }
});

// ─── Cancel Bill ───────────────────────────────────────────────────────────────

/**
 * POST /api/print/cancel-bill
 * Body: { orderId, tableNumber, cancelledBy, cancelledItems: Array<{name, quantity, menuType}> }
 * Response: { data: Array }
 *
 * Prints a CANCELLATION receipt showing what was cancelled.
 * Called by the cashier panel when items are cancelled.
 */
router.post("/cancel-bill", authenticate, async (req, res) => {
  try {
    const { orderId, tableNumber, cancelledBy, cancelledItems, restaurantName } = req.body as {
      orderId?: string;
      tableNumber?: string;
      cancelledBy?: string;
      cancelledItems?: Array<{ name: string; quantity: number; menuType?: string }>;
      restaurantName?: string;
    };

    if (!orderId || !tableNumber || !cancelledBy || !Array.isArray(cancelledItems) || cancelledItems.length === 0) {
      res.status(400).json({ error: "orderId, tableNumber, cancelledBy, and cancelledItems are required" });
      return;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-IN", {
      hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
    });
    const dateStr = now.toLocaleDateString("en-IN", {
      day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Kolkata",
    });

    // Build ESC/POS cancel bill receipt
    const INIT = "\x1B\x40";
    const CENTER = "\x1B\x61\x01";
    const LEFT = "\x1B\x61\x00";
    const BOLD_ON = "\x1B\x45\x01";
    const BOLD_OFF = "\x1B\x45\x00";
    const SIZE_2X = "\x1D\x21\x11";
    const SIZE_NORMAL = "\x1D\x21\x00";
    const CUT = "\x1D\x56\x42\x00";
    const sep = "-".repeat(32);

    const cmds: string[] = [];
    cmds.push(INIT);
    cmds.push(CENTER);
    cmds.push(SIZE_2X);
    cmds.push(BOLD_ON);
    cmds.push(`${restaurantName || "CANCELLATION RECEIPT"}\n`);
    cmds.push(BOLD_OFF);
    cmds.push(SIZE_NORMAL);
    cmds.push("*** CANCELLATION ***\n");
    cmds.push(LEFT);
    cmds.push(`${sep}\n`);
    cmds.push(`Table  : ${tableNumber}\n`);
    cmds.push(`Date   : ${dateStr}   ${timeStr}\n`);
    cmds.push(`Cancel : ${cancelledBy}\n`);
    cmds.push(`Order  : ${orderId.slice(-8).toUpperCase()}\n`);
    cmds.push(`${sep}\n`);
    cmds.push(BOLD_ON);
    cmds.push("CANCELLED ITEMS:\n");
    cmds.push(BOLD_OFF);
    cmds.push(`${sep}\n`);

    for (const item of cancelledItems) {
      cmds.push(BOLD_ON);
      cmds.push(`${item.name.toUpperCase()}\n`);
      cmds.push(BOLD_OFF);
      cmds.push(`  Qty: ${item.quantity}  [${item.menuType === "LIQUOR" ? "BAR" : "FOOD"}]\n`);
    }

    cmds.push(`${sep}\n`);
    cmds.push(CENTER);
    cmds.push("-- Authorised Cancellation --\n");
    cmds.push("\n\n\n");
    cmds.push(CUT);

    const escposData = [{
      type: "raw",
      format: "plain",
      data: cmds.join(""),
      options: { language: "ESCPOS" },
    }];

    res.json({ data: escposData });
  } catch (error: any) {
    console.error("[Print] Cancel bill error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to generate cancel bill" });
  }
});

// ─── Reprint by Transaction (for settled bills) ────────────────────────────────

/**
 * POST /api/print/reprint-by-transaction
 * Body: { orderId: string, restaurantId: string }
 * Response: { success: boolean }
 *
 * Reprints a settled bill by fetching order data and emitting to print station.
 * This endpoint works for PAID orders, unlike /api/orders/:id/print-bill which returns 409.
 */
router.post("/reprint-by-transaction", authenticate, async (req, res) => {
  try {
    const { orderId, restaurantId } = req.body as { orderId: string; restaurantId: string };

    if (!orderId || !restaurantId) {
      return res.status(400).json({ error: "orderId and restaurantId are required" });
    }

    // 1. Fetch order with table, items, and latest transaction
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: { menuItem: true }
        },
        table: {
          include: { section: true }
        },
        transactions: { take: 1, select: { txnNumber: true, txnDate: true } },
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Validate order belongs to the caller's restaurant
    if (order.restaurantId !== restaurantId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const txn = order.transactions?.[0];
    const ctx = await resolveTenantContext(restaurantId);

    // 2. Filter active items (non-removed, non-zero quantity)
    const activeItems = order.items.filter((i: any) => !(i as any).removedFromBill && i.quantity > 0);
    if (activeItems.length === 0) {
      return res.status(400).json({ error: "No items to reprint" });
    }

    // 3. Calculate bill details
    const foodItems = activeItems.filter((item: any) => item.menuItem.menuType === "FOOD");
    const liquorItems = activeItems.filter((item: any) => item.menuItem.menuType === "LIQUOR");

    const foodSubtotal = foodItems.reduce((sum: number, item: any) =>
      sum + (Number(item.price) * item.quantity), 0
    );
    const liquorSubtotal = liquorItems.reduce((sum: number, item: any) =>
      sum + (Number(item.price) * item.quantity), 0
    );
    const subtotal = foodSubtotal + liquorSubtotal;

    // Apply discount if set on table
    let discount = null;
    let discountAmount = 0;
    if (order.table.discount && Number(order.table.discount) > 0) {
      const discountPercent = Number(order.table.discount);
      discountAmount = Math.round(subtotal * (discountPercent / 100) * 100) / 100;
      discount = { percent: discountPercent, amount: discountAmount };
    }

    // Tax calculation (CGST + SGST on food only, AFTER discount)
    const taxableAmount = foodSubtotal - (discount ? discountAmount * (foodSubtotal / subtotal) : 0);
    const effectiveRate = getEffectiveGstRate(ctx.gstRate, ctx.gstCategory, ctx.gstRegistered);
    const { cgst, sgst, tax, baseAmount } = getGstBreakdownWithRate(taxableAmount, effectiveRate, !!ctx.pricesIncludeGst);
    const liquorAfterDiscount = liquorSubtotal - (discount ? discountAmount * (liquorSubtotal / subtotal) : 0);
    const displayedSubtotal = Math.round((baseAmount + liquorAfterDiscount) * 100) / 100;

    const grandTotal = Math.round((displayedSubtotal + tax) * 100) / 100;

    // Get KOT numbers from table history
    const kotHistory = (order.table.kotHistory as Array<{ id?: string }>) || [];
    const kotNumbers = kotHistory.map(k => k.id).filter(Boolean);

    // Format table number
    const formattedTableNumber = formatTableLabel(
      order.table.number,
      restaurantId,
      order.table.section?.name,
      ctx
    );

    // Format time and date
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });
    const dateStr = now.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Asia/Kolkata'
    });

    // Build bill data for print
    const billData: any = {
      billNumber: order.billNumber || "REPRINT",
      date: dateStr,
      time: timeStr,
      kotNumbers,
      tableNumber: formattedTableNumber,
      captain: order.table.captainId || "N/A",
      items: (() => {
        const grouped = activeItems.reduce((acc: any, item: any) => {
          const key = item.name;
          if (!acc[key]) {
            acc[key] = { name: item.name, quantity: 0, price: Number(item.price), menuType: item.menuItem.menuType };
          }
          acc[key].quantity += item.quantity;
          return acc;
        }, {} as Record<string, any>);
        return Object.values(grouped).map((item: any) => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          amount: item.price * item.quantity,
          menuType: item.menuType
        }));
      })(),
      subtotal: displayedSubtotal,
      discount,
      tax: { cgst, sgst, total: tax },
      grandTotal,
      section: order.table.section?.name || "Main Hall",
      sectionTag: (order.table as any)?.sectionTag || null,
      itemCount: (() => {
        const grouped = activeItems.reduce((acc: any, item: any) => {
          const key = item.name;
          if (!acc[key]) {
            acc[key] = true;
          }
          return acc;
        }, {} as Record<string, boolean>);
        return Object.keys(grouped).length;
      })(),
      qtyCount: activeItems.reduce((sum: number, item: any) => sum + item.quantity, 0)
    };

    // Generate ESC/POS commands
    const escposData = buildFinalBill(billData);

    // Emit to print station
    const enriched = {
      type: "FINAL_BILL",
      data: {
        orderId: order.id,
        tableNumber: formattedTableNumber,
        restaurantId,
        sectionTag: (order.table as any)?.sectionTag || null,
        escposData
      },
      eventId: crypto.randomUUID(),
    };
    bufferPrintJob(restaurantId, enriched);
    getIo().to(`print:${restaurantId}`).emit("print_job", enriched);

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Print] Reprint by transaction error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to reprint bill" });
  }
});

// ─── Windows Print Agent: Token, Register, Heartbeat, Status ───────────────
//
// These routes are additive — they do not touch any existing QZ Tray or
// PrintStation logic.  The agent authenticates with a short-lived setup
// token (generated by the owner) and then receives a long-lived session
// token for Socket.IO + heartbeat use.
//
// All agent state is stored inside Restaurant.printerConfig (Json?) so no
// schema migration is required.
// ───────────────────────────────────────────────────────────────────────────

/**
 * POST /api/print/agent-token
 * Auth: JWT required (OWNER or ADMIN role)
 * Response: { token, expiresAt, restaurantCode, restaurantName }
 *
 * Owner generates a 15-minute setup token for the Windows Print Agent.
 */
router.post("/agent-token", authenticate, requireRole("OWNER", "ADMIN"), (req, res) => {
  try {
    const user = (req as any).user;

    const restaurantId = user.restaurantId;
    const setupToken = signAgentToken(
      { restaurantId, purpose: "agent-setup", restaurantCode: user.restaurantCode || undefined },
      "15m",
    );

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    res.json({ token: setupToken, expiresAt, restaurantCode: user.restaurantCode || null });
  } catch (err) {
    console.error("[print/agent-token] Error:", err);
    res.status(500).json({ error: "Failed to generate agent token" });
  }
});

/**
 * POST /api/print/agent-register
 * Auth: Bearer = agent setup token (from /agent-token)
 * Body: { agentId: string, printerMapping: { kitchen?, bar?, bill? } }
 * Response: { sessionToken, restaurantId, restaurantCode, restaurantName, missedJobs }
 */
router.post("/agent-register", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const setupToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!setupToken) {
      res.status(401).json({ error: "Setup token required" });
      return;
    }

    let decoded: any;
    try {
      decoded = verifyAgentToken(setupToken);
    } catch {
      res.status(401).json({ error: "Setup token invalid or expired" });
      return;
    }

    if (decoded.purpose !== "agent-setup") {
      res.status(401).json({ error: "Invalid token purpose" });
      return;
    }

    const { restaurantId } = decoded;
    if (!restaurantId || typeof restaurantId !== "string") {
      res.status(401).json({ error: "Setup token missing restaurantId" });
      return;
    }

    const { agentId, printerMapping } = req.body as {
      agentId?: string;
      printerMapping?: { kitchen?: string; bar?: string; bill?: string };
    };

    if (!agentId) {
      res.status(400).json({ error: "agentId is required" });
      return;
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { printerConfig: true, restaurantCode: true, name: true },
    });
    if (!restaurant) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }

    let existingConfig: Record<string, any> = {};
    try {
      existingConfig = (restaurant.printerConfig as Record<string, any>) || {};
      if (typeof existingConfig !== "object" || Array.isArray(existingConfig) || existingConfig === null) {
        existingConfig = {};
      }
    } catch {
      existingConfig = {};
    }

    const newConfig = {
      ...existingConfig,
      agentMapping: printerMapping || {},
      lastAgentId: agentId,
      lastAgentSeen: new Date().toISOString(),
    };

    try {
      await prisma.restaurant.update({
        where: { id: restaurantId },
        data: { printerConfig: newConfig },
      });
    } catch (dbErr) {
      console.error("[print/agent-register] DB update failed:", dbErr);
      res.status(500).json({ error: "Failed to save printer config" });
      return;
    }

    let sessionToken: string;
    try {
      sessionToken = signAgentToken(
        { restaurantId, purpose: "agent-session", agentId },
        "30d",
      );
    } catch (jwtErr) {
      console.error("[print/agent-register] JWT signing failed:", jwtErr);
      res.status(500).json({ error: "Failed to create session token" });
      return;
    }

    const missedJobs = await getRecentPrintJobs(restaurantId);

    res.json({
      sessionToken,
      restaurantId,
      restaurantCode: restaurant.restaurantCode,
      restaurantName: restaurant.name,
      missedJobs: missedJobs.map((j) => j.payload),
    });
  } catch (err) {
    console.error("[print/agent-register] Unexpected error:", err);
    res.status(500).json({ error: "Failed to register agent" });
  }
});

/**
 * POST /api/print/agent-heartbeat
 * Auth: Bearer = agent session token
 * Body: { printerStatus: { kitchen?, bar?, bill? } }
 * Response: { ok: true }
 */
router.post("/agent-heartbeat", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      res.status(401).json({ error: "Session token required" });
      return;
    }

    let decoded: any;
    try {
      decoded = verifyAgentToken(token);
    } catch {
      res.status(401).json({ error: "Session token invalid or expired" });
      return;
    }

    if (decoded.purpose !== "agent-session") {
      res.status(401).json({ error: "Invalid token purpose" });
      return;
    }

    const { restaurantId } = decoded;
    const { printerStatus } = req.body as { printerStatus?: Record<string, string> };

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { printerConfig: true },
    });
    if (!restaurant) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }

    const existingConfig = (restaurant.printerConfig as Record<string, any>) || {};
    await prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        printerConfig: {
          ...existingConfig,
          agentOnline: true,
          agentLastSeen: new Date().toISOString(),
          agentPrinterStatus: printerStatus || {},
        },
      },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[print/agent-heartbeat] Error:", err);
    res.status(500).json({ error: "Failed to process heartbeat" });
  }
});

/**
 * GET /api/print/agent-status
 * Auth: JWT (OWNER or ADMIN)
 * Response: { online, lastSeen, printerStatus, agentMapping, restaurantCode }
 */
router.get("/agent-status", authenticate, requireRole("OWNER", "ADMIN"), async (req, res) => {
  try {
    const user = (req as any).user;

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: user.restaurantId },
      select: { printerConfig: true, restaurantCode: true },
    });
    if (!restaurant) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }

    const config = (restaurant.printerConfig as Record<string, any>) || {};
    const lastSeen = config.agentLastSeen ? new Date(config.agentLastSeen) : null;
    const online = lastSeen ? Date.now() - lastSeen.getTime() < 90_000 : false;

    res.json({
      online,
      lastSeen: config.agentLastSeen || null,
      printerStatus: config.agentPrinterStatus || {},
      agentMapping: config.agentMapping || {},
      restaurantCode: restaurant.restaurantCode,
    });
  } catch (err) {
    console.error("[print/agent-status] Error:", err);
    res.status(500).json({ error: "Failed to get agent status" });
  }
});

export default router;
