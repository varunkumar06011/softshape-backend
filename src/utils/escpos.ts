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
}

export interface BillData {
  billNumber: string;        // "30/05/26-042"
  date: string;              // "30/05/2026"
  time: string;              // "12:30 PM"
  kotNumber: string;         // "KOT-01"
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

function separator(ch = "-"): string {
  return ch.repeat(LINE_WIDTH) + "\n";
}

function formatBillNumber(txnDate?: string, txnNumber?: number): string {
  if (!txnDate || !txnNumber) return '';
  // "YYYY-MM-DD" → "DD/MM/YY-XXX"
  const [year, month, day] = txnDate.split('-');
  const yymmdd = `${day}/${month}/${year.slice(2)}`;
  const seqPart = String(txnNumber).padStart(3, '0');
  return `${yymmdd}-${seqPart}`;
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
  const { tableNumber, orderId, items, kotNumber, kotId } = orderData;
  const foodItems = items.filter((i) => i.type === "food");

  if (foodItems.length === 0) return [];

  const { time } = formatNow();

  // Parse KOT number with format validation
  let displayKotNumber = "N/A";
  if (kotId) {
    // Validate format: must be "KOT-XX" or convert to format
    displayKotNumber = kotId.startsWith('KOT-')
      ? kotId
      : `KOT-${String(kotId).padStart(2, '0')}`;
  } else if (kotNumber) {
    displayKotNumber = `KOT-${String(kotNumber).padStart(2, '0')}`;
  }

  // Determine if this is a bar order (table starts with "B") or kitchen order (table starts with "T")
  const isBarTable = String(tableNumber).toUpperCase().startsWith('B');
  const orderType = isBarTable ? "BAR ORDER" : "KITCHEN ORDER";

  const cmds: string[] = [
    "\x1B\x40",         // init
    "\x1D!\x11",       // 2x width+height
    "\x1B\x61\x01",    // center
    "\x1B\x45\x01",    // bold on
    `${orderType}\n`,
    "\x1B\x45\x00",    // bold off
    "\x1D!\x00",       // back to normal size
    "\x1B\x61\x00",    // left
    separator("="),
    `Table: ${tableNumber}\n`,
    `Time: ${time}\n`,
    "\x1D!\x11",       // 2x size for KOT number
    "\x1B\x45\x01",    // bold on
    `KOT: ${displayKotNumber}\n`,
    "\x1B\x45\x00",    // bold off
    "\x1D!\x00",       // back to normal size
    separator("="),
    "\n",
  ];

  for (const item of foodItems) {
    cmds.push(
      "\x1D!\x11",       // 2x size for item name
      "\x1B\x45\x01",    // bold on
      ` ${item.quantity}x  ${item.name}\n`,
      "\x1B\x45\x00",    // bold off
      "\x1D!\x00"        // back to normal size
    );
    if (item.notes) cmds.push(`   * ${item.notes}\n`);
    cmds.push("\n");
  }

  cmds.push(separator("="), "\n\n\n", "\x1D\x56\x42\x00");

  return [{ type: "raw", format: "plain", data: cmds.join("") }];
}

// â”€â”€â”€ Liquor / Bar KOT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function buildLiquorKOT(
  orderData: OrderData,
): object[] {
  const { tableNumber, orderId, items, kotNumber, kotId } = orderData;
  const liquorItems = items.filter((i) => i.type === "liquor");

  if (liquorItems.length === 0) return [];

  const { time } = formatNow();

  // Parse KOT number with format validation
  let displayKotNumber = "N/A";
  if (kotId) {
    // Validate format: must be "KOT-XX" or convert to format
    displayKotNumber = kotId.startsWith('KOT-')
      ? kotId
      : `KOT-${String(kotId).padStart(2, '0')}`;
  } else if (kotNumber) {
    displayKotNumber = `KOT-${String(kotNumber).padStart(2, '0')}`;
  }

  // Liquor KOTs always show "BAR ORDER" regardless of table prefix
  // (Both bar tables "B" and restaurant tables "T" send liquor orders to the bar)
  const orderType = "BAR ORDER";

  const cmds: string[] = [
    "\x1B\x40",         // init
    "\x1D!\x11",       // 2x width+height
    "\x1B\x61\x01",    // center
    "\x1B\x45\x01",    // bold on
    `${orderType}\n`,
    "\x1B\x45\x00",    // bold off
    "\x1D!\x00",       // back to normal size
    "\x1B\x61\x00",    // left
    separator("="),
    `Table: ${tableNumber}\n`,
    `Time: ${time}\n`,
    "\x1D!\x11",       // 2x size for KOT number
    "\x1B\x45\x01",    // bold on
    `KOT: ${displayKotNumber}\n`,
    "\x1B\x45\x00",    // bold off
    "\x1D!\x00",       // back to normal size
    separator("="),
    "\n",
  ];

  for (const item of liquorItems) {
    cmds.push(
      "\x1D!\x11",       // 2x size for item name
      "\x1B\x45\x01",    // bold on
      ` ${item.quantity}x  ${item.name}\n`,
      "\x1B\x45\x00",    // bold off
      "\x1D!\x00"        // back to normal size
    );
    if (item.notes) cmds.push(`   * ${item.notes}\n`);
    cmds.push("\n");
  }

  cmds.push(separator("="), "\n\n\n", "\x1D\x56\x42\x00");

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
  const ESC = '\x1B';
  const GS = '\x1D';

  let receipt = '';

  // Initialize printer
  receipt += ESC + '@';
  receipt += GS + '!\x11';   // 2x width+height

  // Header - Restaurant Name (centered, 2x size with bold)
  receipt += ESC + 'a\x01';  // Center
  receipt += ESC + 'E\x01';  // Bold on
  receipt += 'V GRAND LOUNGE\n';
  receipt += ESC + 'E\x00';  // Bold off
  receipt += GS + '!\x00';   // Back to normal size

  // Contact numbers (centered, normal size)
  receipt += '9988776655, 9988776644\n';
  receipt += 'GSTIN: 37XXXXX1234X1Z5\n';
  receipt += '=====================\n';

  // Extract numeric table number (remove B or T prefix)
  const tableNumeric = (data.tableNumber || 'N/A').toString().replace(/^[BT]/i, '');

  // Transaction info (left-aligned, normal size)
  receipt += ESC + 'a\x00';  // Left align
  receipt += `Bill: ${(data.billNumber || 'N/A')}\n`;
  receipt += `Table: ${tableNumeric}\n`;
  receipt += `Date: ${(data.date || 'N/A')}\n`;
  receipt += `Time: ${data.time || 'N/A'}\n`;
  receipt += `KOT: ${(data.kotNumber || 'N/A')}\n`;
  receipt += `Captain: ${data.captain || 'N/A'}\n`;
  receipt += '=====================\n';

  // Item header
  receipt += 'Item       Qty Price Amt\n';
  receipt += '---------------------\n';

  // Items - item name in 2x size + bold
  // Safety check: ensure items array exists and is not empty
  if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
    receipt += 'NO ITEMS\n';
  } else {
    data.items.forEach(item => {
    const name = item.name.length > 11 ? item.name.substring(0, 11) : item.name.padEnd(11);
    const qty = String(item.quantity).padStart(3);
    const price = String(item.price).padStart(5);
    const amount = String(item.amount).padStart(6);

    // 2x size + Bold ON for item name
    receipt += GS + '!\x11';
    receipt += ESC + 'E\x01';
    receipt += name;
    receipt += ESC + 'E\x00';  // Bold OFF
    receipt += GS + '!\x00';   // Back to normal size
    receipt += `${qty}${price}${amount}\n`;
  });
  }

  receipt += '---------------------\n';

  // Subtotal (normal size with bold)
  receipt += ESC + 'E\x01';  // Bold on
  receipt += `Sub Total:${String(data.subtotal.toFixed(2)).padStart(11)}\n`;
  receipt += ESC + 'E\x00';  // Bold off

  // Discount (if applicable, normal size with bold)
  if (data.discount) {
    receipt += ESC + 'E\x01';  // Bold on
    receipt += `(-) Discount ${data.discount.percent.toFixed(2)}%:\n`;
    receipt += `${String(data.discount.amount.toFixed(2)).padStart(21)}\n`;
    receipt += ESC + 'E\x00';  // Bold off
  }

  // Tax breakdown (normal size with bold)
  receipt += ESC + 'E\x01';  // Bold on
  receipt += `CGST 2.5%:${String(data.tax.cgst.toFixed(2)).padStart(11)}\n`;
  receipt += `SGST 2.5%:${String(data.tax.sgst.toFixed(2)).padStart(11)}\n`;
  receipt += ESC + 'E\x00';  // Bold off
  receipt += '---------------------\n';

  // Grand Total (normal size with bold)
  receipt += ESC + 'E\x01';  // Bold on
  receipt += `Total:${String(data.grandTotal.toFixed(2)).padStart(15)}\n`;
  receipt += ESC + 'E\x00';  // Bold off
  receipt += '=====================\n';

  // Footer
  receipt += ESC + 'a\x00';  // Left align
  receipt += `Items / Qty: ${data.itemCount} / ${data.qtyCount}\n`;
  receipt += '(Rounded Off to Nearest Rupees)\n';
  receipt += '**\n';
  receipt += `${data.section}\n`;
  receipt += ESC + 'a\x01';  // Center
  receipt += 'Thank You, Please Visit again\n';

  // Cut paper
  receipt += GS + 'V\x00';

  return [{
    type: 'raw',
    format: 'plain',
    data: receipt
  }];
}
