// ─────────────────────────────────────────────────────────────────────────────
// Print Routes — ESC/POS print data generation for KOTs and receipts
// ─────────────────────────────────────────────────────────────────────────────
// Generates ESC/POS thermal printer data for:
//   - QZ Tray digital signing (server-side signing with QZ_PRIVATE_KEY)
//   - Food KOT (Kitchen Order Ticket) — items sent to kitchen printer
//   - Liquor KOT — items sent to bar printer
//   - Receipts — full bill with GST, discounts, and payment details
//
// IMPORTANT:
//   - The receipt endpoint fetches from DB by orderId. Never trust the frontend
//     to send the complete item list for receipts.
//   - Item type (food vs liquor) comes from menuItem.menuType on the DB side.
//     For KOT endpoints, the frontend sends items with a `type` field directly.
//   - Also includes Windows Print Agent endpoints for agent setup and session tokens.
//
// Endpoints:
//   POST /api/print/qz-sign         — sign a message for QZ Tray authentication
//   POST /api/print/food-kot        — build Food KOT ESC/POS data
//   POST /api/print/liquor-kot      — build Liquor KOT ESC/POS data
//   POST /api/print/receipt         — build full receipt ESC/POS data from DB
//   POST /api/print/agent-token     — issue a Windows Print Agent setup token
//   POST /api/print/agent-session   — exchange setup token for session token
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import logger from "../lib/logger";
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

import { acquireLock, releaseLock } from "../lib/redisLock";

const PRINT_LOCK_KEY = (key: string) => `print_lock:print:${key}`;
const PRINT_LOCK_TTL = 5; // seconds

const EMIT_LOCK_KEY = (key: string) => `emit_lock:print:${key}`;
const EMIT_LOCK_TTL = 3; // seconds — only needs to prevent simultaneous double-emit

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
router.post("/qz-sign", authenticate, requireRole("OWNER", "ADMIN"), (req, res) => {
  try {
    const { toSign } = req.body as { toSign?: string };

    if (typeof toSign !== "string" || !toSign) {
      res.status(400).json({ error: "toSign is required" });
      return;
    }

    const rawKey = process.env.QZ_PRIVATE_KEY;
    if (!rawKey) {
      logger.error("[print/qz-sign] QZ_PRIVATE_KEY is not set");
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
    logger.error({ err }, "[print/qz-sign] Error:");
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

    // Tenant isolation: validate before DB fetch
    const effectiveRestaurantId = (req as any).user?.activeRestaurantId || (req as any).user?.restaurantId;
    if (!effectiveRestaurantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Fetch table from database with tenant filter
    const table = await prisma.table.findFirst({
      where: { id: String(tableId), restaurantId: effectiveRestaurantId },
      select: { number: true, restaurantId: true, sectionTag: true, section: { select: { name: true } } }
    });

    if (!table) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }

    // Verify tenant access for multi-outlet orgs
    if (table.restaurantId !== effectiveRestaurantId) {
      const userCtx = await resolveTenantContext(effectiveRestaurantId);
      if (!userCtx.allIds.includes(table.restaurantId)) {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
    }

    // Format the table label (B3, T5, CONF-1, PDR-2, etc.)
    const ctx = await resolveTenantContext(table.restaurantId);
    const formattedTableNumber = formatTableLabel(table.number, table.restaurantId, table.section?.name, ctx);

    const data = buildFoodKOT({
      tableNumber: formattedTableNumber,
      orderId,
      kotId: kotId || (kotNumber ? `KOT-${String(kotNumber)}` : undefined),
      kotNumber,
      items,
      sectionName: table.section?.name,
      captainName: captainName || undefined,
      sectionTag: table.sectionTag || undefined,
    });
    res.json({ data });
  } catch (err) {
    logger.error({ err }, "[print/food-kot] Error:");
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

    // Tenant isolation: validate before DB fetch
    const effectiveRestaurantId = (req as any).user?.activeRestaurantId || (req as any).user?.restaurantId;
    if (!effectiveRestaurantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Fetch table from database with tenant filter
    const table = await prisma.table.findFirst({
      where: { id: String(tableId), restaurantId: effectiveRestaurantId },
      select: { number: true, restaurantId: true, sectionTag: true, section: { select: { name: true } } }
    });

    if (!table) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }

    // Verify tenant access for multi-outlet orgs
    if (table.restaurantId !== effectiveRestaurantId) {
      const userCtx = await resolveTenantContext(effectiveRestaurantId);
      if (!userCtx.allIds.includes(table.restaurantId)) {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
    }

    // Format the table label (B3, T5, CONF-1, PDR-2, etc.)
    const ctx = await resolveTenantContext(table.restaurantId);
    const formattedTableNumber = formatTableLabel(table.number, table.restaurantId, table.section?.name, ctx);

    const data = buildLiquorKOT({
      tableNumber: formattedTableNumber,
      orderId,
      kotId: kotId || (kotNumber ? `KOT-${String(kotNumber)}` : undefined),
      kotNumber,
      items,
      sectionName: table.section?.name,
      captainName: captainName || undefined,
      sectionTag: table.sectionTag || undefined,
    });
    res.json({ data });
  } catch (err) {
    logger.error({ err }, "[print/liquor-kot] Error:");
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

    const authRestaurantId = (req as any).user?.activeRestaurantId ?? (req as any).user?.restaurantId;

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
        transactions: { select: { txnNumber: true, txnDate: true } },
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

    const txn = order.transactions;

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

    // Group by name+notes so duplicate items merge, but items with different notes stay separate
    const printItems: PrintItem[] = Object.values(
      rawPrintItems.reduce((acc, item) => {
        const key = `${item.name}::${item.notes ?? ''}`;
        if (!acc[key]) {
          acc[key] = { ...item, quantity: 0 };
        }
        acc[key].quantity += item.quantity;
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
    const rawTotal = Math.round((baseAmount + liquorSubtotal + totalTax) * 100) / 100;
    const total = Math.round(rawTotal);
    const roundOff = Math.round((total - rawTotal) * 100) / 100;

    const data = buildReceipt(orderData, { cgst, sgst, total: totalTax });
    res.json({
      data,
      breakdown: { foodSubtotal, liquorSubtotal, cgst, sgst, total, roundOff }
    });
  } catch (err) {
    logger.error({ err }, "[print/receipt] Error:");
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

    // Fetch outlet data for bill header (restaurant name, address, phone from onboarding)
    const restaurantId = (req as any).user?.activeRestaurantId || (req as any).user?.restaurantId;
    if (restaurantId && !(billData as any).restaurant) {
      const billRestaurant = await prisma.outlet.findUnique({
        where: { id: restaurantId },
        select: { name: true, receiptHeader: true, receiptSubHeader: true, address: true, phone: true, gstin: true },
      });
      if (billRestaurant) {
        (billData as any).restaurant = billRestaurant;
      }
    }

    // Generate ESC/POS commands using new buildFinalBill function
    const escposData = buildFinalBill(billData);

    // Return raw printer data
    res.json({ data: escposData });
  } catch (error: any) {
    logger.error({ err: error }, "[Print] Final bill error:");
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

    // Tenant isolation: validate body restaurantId against the authenticated user's tenant
    const effectiveRestaurantId = (req as any).user?.activeRestaurantId || (req as any).user?.restaurantId;
    if (!effectiveRestaurantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (restaurantId !== effectiveRestaurantId) {
      const userCtx = await resolveTenantContext(effectiveRestaurantId);
      if (!userCtx.allIds.includes(restaurantId)) {
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
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
      notes: item.notes || null,
    }));

    const itemCount = items.length;
    const qtyCount = items.reduce((sum, i) => sum + i.quantity, 0);
    const subtotal = Number(
      billData.subtotal || items.reduce((sum, i) => sum + i.amount, 0)
    );

    // Tax: CGST + SGST on food only (full food subtotal, before discount)
    const foodItems = items.filter((i) => i.menuType === "FOOD");
    const liquorItems = items.filter((i) => { const mt = (i.menuType as string); return mt !== "FOOD"; });
    const foodSubtotal = foodItems.reduce((sum, i) => sum + i.amount, 0);
    const liquorSubtotal = liquorItems.reduce((sum, i) => sum + i.amount, 0);
    const totalSubtotal = foodSubtotal + liquorSubtotal;
    const effectiveRate = getEffectiveGstRate(ctx.gstRate, ctx.gstCategory, ctx.gstRegistered);
    const { cgst, sgst, tax: taxTotal, baseAmount } = getGstBreakdownWithRate(foodSubtotal, effectiveRate, !!ctx.pricesIncludeGst);
    const displayedSubtotal = Math.round((baseAmount + liquorSubtotal) * 100) / 100;

    // Discount applies on overall bill total (displayedSubtotal + GST)
    const preDiscountTotal = displayedSubtotal + taxTotal;
    const discount = billData.discount || null;
    const discountAmount = discount
      ? Math.round(preDiscountTotal * (discount.percent / 100) * 100) / 100
      : 0;
    const rawGrandTotal = Math.round(Math.max(0, preDiscountTotal - discountAmount) * 100) / 100;
    const grandTotal = Number(
      billData.grandTotal || Math.round(rawGrandTotal)
    );
    const roundOff = Math.round((grandTotal - rawGrandTotal) * 100) / 100;

    // Fetch outlet data for bill header (restaurant name, address, phone from onboarding)
    const billRestaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { name: true, receiptHeader: true, receiptSubHeader: true, address: true, phone: true, gstin: true },
    });

    const fullBillData: BillData = {
      billNumber: billData.billNumber || `WALKIN-${Date.now().toString(36).toUpperCase()}`,
      date,
      time,
      kotNumbers: billData.kotNumbers || [],
      tableNumber: billData.tableNumber || "Walk-in",
      captain: (billData as any).captain || "Walk-in",
      items,
      subtotal: totalSubtotal,
      discount: discount ? { percent: discount.percent, amount: discountAmount } : undefined,
      tax: { cgst, sgst, total: taxTotal },
      grandTotal,
      roundOff,
      section: (billData as any).section || "Walk-in",
      sectionTag: (billData as any).sectionTag || null,
      itemCount,
      qtyCount,
      ...(billData.gstIn ? { gstIn: billData.gstIn } : (ctx.gstin ? { gstIn: ctx.gstin } : {})),
      restaurant: billRestaurant as any,
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
    try {
      await bufferPrintJob(restaurantId, enriched);
    } catch {
      // non-fatal — emit anyway so the connected agent still gets the job
    }
    getIo().to(`print:${restaurantId}`).emit("print_job", enriched);
    releaseLock(EMIT_LOCK_KEY(emitKey)).catch(() => {});

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, "[Print] Final bill emit error:");
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
    logger.error({ err: error }, "[Print] Cancel bill error:");
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

    // Tenant isolation: validate body restaurantId against the authenticated user's tenant
    const effectiveRestaurantId = (req as any).user?.activeRestaurantId || (req as any).user?.restaurantId;
    if (!effectiveRestaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (restaurantId !== effectiveRestaurantId) {
      const userCtx = await resolveTenantContext(effectiveRestaurantId);
      if (!userCtx.allIds.includes(restaurantId)) {
        return res.status(403).json({ error: 'Cross-tenant access denied' });
      }
    }

    // Dedup lock — prevents double-printing from rapid duplicate requests
    const reprintLockKey = `${restaurantId}-${orderId}`;
    const reprintAcquired = await acquireLock(PRINT_LOCK_KEY(reprintLockKey), PRINT_LOCK_TTL);
    if (!reprintAcquired) {
      return res.status(429).json({ error: "Duplicate reprint request — please wait" });
    }

    // 1. Fetch order with table, items, and latest transaction
    // Select full transaction fields so reprint uses exact settled values (discount, totals, items)
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: { menuItem: true }
        },
        table: {
          include: { section: { include: { venue: { include: { taxProfile: true } } } }, kots: { select: { kotNumber: true } } }
        },
        transactions: { select: { txnNumber: true, txnDate: true, billNumber: true, discountPercent: true, discountAmount: true, subtotal: true, cgst: true, sgst: true, grandTotal: true, items: true, paidAt: true } },
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Validate order belongs to the caller's restaurant
    if (order.restaurantId !== restaurantId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const txn = order.transactions;
    const ctx = await resolveTenantContext(restaurantId);

    // Resolve venue-level tax profile (may differ from restaurant default)
    const venueTaxProfile = order.table?.section?.venue?.taxProfile;
    const taxSource = venueTaxProfile
      ? { gstRate: venueTaxProfile.gstRate, gstCategory: venueTaxProfile.gstCategory, gstRegistered: venueTaxProfile.gstRegistered, pricesIncludeGst: ctx.pricesIncludeGst }
      : ctx;

    // Fetch outlet data for bill header (restaurant name, address, phone from onboarding)
    const reprintRestaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { name: true, receiptHeader: true, receiptSubHeader: true, address: true, phone: true, gstin: true },
    });

    // 2. Filter active items (non-removed, non-zero quantity)
    const activeItems = order.items.filter((i: any) => !(i as any).removedFromBill && i.quantity > 0);
    if (activeItems.length === 0) {
      return res.status(400).json({ error: "No items to reprint" });
    }

    // 3. Use stored transaction values for exact reprint when available.
    //    The Transaction record has the exact discount, subtotal, taxes, and grandTotal
    //    that were actually billed at settlement time.  The table.discount field may
    //    have been reset after settlement, so recalculating from it produces wrong totals.
    const txnRecord = Array.isArray(txn) ? txn[0] : null;

    let discount: { percent: number; amount: number } | null = null;
    let discountAmount = 0;
    let subtotal: number;
    let cgst: number;
    let sgst: number;
    let tax: number;
    let grandTotal: number;
    let roundOff = 0;
    let billItems: Array<{ name: string; quantity: number; price: number; amount: number; menuType: string; notes: string | null }>;

    if (txnRecord && txnRecord.grandTotal != null) {
      // ── Exact reprint using stored transaction values ──
      const discPercent = Number(txnRecord.discountPercent || 0);
      discountAmount = Number(txnRecord.discountAmount || 0);
      if (discPercent > 0 && discountAmount > 0) {
        discount = { percent: discPercent, amount: discountAmount };
      }
      subtotal = Number(txnRecord.subtotal || 0);
      cgst = Number(txnRecord.cgst || 0);
      sgst = Number(txnRecord.sgst || 0);
      tax = cgst + sgst;
      grandTotal = Math.round(Number(txnRecord.grandTotal || 0));

      // Use stored transaction items if available (exact line items from settlement)
      const storedItems = txnRecord.items as any[];
      if (storedItems && Array.isArray(storedItems) && storedItems.length > 0) {
        billItems = storedItems.map((item: any) => ({
          name: item.name || 'Unknown',
          quantity: Number(item.quantity || 1),
          price: Number(item.price || 0),
          amount: Number(item.price || 0) * Number(item.quantity || 1),
          menuType: ((item.menuType || 'FOOD') as string).toUpperCase() as 'FOOD' | 'LIQUOR',
          notes: item.notes || null,
        }));
      } else {
        billItems = (() => {
          const grouped = activeItems.reduce((acc: any, item: any) => {
            const key = `${item.name}::${Number(item.price)}::${item.notes ?? ''}`;
            if (!acc[key]) {
              acc[key] = { name: item.name, quantity: 0, price: Number(item.price), menuType: item.menuItem.menuType, notes: item.notes ?? null };
            }
            acc[key].quantity += item.quantity;
            return acc;
          }, {} as Record<string, any>);
          return Object.values(grouped).map((item: any) => ({
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            amount: item.price * item.quantity,
            menuType: item.menuType,
            notes: item.notes
          }));
        })();
      }
    } else {
      // ── Fallback: recalculate from order items + table discount (older transactions) ──
      const foodItems = activeItems.filter((item: any) => item.menuItem.menuType === "FOOD");
      const liquorItems = activeItems.filter((item: any) => { const mt = item.menuItem.menuType as string; return mt === "LIQUOR" || mt === "BAR"; });

      const foodSubtotal = foodItems.reduce((sum: number, item: any) =>
        sum + (Number(item.price) * item.quantity), 0
      );
      const liquorSubtotal = liquorItems.reduce((sum: number, item: any) =>
        sum + (Number(item.price) * item.quantity), 0
      );
      subtotal = foodSubtotal + liquorSubtotal;

      // GST-exempt items (gstEnabled=false on MenuItem) - applies to both FOOD and LIQUOR
      const gstExemptFood = foodItems
        .filter((item: any) => item.menuItem.gstEnabled === false)
        .reduce((sum: number, item: any) => sum + (Number(item.price) * item.quantity), 0);
      const gstExemptLiquor = liquorItems
        .filter((item: any) => item.menuItem.gstEnabled === false)
        .reduce((sum: number, item: any) => sum + (Number(item.price) * item.quantity), 0);
      const gstExemptTotal = gstExemptFood + gstExemptLiquor;

      // Apply discount if set on table
      if (order.table.discount && Number(order.table.discount) > 0) {
        const discountPercent = Number(order.table.discount);
        discountAmount = Math.round(subtotal * (discountPercent / 100) * 100) / 100;
        discount = { percent: discountPercent, amount: discountAmount };
      }

      // Tax calculation (CGST + SGST on food only, AFTER discount, excluding GST-disabled items)
      const discountedFood = foodSubtotal - (discount ? discountAmount * (foodSubtotal / subtotal) : 0);
      const discountedLiquor = liquorSubtotal - (discount ? discountAmount * (liquorSubtotal / subtotal) : 0);
      const gstExemptAfterDiscount = Math.max(0, gstExemptTotal - (discount ? discountAmount * (gstExemptTotal / subtotal) : 0));
      const taxableAmount = Math.max(0, discountedFood - (gstExemptAfterDiscount * (foodSubtotal / (foodSubtotal + liquorSubtotal || 1))));
      const effectiveRate = getEffectiveGstRate(taxSource.gstRate, taxSource.gstCategory, taxSource.gstRegistered);
      const gstBreakdown = getGstBreakdownWithRate(taxableAmount, effectiveRate, !!taxSource.pricesIncludeGst);
      cgst = gstBreakdown.cgst;
      sgst = gstBreakdown.sgst;
      tax = gstBreakdown.tax;
      const baseAmount = gstBreakdown.baseAmount;
      const liquorAfterDiscount = discountedLiquor - (gstExemptAfterDiscount * (liquorSubtotal / (foodSubtotal + liquorSubtotal || 1)));
      const displayedSubtotal = Math.round((baseAmount + gstExemptAfterDiscount + liquorAfterDiscount) * 100) / 100;

      const rawGrandTotal = Math.round((displayedSubtotal + tax) * 100) / 100;
      grandTotal = Math.round(rawGrandTotal);
      roundOff = Math.round((grandTotal - rawGrandTotal) * 100) / 100;

      billItems = (() => {
        const grouped = activeItems.reduce((acc: any, item: any) => {
          const key = `${item.name}::${Number(item.price)}::${item.notes ?? ''}`;
          if (!acc[key]) {
            acc[key] = { name: item.name, quantity: 0, price: Number(item.price), menuType: item.menuItem.menuType, notes: item.notes ?? null };
          }
          acc[key].quantity += item.quantity;
          return acc;
        }, {} as Record<string, any>);
        return Object.values(grouped).map((item: any) => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          amount: item.price * item.quantity,
          menuType: item.menuType,
          notes: item.notes
        }));
      })();
    }

    // Get KOT numbers from relational Kot table
    const kotHistory = (order.table.kots as Array<{ kotNumber: number }>) || [];
    const kotNumbers = kotHistory.map(k => String(k.kotNumber)).filter(Boolean);

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

    // Build bill data for print — isReprint flag renders REPRINT header/stamp on the bill
    const billData: any = {
      billNumber: txnRecord?.billNumber || order.billNumber || "REPRINT",
      date: dateStr,
      time: timeStr,
      kotNumbers,
      tableNumber: formattedTableNumber,
      captain: order.table.captainId || "N/A",
      items: billItems,
      subtotal,
      discount,
      tax: { cgst, sgst, total: tax },
      grandTotal,
      roundOff,
      section: order.table.section?.name || "Main Hall",
      sectionTag: (order.table as any)?.sectionTag || null,
      itemCount: billItems.length,
      qtyCount: billItems.reduce((sum, item) => sum + item.quantity, 0),
      isReprint: true,
      ...(ctx.gstin ? { gstIn: ctx.gstin } : {}),
      restaurant: reprintRestaurant as any,
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
    try {
      await bufferPrintJob(restaurantId, enriched);
    } catch {
      // non-fatal — emit anyway so the connected agent still gets the job
    }
    getIo().to(`print:${restaurantId}`).emit("print_job", enriched);

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, "[Print] Reprint by transaction error:");
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

    const restaurantId = user.activeRestaurantId ?? user.restaurantId;
    const setupToken = signAgentToken(
      { restaurantId, purpose: "agent-setup", restaurantCode: user.restaurantCode || undefined },
      "15m",
    );

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    res.json({ token: setupToken, expiresAt, restaurantCode: user.restaurantCode || null });
  } catch (err) {
    logger.error({ err }, "[print/agent-token] Error:");
    res.status(500).json({ error: "Failed to generate agent token" });
  }
});

/**
 * POST /api/print/agent-register
 * Auth: Bearer = agent setup token (from /agent-token)
 * Body: { agentId: string, restaurantCode?: string, printerMapping: { kitchen?, bar?, bill? } }
 * Response: { sessionToken, restaurantId, restaurantCode, restaurantName, missedJobs }
 */
router.post("/agent-register", async (req, res) => {
  // Hoist identifiers so the unexpected-error catch block can log them.
  let restaurantId: string | undefined;
  let agentId: string | undefined;
  let restaurantCode: string | undefined;

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

    restaurantId = decoded.restaurantId;
    if (!restaurantId || typeof restaurantId !== "string") {
      res.status(401).json({ error: "Setup token missing restaurantId" });
      return;
    }

    let printerMapping: { kitchen?: string; bar?: string; bill?: string } | undefined;
    let availablePrinters: string[] | undefined;
    let lanIp: string | undefined;
    ({ agentId, printerMapping, restaurantCode, availablePrinters, lanIp } = req.body as {
      agentId?: string;
      printerMapping?: { kitchen?: string; bar?: string; bill?: string };
      restaurantCode?: string;
      availablePrinters?: string[];
      lanIp?: string;
    });

    if (!agentId) {
      res.status(400).json({ error: "agentId is required" });
      return;
    }

    if (restaurantCode && restaurantCode !== decoded.restaurantCode) {
      logger.warn(
        { restaurantId, agentId, providedCode: restaurantCode, expectedCode: decoded.restaurantCode },
        "[print/agent-register] Restaurant code mismatch",
      );
      res.status(400).json({ error: "Restaurant code does not match the setup token" });
      return;
    }

    const restaurant = await prisma.outlet.findUnique({
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
      availablePrinters: availablePrinters || [],
      lastAgentId: agentId,
      lastAgentSeen: new Date().toISOString(),
      agentLanIp: lanIp || null,
      agentHttpUrl: lanIp ? `http://${lanIp}:3100` : null,
    };

    try {
      await prisma.outlet.update({
        where: { id: restaurantId },
        data: { printerConfig: newConfig },
      });
    } catch (dbErr) {
      logger.error({ err: dbErr }, "[print/agent-register] DB update failed:");
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
      logger.error({ err: jwtErr }, "[print/agent-register] JWT signing failed:");
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
    logger.error(
      { err, restaurantId, agentId, restaurantCode },
      "[print/agent-register] Unexpected error:",
    );
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
    const { printerStatus, availablePrinters, lanIp } = req.body as { printerStatus?: Record<string, string>; availablePrinters?: string[]; lanIp?: string };

    const restaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { printerConfig: true },
    });
    if (!restaurant) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }

    const existingConfig = (restaurant.printerConfig as Record<string, any>) || {};
    const updateData: Record<string, any> = {
      ...existingConfig,
      agentOnline: true,
      agentLastSeen: new Date().toISOString(),
      agentPrinterStatus: printerStatus || {},
    };
    if (availablePrinters) updateData.availablePrinters = availablePrinters;
    if (lanIp) {
      updateData.agentLanIp = lanIp;
      updateData.agentHttpUrl = `http://${lanIp}:3100`;
    }
    await prisma.outlet.update({
      where: { id: restaurantId },
      data: { printerConfig: updateData },
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "[print/agent-heartbeat] Error:");
    res.status(500).json({ error: "Failed to process heartbeat" });
  }
});

/**
 * POST /api/print/agent-update-mapping
 * Auth: Bearer = agent session token
 * Body: { printerMapping: { kitchen?, bar?, bill? } }
 * Response: { ok: true }
 *
 * Called by the Windows Print Agent when the user saves printer assignments
 * so the backend's printerConfig.agentMapping stays in sync.
 */
router.post("/agent-update-mapping", async (req, res) => {
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
    const { printerMapping, availablePrinters } = req.body as { printerMapping?: { kitchen?: string; bar?: string; bill?: string }; availablePrinters?: string[] };

    if (!printerMapping || typeof printerMapping !== "object") {
      res.status(400).json({ error: "printerMapping is required" });
      return;
    }

    const restaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { printerConfig: true },
    });
    if (!restaurant) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }

    const existingConfig = (restaurant.printerConfig as Record<string, any>) || {};
    const updateData: Record<string, any> = {
      ...existingConfig,
      agentMapping: printerMapping,
      lastAgentSeen: new Date().toISOString(),
    };
    if (availablePrinters) updateData.availablePrinters = availablePrinters;
    await prisma.outlet.update({
      where: { id: restaurantId },
      data: { printerConfig: updateData },
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "[print/agent-update-mapping] Error:");
    res.status(500).json({ error: "Failed to update printer mapping" });
  }
});

/**
 * GET /api/print/agent-endpoint
 * Auth: JWT (any logged-in staff)
 * Response: { lanIp, httpUrl, online }
 *
 * Returns the Print Agent's last-known LAN IP and HTTP URL so that
 * captain/cashier apps on the same LAN can discover and print locally.
 */
router.get("/agent-endpoint", authenticate, async (req, res) => {
  try {
    const user = (req as any).user;
    const restaurantId = user.activeRestaurantId ?? user.restaurantId;
    if (!restaurantId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const restaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { printerConfig: true },
    });
    if (!restaurant) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }

    const config = (restaurant.printerConfig as Record<string, any>) || {};
    const lastSeen = config.agentLastSeen ? new Date(config.agentLastSeen) : null;
    const online = lastSeen ? Date.now() - lastSeen.getTime() < 90_000 : false;

    res.json({
      lanIp: config.agentLanIp || null,
      httpUrl: config.agentHttpUrl || null,
      online,
      lastSeen: config.agentLastSeen || null,
      printerMapping: config.agentMapping || {},
    });
  } catch (err) {
    logger.error({ err }, "[print/agent-endpoint] Error:");
    res.status(500).json({ error: "Failed to get agent endpoint" });
  }
});

/**
 * GET /api/print/agent-status
 * Auth: JWT (OWNER or ADMIN)
 * Response: { online, lastSeen, printerStatus, agentMapping, restaurantCode }
 */
router.get("/agent-status", authenticate, requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  try {
    const user = (req as any).user;

    const restaurant = await prisma.outlet.findUnique({
      where: { id: user.activeRestaurantId ?? user.restaurantId },
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
      availablePrinters: config.availablePrinters || [],
      restaurantCode: restaurant.restaurantCode,
    });
  } catch (err) {
    logger.error({ err }, "[print/agent-status] Error:");
    res.status(500).json({ error: "Failed to get agent status" });
  }
});

export default router;
