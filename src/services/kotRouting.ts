// ─────────────────────────────────────────────────────────────────────────────
// kotRouting.ts — Shared KOT grouping and emission logic (R3 thin proxy)
// ─────────────────────────────────────────────────────────────────────────────
// Consolidates the 4 parallel KOT routing code paths into a single canonical
// function used by all cloud call sites (createOrder, updateOrderItems,
// bill-edit, reprint). The edge server has its own equivalent in outputPlanner.ts.
//
// R3: No longer imports ESC/POS builders directly. Uses the shared package's
// render() function from @softshape/output. The grouping logic stays the same
// but rendering is delegated to the shared renderer registry.
//
// Grouping strategy:
//   1. Items WITH a resolved printerName → group by printerName (precise routing)
//   2. Items WITHOUT a resolved printerName → legacy fallback by menuType
//      (BAR_PRINTER or LIQUOR → bar, else → kitchen)
// ─────────────────────────────────────────────────────────────────────────────

import { render } from "@softshape/output";
import type { OutputIntentType } from "@softshape/output";
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
}

/**
 * Group items by printer name (or legacy menuType fallback) and emit KOT print jobs.
 * This is the SINGLE canonical KOT routing function for all cloud paths.
 *
 * @param restaurantId - The restaurant/outlet ID for socket emission
 * @param mappedItems - Items with resolved printerName and printerTarget
 * @param kotOrderData - KOT order data for ESC/POS building
 * @param basePayload - Base payload for socket emission
 * @returns Promise that resolves when all emit calls are dispatched
 */
export async function groupAndEmitKotPrintJobs(
  restaurantId: string,
  mappedItems: KotItem[],
  kotOrderData: KotOrderData,
  basePayload: KotBasePayload,
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
        const rendered = render("PRINT_KOT", { ...kotOrderData, items: kitchenPrintItems } as any);
        emitPromises.push(
          emitToRestaurant(restaurantId, "print_job", {
            type: "KOT",
            data: {
              ...basePayload,
              items: kitchenItems,
              escposData: rendered?.blocks ?? [],
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
        const rendered = render("PRINT_LIQUOR_KOT", { ...kotOrderData, items: counterPrintItems } as any);
        emitPromises.push(
          emitToRestaurant(restaurantId, "print_job", {
            type: "BAR_KOT",
            data: {
              ...basePayload,
              items: counterItems,
              escposData: rendered?.blocks ?? [],
            },
          }),
        );
      }
    } else {
      // PRECISE ROUTING: group by resolved printer name
      const isAllLiquor = groupItems.every((i) => i.menuType === "LIQUOR");
      const jobType = isAllLiquor ? "BAR_KOT" : "KOT";
      const renderIntent: OutputIntentType = isAllLiquor ? "PRINT_LIQUOR_KOT" : "PRINT_KOT";
      const printItems = groupItems.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        price: i.price,
        notes: i.notes ?? null,
        type: (i.menuType === "LIQUOR" ? "liquor" : "food") as "food" | "liquor",
      }));
      const rendered = render(renderIntent, { ...kotOrderData, items: printItems } as any);
      emitPromises.push(
        emitToRestaurant(restaurantId, "print_job", {
          type: jobType,
          data: {
            ...basePayload,
            printerName,
            items: groupItems,
            escposData: rendered?.blocks ?? [],
          },
        }),
      );
    }
  }

  Promise.all(emitPromises).catch((err) =>
    console.error("[kotRouting] Print emission failed:", err.message),
  );
}
