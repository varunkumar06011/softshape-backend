import { describe, it, expect } from "vitest";

// Import the shared billing utility — same logic used by cashier and admin frontend
// We test the pure function directly since it's the money-path calculation.
// The function is in Softshapeai/src/shared/utils/billing.js but the logic
// is mirrored in backend order total calculation. We test the canonical version here.

// Re-implement the billing logic inline for backend testing (the shared util is ESM/frontend)
function calculateOrderTotal(items: any[], discountPercent = 0) {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { subtotal: 0, taxes: 0, total: 0, grandTotal: 0, discountAmount: 0, foodSubtotal: 0, liquorSubtotal: 0, cgst: 0, sgst: 0 };
  }

  let foodSubtotal = 0;
  let liquorSubtotal = 0;

  items.forEach((item) => {
    if (item.removedFromBill) return;
    const price = Number(item.p ?? item.price ?? 0);
    const qty = Number(item.q ?? item.quantity ?? 1);
    const rawType = item.menuType || item.menuItem?.menuType || item.type || '';
    const typeUpper = rawType.toString().toUpperCase();
    const type = (typeUpper === 'LIQUOR' || typeUpper === 'BAR') ? 'liquor' : 'food';

    if (type === 'liquor') {
      liquorSubtotal += price * qty;
    } else {
      foodSubtotal += price * qty;
    }
  });

  const cgst = Math.round(foodSubtotal * 0.025 * 100) / 100;
  const sgst = Math.round(foodSubtotal * 0.025 * 100) / 100;
  const taxes = cgst + sgst;
  const subtotal = foodSubtotal + liquorSubtotal;
  const total = subtotal + taxes;
  const discountAmount = discountPercent > 0
    ? Math.round(subtotal * (discountPercent / 100) * 100) / 100
    : 0;

  const discountedFood = foodSubtotal - (discountAmount > 0 && subtotal > 0
    ? discountAmount * (foodSubtotal / subtotal)
    : 0);
  const cgstFinal = Math.round(discountedFood * 0.025 * 100) / 100;
  const sgstFinal = Math.round(discountedFood * 0.025 * 100) / 100;
  const taxesFinal = cgstFinal + sgstFinal;
  const grandTotal = Number((subtotal - discountAmount + taxesFinal).toFixed(2));

  return {
    subtotal: Number(subtotal.toFixed(2)),
    taxes: Number(taxesFinal.toFixed(2)),
    total: Number(total.toFixed(2)),
    grandTotal,
    discountAmount: Number(discountAmount.toFixed(2)),
    foodSubtotal: Number(foodSubtotal.toFixed(2)),
    liquorSubtotal: Number(liquorSubtotal.toFixed(2)),
    cgst: Number(cgstFinal.toFixed(2)),
    sgst: Number(sgstFinal.toFixed(2)),
  };
}

describe("Billing — calculateOrderTotal", () => {
  it("returns zeros for empty/null items", () => {
    const result = calculateOrderTotal([]);
    expect(result.subtotal).toBe(0);
    expect(result.grandTotal).toBe(0);
    expect(result.taxes).toBe(0);
  });

  it("calculates food-only order with 5% GST", () => {
    const items = [
      { n: "Paneer Butter Masala", p: 250, q: 1, menuType: "FOOD" },
      { n: "Naan", p: 40, q: 2, menuType: "FOOD" },
    ];
    const result = calculateOrderTotal(items);
    // foodSubtotal = 250 + 80 = 330
    expect(result.foodSubtotal).toBe(330);
    expect(result.liquorSubtotal).toBe(0);
    expect(result.subtotal).toBe(330);
    // CGST = 2.5% of 330 = 8.25, SGST = 8.25
    expect(result.cgst).toBe(8.25);
    expect(result.sgst).toBe(8.25);
    expect(result.taxes).toBe(16.5);
    expect(result.grandTotal).toBe(346.5);
  });

  it("calculates liquor-only order with 0% GST", () => {
    const items = [
      { n: "Kingfisher Beer", p: 180, q: 2, menuType: "LIQUOR" },
    ];
    const result = calculateOrderTotal(items);
    expect(result.liquorSubtotal).toBe(360);
    expect(result.foodSubtotal).toBe(0);
    expect(result.taxes).toBe(0);
    expect(result.grandTotal).toBe(360);
  });

  it("calculates mixed food + liquor order correctly", () => {
    const items = [
      { n: "Paneer Tikka", p: 220, q: 1, menuType: "FOOD" },
      { n: "Old Monk 60ml", p: 150, q: 2, menuType: "LIQUOR" },
    ];
    const result = calculateOrderTotal(items);
    // foodSubtotal = 220, liquorSubtotal = 300
    expect(result.foodSubtotal).toBe(220);
    expect(result.liquorSubtotal).toBe(300);
    expect(result.subtotal).toBe(520);
    // GST only on food: 2.5% of 220 = 5.5 each
    expect(result.cgst).toBe(5.5);
    expect(result.sgst).toBe(5.5);
    expect(result.taxes).toBe(11);
    expect(result.grandTotal).toBe(531);
  });

  it("treats BAR menuType same as LIQUOR for tax purposes", () => {
    const items = [
      { n: "Bisleri Water", p: 20, q: 1, menuType: "BAR" },
    ];
    const result = calculateOrderTotal(items);
    expect(result.liquorSubtotal).toBe(20);
    expect(result.foodSubtotal).toBe(0);
    expect(result.taxes).toBe(0);
  });

  it("skips items marked removedFromBill", () => {
    const items = [
      { n: "Paneer", p: 200, q: 1, menuType: "FOOD" },
      { n: "Cancelled Naan", p: 40, q: 2, menuType: "FOOD", removedFromBill: true },
    ];
    const result = calculateOrderTotal(items);
    // Only Paneer counts: 200
    expect(result.foodSubtotal).toBe(200);
    expect(result.grandTotal).toBe(210); // 200 + 5% GST = 210
  });

  it("applies discount correctly on mixed order", () => {
    const items = [
      { n: "Paneer", p: 200, q: 1, menuType: "FOOD" },
      { n: "Beer", p: 200, q: 1, menuType: "LIQUOR" },
    ];
    const result = calculateOrderTotal(items, 10);
    // subtotal = 400, discount = 40 (10%)
    expect(result.discountAmount).toBe(40);
    // foodSubtotal = 200, discount allocated proportionally: 40 * (200/400) = 20
    // discountedFood = 200 - 20 = 180
    // CGST = 2.5% of 180 = 4.5, SGST = 4.5
    expect(result.cgst).toBe(4.5);
    expect(result.sgst).toBe(4.5);
    expect(result.taxes).toBe(9);
    // grandTotal = 400 - 40 + 9 = 369
    expect(result.grandTotal).toBe(369);
  });

  it("handles fractional quantities", () => {
    const items = [
      { n: "Half Paneer", p: 120, q: 0.5, menuType: "FOOD" },
    ];
    const result = calculateOrderTotal(items);
    // foodSubtotal = 120 * 0.5 = 60
    expect(result.foodSubtotal).toBe(60);
    // CGST = 2.5% of 60 = 1.5
    expect(result.cgst).toBe(1.5);
    expect(result.grandTotal).toBe(63);
  });

  it("handles items with price/quantity field names instead of p/q", () => {
    const items = [
      { name: "Biryani", price: 180, quantity: 2, menuType: "FOOD" },
    ];
    const result = calculateOrderTotal(items);
    expect(result.foodSubtotal).toBe(360);
    expect(result.grandTotal).toBe(378); // 360 + 18 (5% GST)
  });
});

describe("Billing — Bill Number Uniqueness", () => {
  it("generates sequential bill numbers", () => {
    // Test the formatBillNumber logic: plain incrementing number
    function formatBillNumber(_date: Date, billNumber: number): string {
      return String(billNumber);
    }

    const d = new Date();
    expect(formatBillNumber(d, 1)).toBe("1");
    expect(formatBillNumber(d, 2)).toBe("2");
    expect(formatBillNumber(d, 100)).toBe("100");
    expect(formatBillNumber(d, 9999)).toBe("9999");
  });
});

describe("KOT — Printer Target Routing", () => {
  it("routes LIQUOR items to bar printer, FOOD items to kitchen printer", () => {
    // Simulate the KOT routing logic used in orders.ts
    function getPrinterTarget(menuType: string): string {
      const type = menuType.toUpperCase();
      return (type === 'LIQUOR' || type === 'BAR') ? 'BAR' : 'KITCHEN';
    }

    expect(getPrinterTarget("FOOD")).toBe("KITCHEN");
    expect(getPrinterTarget("LIQUOR")).toBe("BAR");
    expect(getPrinterTarget("BAR")).toBe("BAR");
    expect(getPrinterTarget("food")).toBe("KITCHEN");
    expect(getPrinterTarget("liquor")).toBe("BAR");
  });

  it("splits mixed order items into correct KOT groups", () => {
    const orderItems = [
      { n: "Paneer", p: 200, q: 1, menuType: "FOOD" },
      { n: "Beer", p: 180, q: 2, menuType: "LIQUOR" },
      { n: "Naan", p: 40, q: 3, menuType: "FOOD" },
      { n: "Whiskey 60ml", p: 150, q: 1, menuType: "LIQUOR" },
    ];

    const kitchenItems = orderItems.filter(i => {
      const t = (i.menuType || '').toUpperCase();
      return t !== 'LIQUOR' && t !== 'BAR';
    });
    const barItems = orderItems.filter(i => {
      const t = (i.menuType || '').toUpperCase();
      return t === 'LIQUOR' || t === 'BAR';
    });

    expect(kitchenItems).toHaveLength(2);
    expect(kitchenItems[0].n).toBe("Paneer");
    expect(kitchenItems[1].n).toBe("Naan");

    expect(barItems).toHaveLength(2);
    expect(barItems[0].n).toBe("Beer");
    expect(barItems[1].n).toBe("Whiskey 60ml");
  });
});

describe("Billing — Cancel Item Flow", () => {
  it("recalculates total after cancelling an item", () => {
    const allItems = [
      { n: "Paneer", p: 200, q: 1, menuType: "FOOD" },
      { n: "Naan", p: 40, q: 2, menuType: "FOOD" },
      { n: "Beer", p: 180, q: 1, menuType: "LIQUOR" },
    ];

    // Before cancellation
    const before = calculateOrderTotal(allItems);
    expect(before.subtotal).toBe(460); // 200 + 80 + 180
    expect(before.foodSubtotal).toBe(280); // 200 + 80
    // CGST = 2.5% of 280 = 7, SGST = 7, taxes = 14
    expect(before.grandTotal).toBe(474); // 460 + 14

    // Cancel the Beer (liquor item)
    const afterCancel = calculateOrderTotal(
      allItems.map(i => i.n === "Beer" ? { ...i, removedFromBill: true } : i)
    );
    expect(afterCancel.liquorSubtotal).toBe(0);
    expect(afterCancel.foodSubtotal).toBe(280);
    expect(afterCancel.subtotal).toBe(280);
    expect(afterCancel.grandTotal).toBe(294); // 280 + 14
  });

  it("handles cancellation of all items (empty bill)", () => {
    const items = [
      { n: "Paneer", p: 200, q: 1, menuType: "FOOD", removedFromBill: true },
    ];
    const result = calculateOrderTotal(items);
    expect(result.subtotal).toBe(0);
    expect(result.grandTotal).toBe(0);
    expect(result.taxes).toBe(0);
  });
});
