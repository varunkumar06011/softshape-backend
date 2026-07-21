// ─────────────────────────────────────────────────────────────────────────────
// kotRouting.ts — Shared KOT grouping and emission logic
// ─────────────────────────────────────────────────────────────────────────────
// Consolidates the 4 parallel KOT routing code paths into a single canonical
// function used by all cloud call sites (createOrder, updateOrderItems,
// bill-edit, reprint). The edge server has its own equivalent in printer.ts.
//
// Grouping strategy:
//   1. Items WITH a resolved printerName → group by printerName (precise routing)
//   2. Items WITHOUT a resolved printerName → legacy fallback by menuType
//      (BAR_PRINTER or LIQUOR → bar, else → kitchen)
// ─────────────────────────────────────────────────────────────────────────────

import { buildFoodKOT, buildLiquorKOT } from "../utils/escpos";
import { emitToRestaurant } from "./orderService";

export interface KotItem {
  name: string;
  quantity: number;
  price: number;
  notes?: string | null;
  menuType?: string;
  printerName?: string | null;
  printerTarget?: string | null;
}

export interface KotOrderData {
  tableNumber: string;
  orderId: string;
  items: Array<{ name: string; quantity: number; price: number; notes: string | null; type: "food" | "liquor" }>;
  restaurantName?: string;
  kotId: string;
  sectionName?: string;
  captainName?: string;
  sectionTag?: string;
}

export interface KotBasePayload {
  kotId: string;
  tableNumber: string;
  restaurantId: string;
  sectionTag?: string | null;
  sectionName?: string;
  captainName?: string;
  timestamp?: string;
  requestId?: string | null;
  localPrinted?: boolean;
}

/**
 * Group items by printer name (or legacy menuType fallback) and emit KOT print jobs.
 * This is the SINGLE canonical KOT routing function for all cloud paths.
 *
 * @param restaurantId - The restaurant/outlet ID for socket emission
 * @param mappedItems - Items with resolved printerName and printerTarget
 * @param kotOrderData - KOT order data for ESC/POS building
 * @param basePayload - Base payload for socket emission
 * @param eventIds - Optional array of event IDs for dedup
 * @returns Promise that resolves when all emit calls are dispatched
 */
export async function groupAndEmitKotPrintJobs(
  restaurantId: string,
  mappedItems: KotItem[],
  kotOrderData: KotOrderData,
  basePayload: KotBasePayload,
  eventIds?: string[],
): Promise<void> {
  const venueKotEnabled = true; // Caller should check venue KOT enabled before calling

  if (!venueKotEnabled || mappedItems.length === 0) return;

  // Group items by resolved printer name
  const groupedByPrinter = new Map<string | undefined, KotItem[]>();
  for (const item of mappedItems) {
    const key = item.printerName ?? undefined;
    if (!groupedByPrinter.has(key)) groupedByPrinter.set(key, []);
    groupedByPrinter.get(key)!.push(item);
  }

  // Build type→eventId lookup from captain-provided eventIds.
  // Captain generates IDs as `${requestId}-food` and `${requestId}-liquor`,
  // but print groups are ordered by Map iteration (printer grouping), not
  // food/liquor order. Positional matching by index causes mismatches.
  const eventIdByType: Record<string, string | undefined> = {};
  if (Array.isArray(eventIds)) {
    for (const id of eventIds) {
      if (!id) continue;
      if (id.endsWith("-food")) eventIdByType["KOT"] = id;
      else if (id.endsWith("-liquor")) eventIdByType["BAR_KOT"] = id;
      else if (id.endsWith("-bill")) eventIdByType["BILL"] = id;
      else if (id.endsWith("-cancel")) eventIdByType["CANCEL_KOT"] = id;
    }
  }

  const emitPromises: Promise<void>[] = [];
  for (const [printerName, groupItems] of groupedByPrinter) {
    if (!printerName) {
      // LEGACY FALLBACK: items with no resolved printer → split by menuType
      const counterItems = groupItems.filter(
        (i) => i.printerTarget === "BAR_PRINTER" || i.menuType === "LIQUOR",
      );
      const kitchenItems = groupItems.filter(
        (i) => i.printerTarget !== "BAR_PRINTER" && i.menuType !== "LIQUOR",
      );

      if (kitchenItems.length > 0) {
        const kitchenPrintItems = kitchenItems.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          price: i.price,
          notes: i.notes ?? null,
          type: "food" as const,
        }));
        emitPromises.push(
          emitToRestaurant(restaurantId, "print_job", {
            type: "KOT",
            eventId: eventIdByType["KOT"],
            data: {
              ...basePayload,
              items: kitchenItems,
              escposData: buildFoodKOT({ ...kotOrderData, items: kitchenPrintItems }),
            },
          }),
        );
      }
      if (counterItems.length > 0) {
        const counterPrintItems = counterItems.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          price: i.price,
          notes: i.notes ?? null,
          type: "liquor" as const,
        }));
        emitPromises.push(
          emitToRestaurant(restaurantId, "print_job", {
            type: "BAR_KOT",
            eventId: eventIdByType["BAR_KOT"],
            data: {
              ...basePayload,
              items: counterItems,
              escposData: buildLiquorKOT({ ...kotOrderData, items: counterPrintItems }),
            },
          }),
        );
      }
    } else {
      // PRECISE ROUTING: group by resolved printer name
      const isAllLiquor = groupItems.every((i) => i.menuType === "LIQUOR");
      const jobType = isAllLiquor ? "BAR_KOT" : "KOT";
      const builder = isAllLiquor ? buildLiquorKOT : buildFoodKOT;
      const printItems = groupItems.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        price: i.price,
        notes: i.notes ?? null,
        type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
      }));
      emitPromises.push(
        emitToRestaurant(restaurantId, "print_job", {
          type: jobType,
          eventId: eventIdByType[jobType],
          data: {
            ...basePayload,
            printerName,
            items: groupItems,
            escposData: builder({ ...kotOrderData, items: printItems }),
          },
        }),
      );
    }
  }

  Promise.all(emitPromises).catch((err) =>
    console.error("[kotRouting] Print emission failed:", err.message),
  );
}
