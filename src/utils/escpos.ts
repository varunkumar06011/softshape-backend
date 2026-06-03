/**
 * ESC/POS print data builders for QZ Tray.
 *
 * All builders return a single-element array containing one raw ESC/POS
 * command object { type: 'raw', format: 'plain', data: '...' }.
 *
 * NO image/logo/canvas/pixel blocks â€" raw text only.
 * QZ Tray chokes on mixed pixel+raw arrays on most thermal drivers.
 *
 * ESC/POS quick reference:
 *   \x1B\x40        — Initialize printer
 *   \x1D!\x11      — Double width AND double height (2x size)
 *   \x1D!\x00      — Normal size (default)
 *   \x1B\x61\x01   — Center align
 *   \x1B\x61\x00   — Left align
 *   \x1B\x45\x01   — Bold ON
 *   \x1B\x45\x00   — Bold OFF
 *   \x1D\x56\x42\x00 — Paper cut (partial)
 */

// ─── ESC/POS Constants ───────────────────────────────────────────────────────
const INIT = '\x1B\x40';
const CENTER = '\x1B\x61\x01';
const LEFT = '\x1B\x61\x00';
const BOLD_ON = '\x1B\x45\x01';
const BOLD_OFF = '\x1B\x45\x00';
const SIZE_2X = '\x1D\x21\x11';
const SIZE_NORMAL = '\x1D\x21\x00';
const SIZE_HEIGHT = '\x1D\x21\x01';
const CUT = '\x1D\x56\x42\x00';

const LINE_NORMAL = 42;
const LINE_2X = 21;

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
  kotNumber?: number | string;
  kotId?: string;  // "KOT-01", "KOT-02", etc.
  txnNumber?: number;
  txnDate?: string;
  captainId?: string;
  captainName?: string;
  sectionName?: string;
}

export interface BillData {
  billNumber: string;        // "30/05/26-042"
  date: string;              // "30/05/2026"
  time: string;              // "12:30 PM"
  kotNumbers?: string[];     // ["01", "02", "03"] — all KOT IDs from session
  tableNumber: string;       // "B3" or "T5"
  captain: string;           // "John"
  items: Array<{
    name: string;
    quantity: number;
    price: number;
    amount: number;
    menuType: "FOOD" | "LIQUOR";
  }>;
  subtotal: number;
  discount?: { percent: number; amount: number };
  tax: { cgst: number; sgst: number; total: number };
  grandTotal: number;
  section: string;           // "Bar Ac Hall" or "Main Hall"
  itemCount: number;
  qtyCount: number;
}

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const LINE_WIDTH = 21; // characters per line for 2x size (doubled from 42)

import { formatTxnDisplayId } from "./date";

function separator(ch = "-"): string {
  return ch.repeat(LINE_NORMAL) + "\n";
}

function formatBillNumber(txnDate?: string, txnNumber?: number): string {
  return formatTxnDisplayId(txnDate, txnNumber);
}

function formatNow(): { date: string; time: string } {
  const now = new Date();
  const date = now.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
  const time = now.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
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
  const { tableNumber, orderId, items, kotId, sectionName } = orderData;
  const foodItems = items.filter((i) => i.type === "food");

  if (foodItems.length === 0) return [];

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

  // Parse KOT number
  const displayKotId = kotId || "N/A";

  const cmds: string[] = [
    INIT,
    CENTER,
    BOLD_ON,
    "KOT (Kitchen)\n",
    BOLD_OFF,
    LEFT,
    separator("-"),
    SIZE_HEIGHT,
    BOLD_ON,
    `KOT No : ${displayKotId}\n`,
    `Table  : ${(tableNumber || 'N/A').toString().replace(/^[BT]/i, '')}\n`,
    BOLD_OFF,
    SIZE_NORMAL,
    separator("-"),
    "Waiter : Waiter\n",
    `Ordered Date : ${dateStr}  Time : ${timeStr}\n`,
    separator("-"),
    BOLD_ON,
    "Qty  Item\n",
    BOLD_OFF,
    separator("-"),
  ];

  for (const item of foodItems) {
    const line = `${item.quantity}  ${item.name.toUpperCase()}`;
    cmds.push(
      SIZE_2X,
      BOLD_ON,
      line + "\n",
      BOLD_OFF,
      SIZE_NORMAL,
      "\n"
    );
  }

  cmds.push(
    separator("-"),
    `Hall Name : ${sectionName || 'N/A'}\n`,
    "\n\n\n",
    CUT
  );

  return [{ type: "raw", format: "plain", data: cmds.join("") }];
}

// â”€â”€â”€ Liquor / Bar KOT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function buildLiquorKOT(
  orderData: OrderData,
): object[] {
  const { tableNumber, orderId, items, kotId, sectionName } = orderData;
  const liquorItems = items.filter((i) => i.type === "liquor");

  if (liquorItems.length === 0) return [];

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

  // Parse KOT number
  const displayKotId = kotId || "N/A";

  const cmds: string[] = [
    INIT,
    CENTER,
    BOLD_ON,
    "BAR ORDER\n",
    BOLD_OFF,
    LEFT,
    separator("-"),
    SIZE_HEIGHT,
    BOLD_ON,
    `KOT No : ${displayKotId}\n`,
    `Table  : ${(tableNumber || 'N/A').toString().replace(/^[BT]/i, '')}\n`,
    BOLD_OFF,
    SIZE_NORMAL,
    separator("-"),
    "Waiter : Waiter\n",
    `Ordered Date : ${dateStr}  Time : ${timeStr}\n`,
    separator("-"),
    BOLD_ON,
    "Qty  Item\n",
    BOLD_OFF,
    separator("-"),
  ];

  for (const item of liquorItems) {
    const line = `${item.quantity}  ${item.name.toUpperCase()}`;
    cmds.push(
      SIZE_2X,
      BOLD_ON,
      line + "\n",
      BOLD_OFF,
      SIZE_NORMAL,
      "\n"
    );
  }

  cmds.push(
    separator("-"),
    `Hall Name : ${sectionName || 'BAR AC HALL'}\n`,
    "\n\n\n",
    CUT
  );

  return [{ type: "raw", format: "plain", data: cmds.join("") }];
}

// â”€â”€â”€ Full Receipt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function buildReceipt(
  orderData: OrderData,
): object[] {
  const { tableNumber, orderId, items, restaurantName = "V GRAND LOUNGE", txnNumber, txnDate, captainName } = orderData;
  const { date, time } = formatNow();

  const foodItems    = items.filter((i) => i.type === "food");
  const liquorItems  = items.filter((i) => i.type === "liquor");

  const foodSubtotal    = foodItems.reduce((s, i) => s + Number(i.price ?? 0) * i.quantity, 0);
  const liquorSubtotal  = liquorItems.reduce((s, i) => s + Number(i.price ?? 0) * i.quantity, 0);
  const cgst  = Math.round(foodSubtotal * 0.025 * 100) / 100;
  const sgst  = Math.round(foodSubtotal * 0.025 * 100) / 100;
  const total = Math.round((foodSubtotal + liquorSubtotal + cgst + sgst) * 100) / 100;

  const fmt = (n: number) => `Rs.${n.toFixed(2)}`;

  const cmds: string[] = [
    "\x1B\x40",         // init
    "\x1D!\x11",       // 2x width+height
    "\x1B\x61\x01",    // center
    "\x1B\x45\x01",    // bold on
    `${restaurantName}\n`,
    "\x1B\x45\x00",    // bold off
    "\x1D!\x00",       // back to normal size
    "\x1B\x61\x00",    // left
    separator("="),
    `Table: ${tableNumber}\n`,
    `Bill #: ${formatBillNumber(txnDate, txnNumber) || orderId.slice(-6).toUpperCase()}\n`,
    `Date : ${date}\n`,
    `Time : ${time}\n`,
  ];

  if (captainName) {
    cmds.push(`Captain: ${captainName}\n`);
  }

  cmds.push(
    separator("="),
    "\n"
  );

  if (foodItems.length > 0) {
    cmds.push(
      "\x1D!\x11",       // 2x size for section header
      "\x1B\x45\x01",    // bold on
      "FOOD\n",
      "\x1B\x45\x00",    // bold off
      "\x1D!\x00",       // back to normal size
      "\n"
    );
    for (const item of foodItems) {
      cmds.push(
        "\x1D!\x11",     // 2x size for item name
        "\x1B\x45\x01",  // bold on
        formatItemLine(`${item.quantity}x ${item.name}`, fmt(Number(item.price ?? 0) * item.quantity)),
        "\x1B\x45\x00",  // bold off
        "\x1D!\x00"      // back to normal size
      );
      if (item.notes) cmds.push(`   * ${item.notes}\n`);
    }
    cmds.push("\n");
  }

  if (liquorItems.length > 0) {
    cmds.push(
      "\x1D!\x11",       // 2x size for section header
      "\x1B\x45\x01",    // bold on
      "LIQUOR\n",
      "\x1B\x45\x00",    // bold off
      "\x1D!\x00",       // back to normal size
      "\n"
    );
    for (const item of liquorItems) {
      cmds.push(
        "\x1D!\x11",     // 2x size for item name
        "\x1B\x45\x01",  // bold on
        formatItemLine(`${item.quantity}x ${item.name}`, fmt(Number(item.price ?? 0) * item.quantity)),
        "\x1B\x45\x00",  // bold off
        "\x1D!\x00"      // back to normal size
      );
      if (item.notes) cmds.push(`   * ${item.notes}\n`);
    }
    cmds.push("\n");
  }

  cmds.push(separator("="));
  if (foodItems.length > 0) cmds.push("\x1B\x45\x01", formatItemLine("Food Subtotal", fmt(foodSubtotal)), "\x1B\x45\x00");
  if (liquorItems.length > 0) cmds.push("\x1B\x45\x01", formatItemLine("Liquor Subtotal", fmt(liquorSubtotal)), "\x1B\x45\x00");
  if (cgst > 0) cmds.push("\x1B\x45\x01", formatItemLine("CGST (2.5%)", fmt(cgst)), "\x1B\x45\x00");
  if (sgst > 0) cmds.push("\x1B\x45\x01", formatItemLine("SGST (2.5%)", fmt(sgst)), "\x1B\x45\x00");

  cmds.push(
    separator("="),
    "\x1B\x45\x01",    // bold on
    formatItemLine("TOTAL", fmt(total)),
    "\x1B\x45\x00",    // bold off
    separator("="),
    "\x1B\x61\x01",    // center
    "Thank you for dining with us!\n",
    "Please visit again.\n",
    "\x1B\x61\x00",    // left
    "\n\n\n",
    "\x1D\x56\x42\x00",
  );

  return [{ type: "raw", format: "plain", data: cmds.join("") }];
}

// ─── Final Bill (Separate from Settlement) ────────────────────────────────────

export function buildFinalBill(data: BillData): object[] {
  const cmds: string[] = [];

  // Initialize printer
  cmds.push(INIT);

  // Header - Restaurant Name (centered, 2x size with bold)
  cmds.push(CENTER);
  cmds.push(SIZE_2X);
  cmds.push(BOLD_ON);
  cmds.push('V GRAND LOUNGE\n');
  cmds.push(BOLD_OFF);
  cmds.push(SIZE_NORMAL);

  // Address lines (centered, normal size)
  cmds.push(CENTER);
  cmds.push('Opp:TDP Office,Guntur Road,\n');
  cmds.push('Ongole-523001,Cell:8074829846,9866011278\n');
  cmds.push('GST IN:37AEXPT1195E1ZU\n');
  cmds.push(LEFT);
  cmds.push(separator("-"));

  // Extract numeric table number (remove B or T prefix)
  const tableNumeric = (data.tableNumber || 'N/A').toString().replace(/^[BT]/i, '');

  // Transaction info
  cmds.push(BOLD_ON);
  cmds.push(`Table: ${tableNumeric}\n`);
  cmds.push(BOLD_OFF);
  cmds.push(`Date: ${data.date || 'N/A'}    Time: ${data.time || 'N/A'}\n`);
  cmds.push(`Bill No : ${data.billNumber || 'N/A'}\n`);

  // KOT numbers — only print if they exist
  if (data.kotNumbers && data.kotNumbers.length > 0) {
    cmds.push(`KOT No : ${data.kotNumbers.join(', ')}\n`);
  }

  // Captain — only print if captain is set and not N/A
  if (data.captain && data.captain !== 'N/A') {
    cmds.push(`Captain: ${data.captain}\n`);
  }
  cmds.push(separator("-"));

  // Item header
  cmds.push('Item            Qty    Price    Amount\n');
  cmds.push(separator("-"));

  // Items
  if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
    cmds.push('NO ITEMS\n');
  } else {
    data.items.forEach(item => {
      cmds.push(BOLD_ON);
      cmds.push(`${item.name.toUpperCase()}\n`);
      cmds.push(BOLD_OFF);
      const qty = String(item.quantity).padStart(4);
      const price = String(item.price.toFixed(2)).padStart(9);
      const amount = String(item.amount.toFixed(2)).padStart(10);
      cmds.push(BOLD_ON);
      // Pad left space to align under Qty (approx 14 spaces)
      cmds.push(`              ${qty}  ${price}  ${amount}\n`);
      cmds.push(BOLD_OFF);
    });
  }

  cmds.push(separator("-"));

  // Sub Total (before discount)
  cmds.push(BOLD_ON);
  cmds.push(`Sub Total :${String(data.subtotal.toFixed(2)).padStart(LINE_NORMAL - 12)}\n`);
  cmds.push(BOLD_OFF);

  // Discount — always print if discount exists and percent > 0
  if (data.discount && data.discount.percent > 0) {
    cmds.push(BOLD_ON);
    cmds.push(`(-) Discount ${data.discount.percent.toFixed(2)}% :${String(data.discount.amount.toFixed(2)).padStart(LINE_NORMAL - 22)}\n`);
    cmds.push(BOLD_OFF);
    // Total after discount (before tax and rounding)
    const afterDiscount = data.subtotal - data.discount.amount;
    cmds.push(BOLD_ON);
    cmds.push(`Total :${String(afterDiscount.toFixed(2)).padStart(LINE_NORMAL - 8)}\n`);
    cmds.push(BOLD_OFF);
  }

  // Tax breakdown (only if tax.total > 0)
  if (data.tax && data.tax.total > 0) {
    cmds.push(BOLD_ON);
    cmds.push(`CGST 2.5% :${String(data.tax.cgst.toFixed(2)).padStart(LINE_NORMAL - 12)}\n`);
    cmds.push(`SGST 2.5% :${String(data.tax.sgst.toFixed(2)).padStart(LINE_NORMAL - 12)}\n`);
    cmds.push(BOLD_OFF);
  }

  // Round off: difference between grandTotal and exact calculated total
  const exactTotal = data.grandTotal;
  const roundedTotal = Math.round(exactTotal);
  const roundOff = roundedTotal - exactTotal;
  if (Math.abs(roundOff) > 0.001) {
    cmds.push(BOLD_ON);
    cmds.push(`Round Off :${String((roundOff >= 0 ? '+' : '') + roundOff.toFixed(2)).padStart(LINE_NORMAL - 12)}\n`);
    cmds.push(BOLD_OFF);
  }

  cmds.push(separator("-"));

  // Grand Total — label left, amount right-aligned to match the Amount column
  cmds.push(SIZE_HEIGHT);
  cmds.push(BOLD_ON);
  const gtLabel = 'Grand Total';
  const gtValue = roundedTotal.toFixed(2);
  const gtGap = Math.max(1, LINE_NORMAL - gtLabel.length - gtValue.length);
  cmds.push(gtLabel + ' '.repeat(gtGap) + gtValue + '\n');
  cmds.push(BOLD_OFF);
  cmds.push(SIZE_NORMAL);

  cmds.push(separator("-"));
  cmds.push('Hall : BAR AC HALL\n');
  cmds.push('(Rounded Off to NearestRupees)\n');
  cmds.push(CENTER);
  cmds.push('Thank You, Please Visit again\n');
  cmds.push('Powered by Softshape.ai\n');
  cmds.push('\n\n\n');
  cmds.push(CUT);

  return [{
    type: 'raw',
    format: 'plain',
    data: cmds.join('')
  }];
}
