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
import { emitToRestaurant, loadPrinterConfig, resolvePrinterName } from "./orderService";
import prisma from "../lib/prisma";

/**
 * Look up venue kotEnabled flag from a tableId via table → section → venue chain.
 * Returns true (default) if venue not found or kotEnabled is null.
 */
export async function getVenueKotEnabled(tableId: string | null | undefined, restaurantId?: string): Promise<boolean> {
  if (!tableId) return true;
  const table = await prisma.table.findUnique({
    where: { id: tableId },
    select: {
      restaurantId: true,
      section: {
        select: {
          venue: {
            select: { kotEnabled: true },
          },
        },
      },
    },
  });
  if (!table) return true;
  if (restaurantId && table.restaurantId !== restaurantId) {
    return true;
  }
  const kotEnabled = table?.section?.venue?.kotEnabled;
  return kotEnabled !== false;
}

export interface KotItem {
  name: string;
  quantity: number;
  price: number;
  notes?: string | null;
  menuType?: string;
  printerName?: string | null;
  printerTarget?: string | null;
  category?: string | null;
  // Combo-explosion metadata (optional — set by call sites that build mappedItems
  // from MenuItem rows). When isCombo === true, groupAndEmitKotPrintJobs will
  // explode this single line into one KotItem per ComboComponent, routed to each
  // component's own printer. The combo itself never reaches a kitchen printer.
  menuItemId?: string;
  isCombo?: boolean;
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
/**
 * Explode combo line items into one KotItem per ComboComponent.
 *
 * A combo is billed as a single OrderItem at its own price, but for KOT printing
 * each component must be sent to its own correct printer (kitchen vs bar) using
 * the component's name/menuType/printerTarget/printerName. The combo's own
 * printerTarget is irrelevant for KOT routing — only its components' targets
 * matter. Non-combo items pass through unchanged.
 *
 * Quantity math: each component KotItem gets `component.quantity * orderItem.quantity`.
 * Price on exploded KOT lines is 0 (the bill line already carries the combo's
 * price; KOT tickets are not price-bearing for combos).
 */
async function explodeCombos(
  restaurantId: string,
  mappedItems: KotItem[],
): Promise<KotItem[]> {
  const comboItems = mappedItems.filter((i) => i.isCombo && i.menuItemId);
  if (comboItems.length === 0) return mappedItems;

  const comboMenuItemIds = Array.from(new Set(comboItems.map((i) => i.menuItemId!)));
  // Fetch all components for the combos in this batch, plus each component's
  // MenuItem (for name/menuType/printerTarget/printerName) and category (for
  // legacy printerTarget fallback).
  const components = await prisma.comboComponent.findMany({
    where: { comboMenuItemId: { in: comboMenuItemIds }, restaurantId },
    include: {
      componentMenuItem: {
        select: {
          id: true,
          name: true,
          menuType: true,
          printerTarget: true,
          printerName: true,
          isAvailable: true,
          isDeleted: true,
          category: { select: { name: true, printerTarget: true } },
        },
      },
    },
  });

  const componentsByCombo = new Map<string, typeof components>();
  for (const c of components) {
    const arr = componentsByCombo.get(c.comboMenuItemId) ?? [];
    arr.push(c);
    componentsByCombo.set(c.comboMenuItemId, arr);
  }

  const printerConfig = await loadPrinterConfig(restaurantId);

  const result: KotItem[] = [];
  for (const item of mappedItems) {
    if (!item.isCombo || !item.menuItemId) {
      result.push(item);
      continue;
    }
    const comps = componentsByCombo.get(item.menuItemId) ?? [];
    if (comps.length === 0) {
      // No components recorded (data inconsistency) — fall back to printing the
      // combo as a single line so the kitchen at least sees something.
      result.push(item);
      continue;
    }
    for (const comp of comps) {
      const cm = comp.componentMenuItem;
      // Skip components that have been deleted or marked unavailable — they
      // should not produce KOT tickets (matches integrity-check expectations).
      if (!cm || cm.isDeleted || !cm.isAvailable) continue;
      const catPrinterTarget = cm.category?.printerTarget || null;
      const resolvedPrinterName = resolvePrinterName(
        restaurantId,
        cm.printerName,
        cm.printerTarget,
        catPrinterTarget,
        printerConfig,
      );
      result.push({
        name: cm.name,
        quantity: comp.quantity * item.quantity,
        price: 0,
        notes: item.notes ?? null,
        menuType: cm.menuType as string | undefined,
        category: cm.category?.name,
        printerTarget: cm.printerTarget || catPrinterTarget,
        printerName: resolvedPrinterName,
      });
    }
  }
  return result;
}

export async function groupAndEmitKotPrintJobs(
  restaurantId: string,
  mappedItems: KotItem[],
  kotOrderData: KotOrderData,
  basePayload: KotBasePayload,
  venueKotEnabled: boolean = true,
): Promise<void> {
  if (!venueKotEnabled || mappedItems.length === 0) return;

  // Explode combos into per-component KOT lines before grouping/routing.
  const items = await explodeCombos(restaurantId, mappedItems);
  if (items.length === 0) return;

  // Group items by resolved printer name
  const groupedByPrinter = new Map<string | undefined, KotItem[]>();
  for (const item of items) {
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
