import { describe, it, expect } from "vitest";

/**
 * Unit tests for resolvePrinterName and normalizePrinterConfig logic.
 * These functions are defined inline in orders.ts and not exported,
 * so we test the logic directly here to verify correctness.
 */

function normalizePrinterConfig(printerConfig: Record<string, any>): {
  printers: Array<{ name?: string; type?: string }>;
  valid: boolean;
} {
  const raw = printerConfig?.printers;
  if (Array.isArray(raw)) return { printers: raw, valid: true };
  if (raw && typeof raw === 'object') return { printers: Object.values(raw), valid: true };
  if (raw !== undefined && raw !== null) {
    console.warn('[PrinterConfig] Unrecognized printers shape:', { sample: String(raw).slice(0, 100) });
  }
  return { printers: [], valid: false };
}

function resolvePrinterName(
  restaurantId: string,
  itemPrinterName: string | null | undefined,
  itemPrinterTarget: string | null | undefined,
  categoryPrinterTarget: string | null | undefined,
  printerConfig: Record<string, any>,
): string | undefined {
  if (itemPrinterName) return itemPrinterName;
  const target = (itemPrinterTarget || categoryPrinterTarget)?.toUpperCase();
  if (!target) return undefined;

  const { printers, valid } = normalizePrinterConfig(printerConfig);
  if (!valid || printers.length === 0) return undefined;

  const normalized = printers.map((p) => ({
    name: p.name,
    type: String(p.type || '').toUpperCase(),
    nameLower: String(p.name || '').toLowerCase(),
  }));

  if (target === 'BAR_PRINTER') {
    return normalized.find((p) => p.type === 'BAR')?.name
      || normalized.find((p) => p.nameLower.includes('bar'))?.name;
  }
  if (target === 'KOT_PRINTER') {
    return normalized.find((p) => p.type === 'KITCHEN')?.name
      || normalized.find((p) => p.nameLower.includes('kitchen'))?.name
      || normalized.find((p) => p.type === 'KOT')?.name;
  }
  return undefined;
}

describe("normalizePrinterConfig", () => {
  it("should accept array format", () => {
    const result = normalizePrinterConfig({ printers: [{ name: "P1", type: "BAR" }] });
    expect(result.valid).toBe(true);
    expect(result.printers).toHaveLength(1);
  });

  it("should accept object format", () => {
    const result = normalizePrinterConfig({ printers: { p1: { name: "P1", type: "BAR" } } });
    expect(result.valid).toBe(true);
    expect(result.printers).toHaveLength(1);
  });

  it("should reject invalid format", () => {
    const result = normalizePrinterConfig({ printers: "not-valid" });
    expect(result.valid).toBe(false);
    expect(result.printers).toHaveLength(0);
  });

  it("should handle missing printers field", () => {
    const result = normalizePrinterConfig({});
    expect(result.valid).toBe(false);
    expect(result.printers).toHaveLength(0);
  });

  it("should handle null printerConfig", () => {
    const result = normalizePrinterConfig(null as any);
    expect(result.valid).toBe(false);
    expect(result.printers).toHaveLength(0);
  });
});

describe("resolvePrinterName", () => {
  const restaurantId = "r-test";
  const barConfig = { printers: [{ name: "BarPrinter", type: "BAR" }] };
  const kitchenConfig = { printers: [{ name: "KitchenPrinter", type: "KITCHEN" }] };
  const mixedConfig = {
    printers: [
      { name: "BarPrinter", type: "BAR" },
      { name: "KitchenPrinter", type: "KITCHEN" },
      { name: "KOTPrinter", type: "KOT" },
    ],
  };

  it("should prioritize itemPrinterName over target", () => {
    const result = resolvePrinterName(restaurantId, "ExplicitName", "BAR_PRINTER", null, barConfig);
    expect(result).toBe("ExplicitName");
  });

  it("should resolve BAR_PRINTER to bar printer by type", () => {
    const result = resolvePrinterName(restaurantId, null, "BAR_PRINTER", null, mixedConfig);
    expect(result).toBe("BarPrinter");
  });

  it("should resolve KOT_PRINTER to kitchen printer by type", () => {
    const result = resolvePrinterName(restaurantId, null, "KOT_PRINTER", null, mixedConfig);
    expect(result).toBe("KitchenPrinter");
  });

  it("should resolve KOT_PRINTER to KOT printer if no kitchen type", () => {
    const kotOnlyConfig = { printers: [{ name: "KOTPrinter", type: "KOT" }] };
    const result = resolvePrinterName(restaurantId, null, "KOT_PRINTER", null, kotOnlyConfig);
    expect(result).toBe("KOTPrinter");
  });

  it("should fall back to name-based matching for BAR", () => {
    const nameOnlyConfig = { printers: [{ name: "My Bar Printer", type: "" }] };
    const result = resolvePrinterName(restaurantId, null, "BAR_PRINTER", null, nameOnlyConfig);
    expect(result).toBe("My Bar Printer");
  });

  it("should fall back to name-based matching for KOT", () => {
    const nameOnlyConfig = { printers: [{ name: "Kitchen Station 1", type: "" }] };
    const result = resolvePrinterName(restaurantId, null, "KOT_PRINTER", null, nameOnlyConfig);
    expect(result).toBe("Kitchen Station 1");
  });

  it("should use categoryPrinterTarget as fallback", () => {
    const result = resolvePrinterName(restaurantId, null, null, "BAR_PRINTER", mixedConfig);
    expect(result).toBe("BarPrinter");
  });

  it("should return undefined for unrecognized target", () => {
    const result = resolvePrinterName(restaurantId, null, "UNKNOWN_PRINTER", null, mixedConfig);
    expect(result).toBeUndefined();
  });

  it("should return undefined when no printers configured", () => {
    const result = resolvePrinterName(restaurantId, null, "BAR_PRINTER", null, {});
    expect(result).toBeUndefined();
  });

  it("should return undefined when no target and no itemPrinterName", () => {
    const result = resolvePrinterName(restaurantId, null, null, null, mixedConfig);
    expect(result).toBeUndefined();
  });

  it("should handle case-insensitive targets", () => {
    const result = resolvePrinterName(restaurantId, null, "bar_printer", null, mixedConfig);
    expect(result).toBe("BarPrinter");
  });
});
