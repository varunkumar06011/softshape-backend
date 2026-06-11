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
import { bufferPrintJob } from "../index";

const router = Router();

// Server-side print lock to prevent duplicate final-bill-emit calls
const printLocks = new Map<string, number>(); // orderId -> timestamp
const PRINT_LOCK_TTL_MS = 5000;

// Emit-level lock to prevent duplicate print_job emissions
const emitLocks = new Map<string, number>(); // key -> timestamp
const EMIT_LOCK_TTL_MS = 10000;

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
    if (sec.includes('conference hall') && (sec.includes('1') || sec.includes('conf1'))) return 'CONF-1';
    if (sec.includes('conference hall') && (sec.includes('2') || sec.includes('conf2'))) return 'CONF-2';
    if (sec.includes('conference hall')) return 'CONF-1';  // fallback for plain "Conference Hall"
    if (sec.includes('pdr')) return `PDR-${tableNumber}`;
    if (sec.includes('rooms')) return `R${tableNumber}`;
    if (sec.includes('parcel')) return `P${tableNumber}`;
    return `F${tableNumber}`;
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
    const formattedTableNumber = formatTableLabel(table.number, table.restaurantId, table.section?.name);

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
router.post("/liquor-kot", async (req, res) => {
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
    const formattedTableNumber = formatTableLabel(table.number, table.restaurantId, table.section?.name);

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
router.post("/receipt", async (req, res) => {
  try {
    const { orderId } = req.body as { orderId?: string };

    if (!orderId) {
      res.status(400).json({ error: "orderId is required" });
      return;
    }

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
    const captainName = order.table.captainId ? getCaptainName(order.table.captainId) || order.table.captainId : undefined;

    const orderData = {
      tableNumber: formatTableLabel(order.table.number, order.restaurantId, order.table.section?.name),
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
router.post("/final-bill-emit", async (req, res) => {
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

    // Server-side print lock to prevent duplicate final-bill-emit calls
    const lockKey = `${restaurantId}-${billData.tableNumber}-${billData.items.length}`;
    const lockNow = Date.now();
    const lockTs = printLocks.get(lockKey);
    if (lockTs && lockNow - lockTs < PRINT_LOCK_TTL_MS) {
      return res.status(429).json({ error: "Duplicate print request — please wait" });
    }
    printLocks.set(lockKey, lockNow);
    // Clean up old locks
    for (const [key, ts] of printLocks.entries()) {
      if (lockNow - ts > PRINT_LOCK_TTL_MS) printLocks.delete(key);
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
    const taxableRatio = subtotal > 0 ? foodSubtotal / subtotal : 0;
    const taxableAmount = foodSubtotal - discountAmount * taxableRatio;
    const cgst = Math.round(Math.max(0, taxableAmount) * 0.025 * 100) / 100;
    const sgst = Math.round(Math.max(0, taxableAmount) * 0.025 * 100) / 100;
    const taxTotal = cgst + sgst;
    const grandTotal = Number(
      billData.grandTotal || Math.round((subtotal - discountAmount + taxTotal) * 100) / 100
    );

    const fullBillData: BillData = {
      billNumber: billData.billNumber || `WALKIN-${Date.now().toString(36).toUpperCase()}`,
      date,
      time,
      kotNumbers: billData.kotNumbers || [],
      tableNumber: billData.tableNumber || "Walk-in",
      captain: (billData as any).captain || "Walk-in",
      items,
      subtotal,
      discount: discount ? { percent: discount.percent, amount: discountAmount } : undefined,
      tax: { cgst, sgst, total: taxTotal },
      grandTotal,
      section: (billData as any).section || "Walk-in",
      sectionTag: (billData as any).sectionTag || null,
      itemCount,
      qtyCount,
      ...(billData.gstIn ? { gstIn: billData.gstIn } : (restaurantId === 'bar-001' ? { gstIn: '37AEXPT1195E1ZU' } : {})),
    };

    const escposData = buildFinalBill(fullBillData);

    // Emit-level lock to prevent duplicate emissions
    const emitKey = `${restaurantId}-FINAL_BILL-${fullBillData.tableNumber}-${itemCount}`;
    const emitNow = Date.now();
    const emitLockTs = emitLocks.get(emitKey);
    if (emitLockTs && emitNow - emitLockTs < EMIT_LOCK_TTL_MS) {
      console.warn(`[Print] Duplicate FINAL_BILL emit blocked: ${emitKey}`);
      return res.json({ success: true, skipped: true });
    }
    emitLocks.set(emitKey, emitNow);
    // Clean up old locks
    for (const [key, ts] of emitLocks.entries()) {
      if (emitNow - ts > EMIT_LOCK_TTL_MS) emitLocks.delete(key);
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
router.post("/cancel-bill", async (req, res) => {
  try {
    const { orderId, tableNumber, cancelledBy, cancelledItems } = req.body as {
      orderId?: string;
      tableNumber?: string;
      cancelledBy?: string;
      cancelledItems?: Array<{ name: string; quantity: number; menuType?: string }>;
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
    cmds.push("V GRAND LOUNGE\n");
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
router.post("/reprint-by-transaction", async (req, res) => {
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

    const txn = order.transactions?.[0];

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
    const cgst = Math.round(taxableAmount * 0.025 * 100) / 100;  // 2.5%
    const sgst = Math.round(taxableAmount * 0.025 * 100) / 100;  // 2.5%
    const tax = cgst + sgst;

    const grandTotal = Math.round((subtotal - discountAmount + tax) * 100) / 100;

    // Get KOT numbers from table history
    const kotHistory = (order.table.kotHistory as Array<{ id?: string }>) || [];
    const kotNumbers = kotHistory.map(k => k.id).filter(Boolean);

    // Format table number
    const formattedTableNumber = formatTableLabel(
      order.table.number,
      restaurantId,
      order.table.section?.name
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
      subtotal,
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

export default router;
