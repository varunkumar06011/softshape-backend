// ─────────────────────────────────────────────────────────────────────────────
// ESC/POS Builders — Thermal printer command generation for QZ Tray
// ─────────────────────────────────────────────────────────────────────────────
// Generates raw ESC/POS thermal printer commands for:
//   - Food KOT (Kitchen Order Ticket) — kitchen printer
//   - Liquor KOT — bar printer
//   - Receipts — bill with GST, discounts, payment details
//   - Table swap slips — printed when items are moved between tables
//
// All builders return a single-element array: [{ type: 'raw', format: 'plain', data: '...' }]
// NO image/logo/canvas/pixel blocks — raw text only.
// QZ Tray chokes on mixed pixel+raw arrays on most thermal drivers.
//
// ESC/POS commands used:
//   ESC @ — initialize printer
//   ESC ! — character style (bold, double width/height)
//   ESC a — alignment (left/center/right)
//   ESC d — cut paper
//   GS V — partial/full cut
//   LF — line feed
// ─────────────────────────────────────────────────────────────────────────────

/**

 * ESC/POS print data builders for QZ Tray.

 *

 * All builders return a single-element array containing one raw ESC/POS

 * command object { type: 'raw', format: 'plain', data: '...' }.

 *

 * NO image/logo/canvas/pixel blocks -- raw text only.

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



import { formatTxnDisplayId } from "./date";
import { getGstBreakdown, getEffectiveGstRate, getGstBreakdownWithRate } from "./gst";

// ─── ESC/POS Constants ───────────────────────────────────────────────────────

const INIT = '\x1B\x40';

const CENTER = '\x1B\x61\x01';

const LEFT = '\x1B\x61\x00';

const BOLD_ON = '\x1B\x45\x01';

const BOLD_OFF = '\x1B\x45\x00';

const SIZE_2X = '\x1D\x21\x11';
const SIZE_2X_TALL = '\x1D\x21\x12'; // 2x width, 3x height — taller for better readability

const SIZE_NORMAL = '\x1D\x21\x00';

const SIZE_HEIGHT = '\x1D\x21\x01';

const SIZE_ITEM_LARGE = '\x1D\x21\x02'; // 3x height, 1x width — 50% taller than SIZE_HEIGHT
const SIZE_4X = '\x1D\x21\x33'; // quad height + quad width
const SIZE_8X = '\x1D\x21\x77'; // 8x height + 8x width

const CUT = '\x1D\x56\x42\x00';

const FONT_A = '\x1B\x4D\x00';   // Epson Font A — default, standard width
const FONT_B = '\x1B\x4D\x01';   // Epson Font B — condensed/monospaced style



const LINE_NORMAL = 42;

const LINE_2X = 21;



// --- Types ---------------------------------------------------------------------



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

  orderByRole?: string;

  sectionName?: string;

  sectionTag?: string;

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

  section: string;           // e.g. "Conference Hall", "PDR", "Bar AC Hall", "Main Hall"

  sectionTag?: string;        // e.g. "venue-family-restaurant", "venue-restaurant-parcel"

  itemCount: number;

  qtyCount: number;

  gstIn?: string;            // venue-specific GST number (e.g. restaurant vs bar)

  restaurant?: BillPrintRestaurant;

}



// --- Helpers -------------------------------------------------------------------



const LINE_WIDTH = 21; // characters per line for 2x size (doubled from 42)





function separator(ch = "-"): string {

  return ch.repeat(LINE_NORMAL) + "\n";

}



function formatBillNumber(txnDate?: string, txnNumber?: number): string {

  return formatTxnDisplayId(txnDate, txnNumber);

}



function pad(str: string | number, len: number): string {

  return String(str).padEnd(len);

}



function padRight(left: string | number, right: string | number, width = LINE_NORMAL): string {

  const leftStr = String(left).slice(0, width - String(right).length - 1);

  return leftStr.padEnd(width - String(right).length) + right;

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



// --- Food KOT ------------------------------------------------------------------



export function buildFoodKOT(

  orderData: OrderData,

): object[] {

  const { tableNumber, orderId, items, kotId, sectionName, captainName, orderByRole, sectionTag } = orderData;

  const foodItems = items.filter((i) => i.type === "food");

  const roleLabel = orderByRole === 'CASHIER' ? 'Cashier' : orderByRole === 'ADMIN' ? 'Admin' : orderByRole === 'OWNER' ? 'Owner' : 'Captain';



  if (foodItems.length === 0) return [];



  const now = new Date();

  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');

  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });



  // Parse KOT number

  const displayKotId = kotId || "N/A";



  // For venue tables, use the already-formatted label as-is
  // For bar/restaurant, strip the B/T prefix to show just the number

  const rawTableLabel = (tableNumber || 'N/A').toString();

  const tableDisplay = (sectionTag && sectionTag.startsWith('venue-'))
    ? rawTableLabel
    : (/^[BT]\d+$/i.test(rawTableLabel) ? rawTableLabel.slice(1) : rawTableLabel);



  // Restaurant name for the header (matches onboarding KOT preview).
  const headerName = (orderData.restaurantName && orderData.restaurantName.trim())
    ? orderData.restaurantName.toUpperCase()
    : (sectionTag === 'venue-family-restaurant' || sectionTag === 'venue-restaurant-parcel'
        ? 'FAMILY RESTAURANT'
        : 'RESTAURANT');

  const cmds: string[] = [

    INIT,

    CENTER,

    BOLD_ON,

    `${headerName}\n`,

    BOLD_OFF,

  ];

  if (sectionName) {
    cmds.push(`${sectionName}\n`);
  }

  cmds.push(LEFT, separator("-"), BOLD_ON);



  // Table left, KOT No right on same line (matches preview)

  const tableLabel = `Table : ${tableDisplay}`;

  const kotLabel = `KOT No : ${displayKotId}`;

  const kotTableGap = Math.max(1, LINE_NORMAL - tableLabel.length - kotLabel.length);

  cmds.push(`${tableLabel}${' '.repeat(kotTableGap)}${kotLabel}\n`);

  cmds.push(BOLD_OFF);



  cmds.push(

    `${roleLabel} : ${captainName && captainName !== 'N/A' ? captainName : roleLabel}\n`,

    `Date : ${dateStr}  Time : ${timeStr}\n`,

    separator("-"),

    BOLD_ON,

    "Qty  Item\n",

    BOLD_OFF,

    separator("-"),

  );



  for (const item of foodItems) {

    cmds.push(

      SIZE_2X_TALL,

      BOLD_ON,

      `${item.quantity}  ${item.name.toUpperCase()}\n`,

      BOLD_OFF,

      SIZE_NORMAL

    );

    if (item.notes) {

      cmds.push(`     * ${item.notes}\n`);

    }

  }



  cmds.push(

    separator("-"),

    BOLD_ON,

    `Hall Name : ${sectionName || 'Family Restaurant'}\n`,

    BOLD_OFF,

    CENTER,

    "--- Kitchen Order Ticket ---\n",

    LEFT,

    "\n\n\n",

    CUT

  );



  return [{ type: "raw", format: "plain", data: cmds.join("") }];

}



// --- Liquor / Bar KOT ----------------------------------------------------------



export function buildLiquorKOT(

  orderData: OrderData,

): object[] {

  const { tableNumber, orderId, items, kotId, sectionName, captainName, orderByRole, sectionTag } = orderData;

  const liquorItems = items.filter((i) => i.type === "liquor");

  const roleLabel = orderByRole === 'CASHIER' ? 'Cashier' : orderByRole === 'ADMIN' ? 'Admin' : orderByRole === 'OWNER' ? 'Owner' : 'Captain';



  if (liquorItems.length === 0) return [];



  const now = new Date();

  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');

  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });



  // Parse KOT number

  const displayKotId = kotId || "N/A";



  // For venue tables, use the already-formatted label as-is
  // For bar/restaurant, strip the B/T prefix to show just the number

  const rawTableLabel = (tableNumber || 'N/A').toString();

  const tableDisplay = (sectionTag && sectionTag.startsWith('venue-'))
    ? rawTableLabel
    : (/^[BT]\d+$/i.test(rawTableLabel) ? rawTableLabel.slice(1) : rawTableLabel);



  // Restaurant name for the header (matches onboarding KOT preview).
  const headerName = (orderData.restaurantName && orderData.restaurantName.trim())
    ? orderData.restaurantName.toUpperCase()
    : (sectionTag === 'venue-family-restaurant' || sectionTag === 'venue-restaurant-parcel'
        ? 'FAMILY RESTAURANT'
        : 'RESTAURANT');

  const sectionLabel = sectionName || (sectionTag === 'venue-family-restaurant' || sectionTag === 'venue-restaurant-parcel'
    ? 'COUNTER ORDER'
    : 'BAR ORDER');

  const cmds: string[] = [

    INIT,

    CENTER,

    BOLD_ON,

    `${headerName}\n`,

    BOLD_OFF,

  ];

  if (sectionLabel) {
    cmds.push(`${sectionLabel}\n`);
  }

  cmds.push(LEFT, separator("-"), BOLD_ON);



  // Table left, KOT No right on same line (matches preview)
  const tableLabel = `Table : ${tableDisplay}`;
  const kotLabel = `KOT No : ${displayKotId}`;
  const kotTableGap = Math.max(1, LINE_NORMAL - tableLabel.length - kotLabel.length);
  cmds.push(`${tableLabel}${' '.repeat(kotTableGap)}${kotLabel}\n`);
  cmds.push(BOLD_OFF);



  cmds.push(

    separator("-"),

    `${roleLabel} : ${captainName && captainName !== 'N/A' ? captainName : roleLabel}\n`,

    `Date : ${dateStr}  Time : ${timeStr}\n`,

    separator("-"),

    BOLD_ON,

    "Qty  Item\n",

    BOLD_OFF,

    separator("-"),

  );



  for (const item of liquorItems) {

    cmds.push(

      SIZE_2X_TALL,

      BOLD_ON,

      `${item.quantity}  ${item.name.toUpperCase()}\n`,

      BOLD_OFF,

      SIZE_NORMAL

    );

    if (item.notes) {

      cmds.push(`     * ${item.notes}\n`);

    }

  }



  cmds.push(

    separator("-"),

    BOLD_ON,

    `Hall Name : ${sectionName || 'N/A'}\n`,

    BOLD_OFF,

    CENTER,

    "--- Bar Order Ticket ---\n",

    LEFT,

    "\n\n\n",

    CUT

  );



  return [{ type: "raw", format: "plain", data: cmds.join("") }];

}



// --- Full Receipt --------------------------------------------------------------



export function buildReceipt(

  orderData: OrderData,
  tax: { cgst: number; sgst: number; total: number },

): object[] {

  const { tableNumber, orderId, items, restaurantName, txnNumber, txnDate, captainName, sectionTag } = orderData;

  const resolvedRestaurantName = restaurantName || (

    sectionTag === 'venue-family-restaurant' || sectionTag === 'venue-restaurant-parcel'

      ? 'FAMILY RESTAURANT'

      : 'RESTAURANT'

  );

  const { date, time } = formatNow();



  const foodItems    = items.filter((i) => i.type === "food");

  const liquorItems  = items.filter((i) => i.type === "liquor");



  const foodSubtotal    = foodItems.reduce((s, i) => s + Number(i.price ?? 0) * i.quantity, 0);

  const liquorSubtotal  = liquorItems.reduce((s, i) => s + Number(i.price ?? 0) * i.quantity, 0);

  const cgst = tax.cgst;
  const sgst = tax.sgst;
  const total = Math.round((foodSubtotal + liquorSubtotal + tax.total) * 100) / 100;



  const fmt = (n: number) => `Rs.${n.toFixed(2)}`;



  const cmds: string[] = [

    "\x1B\x40",         // init

    "\x1B\x61\x01",    // center

    "\x1B\x45\x01",    // bold on

    "\x1D!\x11",       // 2x width+height

    `${resolvedRestaurantName}\n`,

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

      "\x1B\x61\x00",    // left align

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

      "\x1B\x61\x00",    // left align

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

  if (cgst > 0) cmds.push("\x1B\x45\x01", formatItemLine("CGST", fmt(cgst)), "\x1B\x45\x00");

  if (sgst > 0) cmds.push("\x1B\x45\x01", formatItemLine("SGST", fmt(sgst)), "\x1B\x45\x00");



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



  // Header - Restaurant Name (centered, double height with bold)
  // Use restaurant data from onboarding (receiptHeader or name), fall back to sectionTag-based default
  const venueName = ((data as any).restaurant?.receiptHeader?.trim() || (data as any).restaurant?.name?.trim() || 'RESTAURANT').toUpperCase();

  cmds.push(CENTER);

  cmds.push(BOLD_ON);

  cmds.push(SIZE_HEIGHT);

  cmds.push(`${venueName}\n`);

  cmds.push(BOLD_OFF);

  cmds.push(SIZE_NORMAL);



  // Address lines (centered, normal size) — from onboarding data, not hardcoded
  const restaurantInfo = (data as any).restaurant;

  cmds.push(CENTER);

  if (restaurantInfo?.receiptSubHeader) {
    cmds.push(`${restaurantInfo.receiptSubHeader}\n`);
  }

  if (restaurantInfo?.address) {
    cmds.push(`${restaurantInfo.address}\n`);
  }

  if (restaurantInfo?.phone) {
    cmds.push(`Phone: ${restaurantInfo.phone}\n`);
  }

  if (data.gstIn) {

    cmds.push(`GST IN: ${data.gstIn}\n`);

  }

  cmds.push(separator("-"));



  // For venue tables, use the already-formatted label as-is
  // For bar/restaurant, strip the B/T prefix to show just the number

  const rawTable = (data.tableNumber || 'N/A').toString();
  const tableNumeric = (data.sectionTag && data.sectionTag.startsWith('venue-'))
    ? rawTable
    : rawTable.replace(/^[BT]/i, '');



  // Transaction info - Bill No and Table on same line

  cmds.push(SIZE_HEIGHT);

  cmds.push(BOLD_ON);

  const billNo = data.billNumber || 'N/A';

  const billTableGap = Math.max(1, LINE_NORMAL - `Bill No : ${billNo}`.length - `Table: ${tableNumeric}`.length);

  cmds.push(`Bill No : ${billNo}${' '.repeat(billTableGap)}Table: ${tableNumeric}\n`);

  cmds.push(BOLD_OFF);

  cmds.push(SIZE_NORMAL);

  cmds.push(`Date: ${data.date || 'N/A'}\n`);



  // KOT numbers — only print if they exist

  if (data.kotNumbers && data.kotNumbers.length > 0) {

    cmds.push(`KOT No : ${data.kotNumbers.join(', ')}\n`);

  }



  cmds.push(`Time: ${data.time || 'N/A'}\n`);



  // Captain and Waiter — only print if captain is set and not N/A

  if (data.captain && data.captain !== 'N/A') {

    const captainGap = Math.max(1, LINE_NORMAL - `Captain: ${data.captain}`.length - `Waiter: Waiter`.length);

    cmds.push(`Captain: ${data.captain}${' '.repeat(captainGap)}Waiter: Waiter\n`);

  }

  cmds.push(separator("-"));



  // Item header

  cmds.push(LEFT);

  cmds.push('Item            Qty    Price    Amount\n');

  cmds.push(separator("-"));



  // Items

  if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {

    cmds.push('NO ITEMS\n');

  } else {

    data.items.forEach(item => {

      cmds.push(BOLD_ON);

      const itemName = item.name.toUpperCase().substring(0, 24);

      cmds.push(`${itemName}\n`);

      cmds.push(BOLD_OFF);

      const qty = String(item.quantity).padStart(4);

      const price = String(item.price.toFixed(2)).padStart(9);

      const amount = String(item.amount.toFixed(2)).padStart(10);

      cmds.push(BOLD_ON);

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

    cmds.push(`CGST :${String(data.tax.cgst.toFixed(2)).padStart(LINE_NORMAL - 7)}\n`);

    cmds.push(`SGST :${String(data.tax.sgst.toFixed(2)).padStart(LINE_NORMAL - 7)}\n`);

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



  // Items / Qty count

  cmds.push(BOLD_ON);

  cmds.push(`Items / Qty : ${data.itemCount || 0}/${data.qtyCount || 0}\n`);

  cmds.push(BOLD_OFF);



  const secTag = (data.sectionTag || '').toLowerCase();

  const secName = (data.section || '').toLowerCase();

  const hallName = (secTag === 'venue-family-restaurant' || secName.includes('family restaurant') || secName.includes('main hall'))

    ? 'DINE IN'

    : (secTag === 'venue-restaurant-parcel' || secName.includes('parcel'))

        ? 'PARCEL(FAMILY RESTAURANT)'

        : (data.section ? data.section.toUpperCase() : 'DINE IN');

  cmds.push(separator("-"));

  cmds.push(`Hall : ${hallName}\n`);

  cmds.push('(Rounded Off to NearestRupees)\n');

  cmds.push('* *\n');

  cmds.push('\n');

  cmds.push(BOLD_ON);

  cmds.push(hallName);

  cmds.push(BOLD_OFF);

  cmds.push('\n');

  cmds.push(CENTER);

  cmds.push('Thank You, Please Visit again\n');

  cmds.push('\n\n\n');

  cmds.push(CUT);



  return [{

    type: 'raw',

    format: 'plain',

    data: cmds.join('')

  }];

}



// --- BILL / CANCEL / TABLE SWAP builders (used by the print agent path) -------



export interface BillPrintRestaurant {

  name?: string;

  receiptHeader?: string | null;

  receiptSubHeader?: string | null;

  address?: string | null;

  phone?: string | null;

  gstin?: string | null;

}



export interface BillPrintInput {

  tableNumber: string | number;

  items: Array<{ name: string; quantity: number; price: number; menuType?: "FOOD" | "LIQUOR" }>;

  totalAmount: number;

  restaurant?: BillPrintRestaurant;

  sectionTag?: string | null;

  gstCategory?: string | null;

  gstRate?: number | null;

  gstRegistered?: boolean;

  pricesIncludeGst?: boolean;

}



export function buildBill(input: BillPrintInput): object[] {

  const { tableNumber, items, totalAmount, restaurant, sectionTag } = input;

  const receiptHeader = restaurant?.receiptHeader || restaurant?.name || 'RESTAURANT';

  const secTag = (sectionTag || '').toLowerCase();

  const venueLabel = secTag === 'venue-family-restaurant' || secTag === 'venue-restaurant-parcel'

    ? receiptHeader

    : (secTag.startsWith('venue-bar-') ? 'BAR ORDER' : receiptHeader);



  const cmds: string[] = [

    INIT,

    CENTER,

    BOLD_ON,

    `${venueLabel}\n`,

    BOLD_OFF,

    SIZE_NORMAL,

  ];



  if (restaurant?.receiptSubHeader) cmds.push(CENTER, `${restaurant.receiptSubHeader}\n`);

  if (restaurant?.address) cmds.push(CENTER, `${restaurant.address}\n`);

  if (restaurant?.phone) cmds.push(CENTER, `Phone: ${restaurant.phone}\n`);

  if (restaurant?.gstin) cmds.push(CENTER, `GSTIN: ${restaurant.gstin}\n`);



  cmds.push(

    SIZE_2X,

    BOLD_ON,

    'BILL RECEIPT\n',

    BOLD_OFF,

    SIZE_NORMAL,

    separator(),

    LEFT,

    `Table : ${tableNumber}\n`,

    `Date  : ${new Date().toLocaleString('en-IN')}\n`,

    separator(),

    BOLD_ON,

    pad('ITEM', 24) + pad('QTY', 6) + 'AMT'.padStart(12) + '\n',

    BOLD_OFF,

    separator(),

  );



  (items || []).forEach((item) => {

    const name = String(item.name || '').slice(0, 24);

    const qty = String(item.quantity || 1);

    const amt = 'Rs.' + ((item.price || 0) * (item.quantity || 1)).toFixed(0);

    cmds.push(pad(name, 24) + pad(qty, 6) + amt.padStart(12) + '\n');

  });



  const foodSubtotal = items
    .filter((i) => i.menuType === 'FOOD')
    .reduce((s, i) => s + Number(i.price || 0) * (i.quantity || 1), 0);
  const liquorSubtotal = items
    .filter((i) => i.menuType !== 'FOOD')
    .reduce((s, i) => s + Number(i.price || 0) * (i.quantity || 1), 0);
  const effectiveRate = getEffectiveGstRate(input.gstRate, input.gstCategory, input.gstRegistered);
  const { cgst, sgst, tax, baseAmount } = getGstBreakdownWithRate(foodSubtotal, effectiveRate, !!input.pricesIncludeGst);
  const displayedSubtotal = Math.round((baseAmount + liquorSubtotal) * 100) / 100;
  const total = Math.round((displayedSubtotal + tax) * 100) / 100;

  cmds.push(

    separator(),

    padRight('Subtotal', 'Rs.' + displayedSubtotal.toFixed(0)) + '\n',

    padRight('GST', 'Rs.' + tax.toFixed(0)) + '\n',

    separator('='),

    BOLD_ON,

    padRight('TOTAL', 'Rs.' + total.toFixed(0)) + '\n',

    BOLD_OFF,

    separator(),

    CENTER,

    'Thank you! Visit again.\n',

    '\n',

    `Powered by ${restaurant?.name || 'Softshape'}\n`,

    '\n\n\n',

    CUT,

  );



  return [{ type: 'raw', format: 'plain', data: cmds.join('') }];

}



export interface CancelKotItem {

  name: string;

  quantity: number;

  menuType?: string;

}



export interface CancelKotPrintInput {

  tableNumber: string | number;

  cancelledBy: string;

  timestamp: string;

  items: CancelKotItem[];

  sectionName?: string;

  sectionTag?: string | null;

  restaurant?: BillPrintRestaurant;

}



export function buildCancelKOT(input: CancelKotPrintInput): object[] {

  const { tableNumber, cancelledBy, timestamp, items, sectionName, sectionTag, restaurant } = input;

  const timeStr = new Date(timestamp || Date.now()).toLocaleTimeString('en-IN', {

    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,

  });



  const receiptHeader = restaurant?.receiptHeader || restaurant?.name || 'RESTAURANT';

  const secTag = (sectionTag || '').toLowerCase();

  const isVenue = secTag.startsWith('venue-');

  const headerName = (receiptHeader && receiptHeader.trim())
    ? receiptHeader.toUpperCase()
    : (secTag === 'venue-family-restaurant' || secTag === 'venue-restaurant-parcel'
        ? 'FAMILY RESTAURANT'
        : 'RESTAURANT');



  const rawTable = (tableNumber || 'N/A').toString();

  const tableDisplay = isVenue

    ? rawTable

    : (/^[BT]\d+$/i.test(rawTable) ? rawTable.slice(1) : rawTable);



  const hallName = secTag === 'venue-family-restaurant'

    ? 'DINE IN'

    : (secTag === 'venue-restaurant-parcel'

      ? 'OWNER(FAMILY RESTAURANT)'

      : (sectionName ? sectionName.toUpperCase() : 'N/A'));



  const allItems = (items || []).filter((i) => i);

  const isSingle = allItems.length <= 1;

  const firstItem = allItems[0];

  const itemType = firstItem?.menuType === 'BAR' ? 'Bar Item' : 'Food Item';



  const cmds: string[] = [

    INIT,

    CENTER,

    BOLD_ON,

    `${headerName}\n`,

    BOLD_OFF,

    `CANCEL ORDER\n`,

    separator('-'),

    `Table : ${tableDisplay}\n`,

    `Time  : ${timeStr}\n`,

    `By    : ${cancelledBy || 'Staff'}\n`,

    separator('-'),

  ];



  if (isSingle) {

    if (firstItem) {

      const itemLine = `${firstItem.quantity}    ${firstItem.name.toUpperCase()}  CANCELLED`;

      cmds.push(

        LEFT,

        FONT_A,

        SIZE_HEIGHT,

        BOLD_ON,

        itemLine + '\n',

        BOLD_OFF,

        SIZE_NORMAL,

        `Type  : ${itemType}\n`

      );

    }

  } else {

    cmds.push(

      SIZE_HEIGHT,

      BOLD_ON,

      "Qty  Item\n",

      BOLD_OFF,

      SIZE_NORMAL,

      separator('-'),

    );

    allItems.forEach((item) => {

      const itemLine = `${item.quantity}    ${item.name.toUpperCase()}  CANCELLED`;

      cmds.push(

        LEFT,

        FONT_A,

        SIZE_HEIGHT,

        BOLD_ON,

        itemLine + '\n',

        BOLD_OFF,

        SIZE_NORMAL,

      );

    });

  }



  cmds.push(

    separator('-'),

    CENTER,

    `Hall Name : ${hallName}\n`,

    separator('-'),

    CENTER,

    "--- Cancel Order Ticket ---\n",

    LEFT,

    separator('-'),

    SIZE_2X_TALL,

    BOLD_ON,

    '** CANCELLED **\n',

    BOLD_OFF,

    SIZE_NORMAL,

    '\n\n\n',

    CUT,

  );



  return [{ type: 'raw', format: 'plain', data: cmds.join('') }];

}



export interface TableSwapPrintInput {

  fromTableNumber: string | number;

  toTableNumber: string | number;

  swappedBy: string;

  timestamp: string;

}



export function buildTableSwap(input: TableSwapPrintInput): object[] {

  const { fromTableNumber, toTableNumber, swappedBy, timestamp } = input;

  const cmds: string[] = [

    INIT,

    SIZE_2X,

    CENTER,

    BOLD_ON,

    'TABLE MOVED\n',

    BOLD_OFF,

    separator(),

    LEFT,

    `From  : Table ${fromTableNumber}\n`,

    `To    : Table ${toTableNumber}\n`,

    `By    : ${swappedBy || 'Staff'}\n`,

    `Time  : ${new Date(timestamp || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}\n`,

    separator(),

    CENTER,

    BOLD_ON,

    'Session transferred\n',

    BOLD_OFF,

    '\n\n',

    CUT,

  ];



  return [{ type: 'raw', format: 'plain', data: cmds.join('') }];

}

