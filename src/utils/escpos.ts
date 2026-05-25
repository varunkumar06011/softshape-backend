/**
 * ESC/POS print data builders for QZ Tray.
 *
 * All builders return an array that QZ Tray's qz.print() accepts.
 * The first element is always the logo image block (pixel/image/base64).
 * Subsequent elements are raw ESC/POS command strings.
 *
 * ESC/POS quick reference:
 *   \x1B\x40        – Initialize printer
 *   \x1B\x61\x01   – Center align
 *   \x1B\x61\x00   – Left align
 *   \x1B\x45\x01   – Bold ON
 *   \x1B\x45\x00   – Bold OFF
 *   \x1D\x56\x42\x00 – Paper cut (partial)
 */

import * as fs from "fs";
import * as path from "path";

// ─── Logo ──────────────────────────────────────────────────────────────────

// Resolve logo.png relative to the project root (works for both ts-node and compiled dist)
// ts-node:  __dirname = .../src/utils  → ../../assets = .../assets
// compiled: __dirname = .../dist/utils → ../../assets = .../assets  (copy assets/ to dist root manually or via build script)
// We also try the src-relative path as a fallback for ts-node.
const LOGO_PATH = (() => {
  const fromDir = path.join(__dirname, "../../assets/logo.png");
  const fromSrc = path.join(__dirname, "../assets/logo.png");
  if (fs.existsSync(fromDir)) return fromDir;
  if (fs.existsSync(fromSrc)) return fromSrc;
  return fromDir; // will fail gracefully below
})();

/** Read logo once at module load. Undefined if file is missing. */
export const LOGO_BASE64: string | undefined = (() => {
  try {
    const buf = fs.readFileSync(LOGO_PATH);
    const b64 = buf.toString("base64");
    console.log("[escpos] Logo loaded, base64 length:", b64.length);
    return b64;
  } catch (err) {
    console.warn("[escpos] logo.png not found at", LOGO_PATH, "– printing without logo");
    return undefined;
  }
})();

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PrintItem {
  name: string;
  price?: number;
  quantity: number;
  notes?: string | null;
  type?: "food" | "liquor"; // used for filtering in receipt
}

export interface OrderData {
  tableNumber: number | string;
  orderId: string;
  items: PrintItem[];
  restaurantName?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LINE_WIDTH = 42; // characters per line on 80mm thermal paper

function separator(): string {
  return "-".repeat(LINE_WIDTH) + "\n";
}

function logoBlock(logoBase64: string | undefined): object | null {
  if (!logoBase64) return null;
  return {
    type: "pixel",
    format: "image",
    flavor: "base64",
    data: logoBase64,
    options: { language: "ESCPOS" },
  };
}

function formatNow(): { date: string; time: string } {
  const now = new Date();
  const date = now.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const time = now.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return { date, time };
}

/**
 * Right-align a price string against a label string within LINE_WIDTH.
 * e.g. "2x Butter Chicken         480.00"
 */
function formatItemLine(label: string, priceStr: string): string {
  const available = LINE_WIDTH - priceStr.length;
  return label.substring(0, available).padEnd(available) + priceStr + "\n";
}

// ─── Food KOT ────────────────────────────────────────────────────────────────

export function buildFoodKOT(
  orderData: OrderData,
  logoBase64: string | undefined
): Array<object | string> {
  const { tableNumber, orderId, items } = orderData;
  const foodItems = items.filter((i) => i.type === "food");

  if (foodItems.length === 0) return [];

  const { time } = formatNow();
  const logo = logoBlock(logoBase64);

  const rawCommands: string[] = [
    "\x1B\x40", // init
    "\x1B\x61\x01", // center
    "\x1B\x45\x01", // bold on
    "FOOD ORDER\n",
    "\x1B\x45\x00", // bold off
    "\x1B\x61\x00", // left
    separator(),
    `Table  : ${tableNumber}\n`,
    `Order  : ${orderId}\n`,
    `Time   : ${time}\n`,
    separator(),
  ];

  for (const item of foodItems) {
    rawCommands.push(`${item.quantity}x  ${item.name}\n`);
    if (item.notes) {
      rawCommands.push(`     * ${item.notes}\n`);
    }
  }

  rawCommands.push(separator());
  rawCommands.push("\n\n\n");
  rawCommands.push("\x1D\x56\x42\x00"); // paper cut

  const result: Array<object | string> = [];
  if (logo) result.push(logo);
  result.push(...rawCommands);
  return result;
}

// ─── Liquor / Bar KOT ────────────────────────────────────────────────────────

export function buildLiquorKOT(
  orderData: OrderData,
  logoBase64: string | undefined
): Array<object | string> {
  const { tableNumber, orderId, items } = orderData;
  const liquorItems = items.filter((i) => i.type === "liquor");

  if (liquorItems.length === 0) return [];

  const { time } = formatNow();
  const logo = logoBlock(logoBase64);

  const rawCommands: string[] = [
    "\x1B\x40",
    "\x1B\x61\x01",
    "\x1B\x45\x01",
    "BAR ORDER\n",
    "\x1B\x45\x00",
    "\x1B\x61\x00",
    separator(),
    `Table  : ${tableNumber}\n`,
    `Order  : ${orderId}\n`,
    `Time   : ${time}\n`,
    separator(),
  ];

  for (const item of liquorItems) {
    rawCommands.push(`${item.quantity}x  ${item.name}\n`);
    if (item.notes) {
      rawCommands.push(`     * ${item.notes}\n`);
    }
  }

  rawCommands.push(separator());
  rawCommands.push("\n\n\n");
  rawCommands.push("\x1D\x56\x42\x00");

  const result: Array<object | string> = [];
  if (logo) result.push(logo);
  result.push(...rawCommands);
  return result;
}

// ─── Full Receipt ─────────────────────────────────────────────────────────────

export function buildReceipt(
  orderData: OrderData,
  logoBase64: string | undefined
): Array<object | string> {
  const { tableNumber, orderId, items, restaurantName = "V GRAND LOUNGE" } = orderData;
  const { date, time } = formatNow();

  const foodItems = items.filter((i) => i.type === "food");
  const liquorItems = items.filter((i) => i.type === "liquor");

  const logo = logoBlock(logoBase64);

  // ── Calculate totals ───────────────────────────────────────────────────────
  const subtotal = items.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0);
  const taxRate = 0.05;
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;

  const fmt = (n: number) => `₹${n.toFixed(2)}`;

  const rawCommands: string[] = [
    "\x1B\x40",
    "\x1B\x61\x01",
    "\x1B\x45\x01",
    `${restaurantName}\n`,
    "\x1B\x45\x00",
    "\x1B\x61\x00",
    separator(),
    `Table  : ${tableNumber}\n`,
    `Order  : ${orderId}\n`,
    `Date   : ${date}\n`,
    `Time   : ${time}\n`,
    separator(),
  ];

  // ── Food items ─────────────────────────────────────────────────────────────
  if (foodItems.length > 0) {
    rawCommands.push("\x1B\x45\x01", "FOOD\n", "\x1B\x45\x00");
    for (const item of foodItems) {
      const label = `${item.quantity}x ${item.name}`;
      const priceStr = fmt((item.price ?? 0) * item.quantity);
      rawCommands.push(formatItemLine(label, priceStr));
      if (item.notes) rawCommands.push(`   * ${item.notes}\n`);
    }
  }

  // ── Liquor items ───────────────────────────────────────────────────────────
  if (liquorItems.length > 0) {
    rawCommands.push("\x1B\x45\x01", "LIQUOR\n", "\x1B\x45\x00");
    for (const item of liquorItems) {
      const label = `${item.quantity}x ${item.name}`;
      const priceStr = fmt((item.price ?? 0) * item.quantity);
      rawCommands.push(formatItemLine(label, priceStr));
      if (item.notes) rawCommands.push(`   * ${item.notes}\n`);
    }
  }

  // ── Totals ─────────────────────────────────────────────────────────────────
  rawCommands.push(separator());
  rawCommands.push(formatItemLine("Subtotal", fmt(subtotal)));
  rawCommands.push(formatItemLine("Tax (5%)", fmt(tax)));
  rawCommands.push("\x1B\x45\x01");
  rawCommands.push(formatItemLine("TOTAL", fmt(total)));
  rawCommands.push("\x1B\x45\x00");
  rawCommands.push(separator());

  // ── Footer ─────────────────────────────────────────────────────────────────
  rawCommands.push("\x1B\x61\x01");
  rawCommands.push("Thank you for dining with us!\n");
  rawCommands.push("Please visit again.\n");
  rawCommands.push("\x1B\x61\x00");
  rawCommands.push("\n\n\n");
  rawCommands.push("\x1D\x56\x42\x00");

  const result: Array<object | string> = [];
  if (logo) result.push(logo);
  result.push(...rawCommands);
  return result;
}
