/**
 * ESC/POS print data builders for QZ Tray.
 *
 * All builders return a single-element array containing one raw ESC/POS
 * command object { type: 'raw', format: 'plain', data: '...' }.
 *
 * NO image/logo/canvas/pixel blocks â€” raw text only.
 * QZ Tray chokes on mixed pixel+raw arrays on most thermal drivers.
 *
 * ESC/POS quick reference:
 *   \x1B\x40        â€“ Initialize printer
 *   \x1B\x61\x01   â€“ Center align
 *   \x1B\x61\x00   â€“ Left align
 *   \x1B\x45\x01   â€“ Bold ON
 *   \x1B\x45\x00   â€“ Bold OFF
 *   \x1D\x56\x42\x00 â€“ Paper cut (partial)
 */

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PrintItem {
  name: string;
  price?: number;
  quantity: number;
  notes?: string | null;
  type?: "food" | "liquor";
}

export interface OrderData {
  tableNumber: number | string;
  orderId: string;
  items: PrintItem[];
  restaurantName?: string;
}

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const LINE_WIDTH = 42; // characters per line on 80mm / 58mm thermal paper

function separator(ch = "-"): string {
  return ch.repeat(LINE_WIDTH) + "\n";
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
 * Right-align a value string against a label within LINE_WIDTH.
 * e.g. "2x Butter Chicken         Rs.480.00"
 */
function formatItemLine(label: string, valueStr: string): string {
  const available = LINE_WIDTH - valueStr.length;
  return label.substring(0, available).padEnd(available) + valueStr + "\n";
}

// â”€â”€â”€ Food KOT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function buildFoodKOT(
  orderData: OrderData,
): object[] {
  const { tableNumber, orderId, items } = orderData;
  const foodItems = items.filter((i) => i.type === "food");

  if (foodItems.length === 0) return [];

  const { time } = formatNow();

  const cmds: string[] = [
    "\x1B\x40",         // init
    "\x1B\x61\x01",    // center
    "\x1B\x45\x01",    // bold on
    "FOOD ORDER\n",
    "\x1B\x45\x00",    // bold off
    "\x1B\x61\x00",    // left
    separator(),
    `Table  : ${tableNumber}\n`,
    `KOT    : ${orderId.slice(-6).toUpperCase()}\n`,
    `Time   : ${time}\n`,
    separator(),
  ];

  for (const item of foodItems) {
    cmds.push(`${item.quantity}x  ${item.name}\n`);
    if (item.notes) cmds.push(`     * ${item.notes}\n`);
  }

  cmds.push(separator(), "\n\n\n", "\x1D\x56\x42\x00");

  return [{ type: "raw", format: "plain", data: cmds.join("") }];
}

// â”€â”€â”€ Liquor / Bar KOT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function buildLiquorKOT(
  orderData: OrderData,
): object[] {
  const { tableNumber, orderId, items } = orderData;
  const liquorItems = items.filter((i) => i.type === "liquor");

  if (liquorItems.length === 0) return [];

  const { time } = formatNow();

  const cmds: string[] = [
    "\x1B\x40",
    "\x1B\x61\x01",
    "\x1B\x45\x01",
    "BAR ORDER\n",
    "\x1B\x45\x00",
    "\x1B\x61\x00",
    separator(),
    `Table  : ${tableNumber}\n`,
    `KOT    : ${orderId.slice(-6).toUpperCase()}\n`,
    `Time   : ${time}\n`,
    separator(),
  ];

  for (const item of liquorItems) {
    cmds.push(`${item.quantity}x  ${item.name}\n`);
    if (item.notes) cmds.push(`     * ${item.notes}\n`);
  }

  cmds.push(separator(), "\n\n\n", "\x1D\x56\x42\x00");

  return [{ type: "raw", format: "plain", data: cmds.join("") }];
}

// â”€â”€â”€ Full Receipt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function buildReceipt(
  orderData: OrderData,
): object[] {
  const { tableNumber, orderId, items, restaurantName = "V GRAND LOUNGE" } = orderData;
  const { date, time } = formatNow();

  const foodItems    = items.filter((i) => i.type === "food");
  const liquorItems  = items.filter((i) => i.type === "liquor");

  const foodSubtotal    = foodItems.reduce((s, i) => s + (i.price ?? 0) * i.quantity, 0);
  const liquorSubtotal  = liquorItems.reduce((s, i) => s + (i.price ?? 0) * i.quantity, 0);
  const cgst  = Math.round(foodSubtotal * 0.025 * 100) / 100;
  const sgst  = Math.round(foodSubtotal * 0.025 * 100) / 100;
  const total = Math.round((foodSubtotal + liquorSubtotal + cgst + sgst) * 100) / 100;

  const fmt = (n: number) => `Rs.${n.toFixed(2)}`;

  const cmds: string[] = [
    "\x1B\x40",
    "\x1B\x61\x01",
    "\x1B\x45\x01",
    `${restaurantName}\n`,
    "\x1B\x45\x00",
    "\x1B\x61\x00",
    separator(),
    `Table  : ${tableNumber}\n`,
    `Order  : ${orderId.slice(-6).toUpperCase()}\n`,
    `Date   : ${date}\n`,
    `Time   : ${time}\n`,
    separator(),
  ];

  if (foodItems.length > 0) {
    cmds.push("\x1B\x45\x01", "FOOD\n", "\x1B\x45\x00");
    for (const item of foodItems) {
      cmds.push(formatItemLine(`${item.quantity}x ${item.name}`, fmt((item.price ?? 0) * item.quantity)));
      if (item.notes) cmds.push(`   * ${item.notes}\n`);
    }
  }

  if (liquorItems.length > 0) {
    cmds.push("\x1B\x45\x01", "LIQUOR\n", "\x1B\x45\x00");
    for (const item of liquorItems) {
      cmds.push(formatItemLine(`${item.quantity}x ${item.name}`, fmt((item.price ?? 0) * item.quantity)));
      if (item.notes) cmds.push(`   * ${item.notes}\n`);
    }
  }

  cmds.push(separator());
  if (foodItems.length > 0)   cmds.push(formatItemLine("Food Subtotal",   fmt(foodSubtotal)));
  if (liquorItems.length > 0) cmds.push(formatItemLine("Liquor Subtotal", fmt(liquorSubtotal)));
  if (cgst > 0) cmds.push(formatItemLine("CGST (2.5%)", fmt(cgst)));
  if (sgst > 0) cmds.push(formatItemLine("SGST (2.5%)", fmt(sgst)));

  cmds.push(
    "\x1B\x45\x01",
    formatItemLine("TOTAL", fmt(total)),
    "\x1B\x45\x00",
    separator(),
    "\x1B\x61\x01",
    "Thank you for dining with us!\n",
    "Please visit again.\n",
    "\x1B\x61\x00",
    "\n\n\n",
    "\x1D\x56\x42\x00",
  );

  return [{ type: "raw", format: "plain", data: cmds.join("") }];
}
