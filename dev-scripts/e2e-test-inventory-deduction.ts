// ─────────────────────────────────────────────────────────────────────────────
// E2E Test: Bar + Kitchen Inventory Deduction
// ─────────────────────────────────────────────────────────────────────────────
// Mimics the edge server / API by directly calling deductInventoryForOrder()
// inside a Prisma transaction, exactly as orderService.settleOrder does.
//
// Test flow:
//   1. Pick a restaurant that has both bar inventory and kitchen recipes
//   2. Capture stock BEFORE for all relevant inventory items
//   3. Create a test PAID order with LIQUOR + FOOD items
//   4. Call deductInventoryForOrder() inside a transaction
//   5. Capture stock AFTER and verify deductions
//   6. Test idempotency — call again, verify no double-deduction
//   7. Clean up: reverse stock changes, delete test order
//
// Usage: npx tsx dev-scripts/e2e-test-inventory-deduction.ts
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '../src/lib/prisma';
import { Prisma } from '@prisma/client';
import { deductInventoryForOrder } from '../src/services/inventoryService';

// ANSI colors for terminal output
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

let passCount = 0;
let failCount = 0;
const testResults: { name: string; pass: boolean; detail: string }[] = [];

function assert(name: string, condition: boolean, detail: string) {
  const status = condition ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
  console.log(`  [${status}] ${name}`);
  if (!condition) console.log(`         ${C.red}${detail}${C.reset}`);
  testResults.push({ name, pass: condition, detail });
  if (condition) passCount++;
  else failCount++;
}

function header(title: string) {
  console.log(`\n${C.bold}${C.cyan}═══ ${title} ═══${C.reset}`);
}

// ── Main test ────────────────────────────────────────────────────────────────
async function main() {
  header('E2E Inventory Deduction Test');

  // ── Step 1: Find a suitable restaurant ─────────────────────────────────────
  header('Step 1: Find a restaurant with bar + kitchen inventory');

  // Find a restaurant that has both bar inventory items and kitchen recipes
  // Prefer restaurants with dual-variant pairs for full test coverage
  const restaurants = await prisma.outlet.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  // Move restaurants with dual-variant pairs to the front
  const restaurantsWithDual: typeof restaurants = [];
  const restaurantsWithoutDual: typeof restaurants = [];
  for (const r of restaurants) {
    const barInv = await prisma.inventoryItem.findMany({
      where: { restaurantId: r.id },
      include: { menuItem: { select: { name: true } } },
    });
    const invByName = new Map<string, any>();
    for (const inv of barInv) {
      const name = (inv.menuItem?.name || '').toLowerCase().trim();
      if (name) invByName.set(name, inv);
    }
    let hasDual = false;
    for (const [name] of invByName.entries()) {
      const m750 = name.match(/^(.+)\s+750ml$/);
      if (m750 && invByName.has(`${m750[1]} 180ml`)) { hasDual = true; break; }
    }
    if (hasDual) restaurantsWithDual.push(r);
    else restaurantsWithoutDual.push(r);
  }
  const sortedRestaurants = [...restaurantsWithDual, ...restaurantsWithoutDual];

  let testRestaurant: { id: string; name: string } | null = null;
  let testLiquorMenuItem: any = null;
  let testFoodMenuItem: any = null;
  let testBarInventory: any = null;
  let testDualVariantPair: { inv750: any; inv180: any; baseName: string } | null = null;

  for (const r of sortedRestaurants) {
    // Find a liquor menu item with variants (so we can test ml-per-unit)
    const liquorItems = await prisma.menuItem.findMany({
      where: { restaurantId: r.id, menuType: 'LIQUOR', isDeleted: false },
      include: { variants: true },
      take: 50,
    });
    if (liquorItems.length === 0) continue;

    // Find bar inventory items for this restaurant
    const barInv = await prisma.inventoryItem.findMany({
      where: { restaurantId: r.id },
      include: { menuItem: { include: { variants: true } } },
    });
    if (barInv.length === 0) continue;

    // Find a food menu item that has a recipe
    const foodWithRecipe = await prisma.menuItemRecipe.findFirst({
      where: { restaurantId: r.id },
      include: { menuItem: true, ingredient: true },
    });
    if (!foodWithRecipe) continue;

    // Find a dual-variant pair (750ml + 180ml)
    const invByName = new Map<string, any>();
    for (const inv of barInv) {
      const name = (inv.menuItem?.name || '').toLowerCase().trim();
      if (name) invByName.set(name, inv);
    }

    let dualPair: { inv750: any; inv180: any; baseName: string } | null = null;
    for (const [name, inv] of invByName.entries()) {
      const m750 = name.match(/^(.+)\s+750ml$/);
      if (m750) {
        const base = m750[1];
        const inv180 = invByName.get(`${base} 180ml`);
        if (inv180) {
          dualPair = { inv750: inv, inv180, baseName: base };
          break;
        }
      }
    }

    // Pick a liquor item that matches an inventory item by name
    // Priority: dual-variant match > exact match > suffix-stripped match
    let matchedLiquor = null;
    let matchedInv = null;

    // 1. If we have a dual-variant pair, find a liquor item matching the base name
    if (dualPair) {
      // Search specifically for liquor items matching the dual-variant base name
      const dualLiquorItems = await prisma.menuItem.findMany({
        where: {
          restaurantId: r.id,
          menuType: 'LIQUOR',
          isDeleted: false,
          name: { contains: dualPair.baseName, mode: 'insensitive' },
        },
        include: { variants: true },
        take: 10,
      });
      for (const li of dualLiquorItems) {
        const normalizedName = li.name.toLowerCase().trim();
        if (normalizedName === dualPair.baseName || normalizedName.startsWith(dualPair.baseName)) {
          matchedLiquor = li;
          matchedInv = dualPair.inv750;
          break;
        }
      }
    }

    // 2. If no dual-variant match, try exact name match
    if (!matchedLiquor) {
      for (const li of liquorItems) {
        const normalizedName = li.name.toLowerCase().trim();
        if (invByName.has(normalizedName)) {
          matchedLiquor = li;
          matchedInv = invByName.get(normalizedName);
          break;
        }
      }
    }

    // 3. If still no match, try suffix-stripped match
    if (!matchedLiquor) {
      for (const li of liquorItems) {
        const normalizedName = li.name.toLowerCase().trim();
        const stripped = normalizedName.replace(/\s+(30ml|60ml|90ml|180ml|375ml|750ml|full bottle|bottle)$/i, '').trim();
        if (stripped !== normalizedName && invByName.has(stripped)) {
          matchedLiquor = li;
          matchedInv = invByName.get(stripped);
          break;
        }
      }
    }

    if (!matchedLiquor || !matchedInv) {
      // Skip this restaurant — no matchable liquor item found
      continue;
    }

    // Get the food menu item from the recipe
    const foodMenuItem = foodWithRecipe.menuItem;
    if (!foodMenuItem || foodMenuItem.menuType !== 'FOOD') {
      // Find any food menu item with a recipe
      const foodItemWithRecipe = await prisma.menuItem.findFirst({
        where: { restaurantId: r.id, menuType: 'FOOD', isDeleted: false },
        include: {
          recipes: { include: { ingredient: true } },
        },
      });
      if (!foodItemWithRecipe || !foodItemWithRecipe.recipes || foodItemWithRecipe.recipes.length === 0) continue;
      testFoodMenuItem = foodItemWithRecipe;
    } else {
      // Reload with recipes
      testFoodMenuItem = await prisma.menuItem.findFirst({
        where: { id: foodMenuItem.id },
        include: { recipes: { include: { ingredient: true } } },
      });
    }

    if (!testFoodMenuItem || !testFoodMenuItem.recipes || testFoodMenuItem.recipes.length === 0) continue;

    testRestaurant = r;
    testLiquorMenuItem = matchedLiquor;
    testBarInventory = matchedInv;
    testDualVariantPair = dualPair;
    break;
  }

  if (!testRestaurant || !testLiquorMenuItem || !testFoodMenuItem) {
    console.error(`${C.red}❌ No suitable restaurant found with both bar and kitchen inventory.${C.reset}`);
    process.exit(1);
  }

  console.log(`  Restaurant: ${C.bold}${testRestaurant.name}${C.reset} (${testRestaurant.id})`);
  console.log(`  Liquor item: ${C.bold}${testLiquorMenuItem.name}${C.reset} (id: ${testLiquorMenuItem.id})`);
  console.log(`    Variants: ${testLiquorMenuItem.variants?.map((v: any) => `${v.name}=₹${v.price}`).join(', ') || 'none'}`);
  console.log(`  Food item: ${C.bold}${testFoodMenuItem.name}${C.reset} (id: ${testFoodMenuItem.id})`);
  console.log(`    Recipes: ${testFoodMenuItem.recipes.map((r: any) => `${r.ingredient.name}: ${r.quantity} ${r.ingredient.unit}`).join(', ')}`);
  if (testDualVariantPair) {
    console.log(`  ${C.yellow}Dual-variant pair detected:${C.reset} ${testDualVariantPair.baseName}`);
    console.log(`    750ml inv: ${testDualVariantPair.inv750.menuItem?.name} (stock: ${testDualVariantPair.inv750.currentStock}ml)`);
    console.log(`    180ml inv: ${testDualVariantPair.inv180.menuItem?.name} (stock: ${testDualVariantPair.inv180.currentStock}ml)`);
  } else {
    console.log(`  Bar inventory: ${testBarInventory.menuItem?.name} (stock: ${testBarInventory.currentStock}ml)`);
  }

  // ── Step 2: Determine test order items ──────────────────────────────────────
  header('Step 2: Prepare test order items');

  // For the liquor item, pick a variant price (or basePrice)
  const liquorPrice = testLiquorMenuItem.variants && testLiquorMenuItem.variants.length > 0
    ? Number(testLiquorMenuItem.variants[0].price)
    : Number(testLiquorMenuItem.basePrice);
  const liquorVariantName = testLiquorMenuItem.variants && testLiquorMenuItem.variants.length > 0
    ? testLiquorMenuItem.variants[0].name
    : 'default';
  const liquorQuantity = 2;

  // Compute expected ml-per-unit
  let expectedMlPerUnit: number;
  if (testDualVariantPair && testLiquorMenuItem.name.toLowerCase().includes(testDualVariantPair.baseName)) {
    // For dual-variant items, mlPerUnit comes from the variant name
    const parsedMl = parseInt(liquorVariantName.replace(/[^0-9]/g, ''), 10);
    expectedMlPerUnit = isNaN(parsedMl) || parsedMl <= 0 ? 750 : parsedMl;
  } else if (testLiquorMenuItem.variants && testLiquorMenuItem.variants.length > 0) {
    const matchedVariant = testLiquorMenuItem.variants.find((v: any) => Number(v.price) === liquorPrice);
    if (matchedVariant) {
      const parsedMl = parseInt(matchedVariant.name.replace(/[^0-9]/g, ''), 10);
      expectedMlPerUnit = isNaN(parsedMl) || parsedMl <= 0 ? 30 : parsedMl;
    } else {
      expectedMlPerUnit = 30;
    }
  } else {
    expectedMlPerUnit = Number(testBarInventory.bottleSize) || 750;
  }

  const expectedTotalMl = expectedMlPerUnit * liquorQuantity;
  console.log(`  Liquor: ${liquorQuantity}x ${testLiquorMenuItem.name} @ ₹${liquorPrice} (${liquorVariantName})`);
  console.log(`  Expected ml/unit: ${expectedMlPerUnit}, total ml: ${expectedTotalMl}`);

  // For the food item, pick basePrice
  const foodPrice = Number(testFoodMenuItem.basePrice);
  const foodQuantity = 3;
  console.log(`  Food: ${foodQuantity}x ${testFoodMenuItem.name} @ ₹${foodPrice}`);

  // Expected kitchen deductions
  const expectedKitchenDeductions: { ingredientId: string; name: string; expectedDeduction: number; unit: string }[] = [];
  for (const recipe of testFoodMenuItem.recipes) {
    expectedKitchenDeductions.push({
      ingredientId: recipe.ingredientId,
      name: recipe.ingredient.name,
      expectedDeduction: Number(recipe.quantity) * foodQuantity,
      unit: recipe.ingredient.unit,
    });
  }
  console.log(`  Expected kitchen deductions:`);
  for (const kd of expectedKitchenDeductions) {
    console.log(`    ${kd.name}: -${kd.expectedDeduction} ${kd.unit}`);
  }

  // ── Step 3: Capture stock BEFORE ────────────────────────────────────────────
  header('Step 3: Capture stock BEFORE deduction');

  // Bar inventory stock before
  const barInvIds = testDualVariantPair
    ? [testDualVariantPair.inv750.id, testDualVariantPair.inv180.id]
    : [testBarInventory.id];

  const barStockBefore = new Map<string, number>();
  for (const invId of barInvIds) {
    const inv = await prisma.inventoryItem.findUnique({ where: { id: invId }, select: { id: true, currentStock: true, menuItem: { select: { name: true } } } });
    if (inv) {
      barStockBefore.set(invId, Number(inv.currentStock));
      console.log(`  Bar inv ${inv.menuItem?.name}: ${Number(inv.currentStock)}ml`);
    }
  }

  // Ensure bar inventory has enough stock for the test (temporarily set if needed)
  const minRequiredStock = expectedTotalMl + 100; // extra buffer
  for (const invId of barInvIds) {
    const currentStock = barStockBefore.get(invId) || 0;
    if (currentStock < minRequiredStock) {
      console.log(`  ${C.yellow}⚠ Bar inv ${invId} has only ${currentStock}ml — temporarily setting to ${minRequiredStock}ml for test${C.reset}`);
      await prisma.inventoryItem.update({
        where: { id: invId },
        data: { currentStock: minRequiredStock },
      });
      barStockBefore.set(invId, minRequiredStock); // update "before" to the temp value
    }
  }

  // Kitchen inventory stock before
  const kitchenStockBefore = new Map<string, number>();
  for (const kd of expectedKitchenDeductions) {
    const ing = await prisma.kitchenInventoryItem.findUnique({ where: { id: kd.ingredientId }, select: { id: true, currentStock: true, name: true } });
    if (ing) {
      kitchenStockBefore.set(kd.ingredientId, Number(ing.currentStock));
      console.log(`  Kitchen ing ${ing.name}: ${Number(ing.currentStock)} ${kd.unit}`);
    }
  }

  // ── Step 4: Create a test PAID order ─────────────────────────────────────────
  header('Step 4: Create test PAID order');

  const testOrderId = `e2e-test-${Date.now()}`;
  const testTableId = `e2e-table-${Date.now()}`;

  // Create a table (if needed) — or use an existing one
  let table = await prisma.table.findFirst({
    where: { restaurantId: testRestaurant.id },
    select: { id: true, number: true },
  });
  if (!table) {
    console.error(`${C.red}❌ No table found for restaurant ${testRestaurant.id}. Cannot create test order.${C.reset}`);
    process.exit(1);
  }

  const order = await prisma.order.create({
    data: {
      id: testOrderId,
      restaurantId: testRestaurant.id,
      tableId: table.id,
      status: 'PAID',
      totalAmount: new Prisma.Decimal(liquorPrice * liquorQuantity + foodPrice * foodQuantity),
      paidAt: new Date(),
      inventoryDeducted: false,
      barInventoryDeducted: false,
      items: {
        create: [
          {
            menuItemId: testLiquorMenuItem.id,
            name: testLiquorMenuItem.name,
            price: new Prisma.Decimal(liquorPrice),
            quantity: liquorQuantity,
            menuType: 'LIQUOR',
            notes: 'E2E test - liquor',
          },
          {
            menuItemId: testFoodMenuItem.id,
            name: testFoodMenuItem.name,
            price: new Prisma.Decimal(foodPrice),
            quantity: foodQuantity,
            menuType: 'FOOD',
            notes: 'E2E test - food',
          },
        ],
      },
    },
    include: { items: true },
  });
  console.log(`  Created order: ${order.id} with ${order.items.length} items`);

  // ── Step 5: Call deductInventoryForOrder ─────────────────────────────────────
  header('Step 5: Call deductInventoryForOrder() (mimics settle)');

  // Set BAR_MAPPING_FALLBACK=true so the name-based matcher is used when no mapping exists
  process.env.BAR_MAPPING_FALLBACK = 'true';

  let deductionResult: any;
  try {
    deductionResult = await prisma.$transaction(async (tx: any) => {
      return await deductInventoryForOrder(order.id, testRestaurant.id, tx, null);
    }, { timeout: 30000, maxWait: 30000 });
    console.log(`  ${C.green}✅ Deduction completed${C.reset}`);
    console.log(`    Bar errors: ${deductionResult.barDeductionErrors.length}`);
    console.log(`    Kitchen errors: ${deductionResult.kitchenDeductionErrors.length}`);
    console.log(`    Missing recipe items: ${deductionResult.missingRecipeItems.length}`);
    if (deductionResult.barDeductionErrors.length > 0) {
      console.log(`    Bar errors: ${deductionResult.barDeductionErrors.join(', ')}`);
    }
    if (deductionResult.kitchenDeductionErrors.length > 0) {
      console.log(`    Kitchen errors: ${deductionResult.kitchenDeductionErrors.join(', ')}`);
    }
  } catch (err: any) {
    console.error(`  ${C.red}❌ Deduction failed: ${err.message}${C.reset}`);
    throw err;
  }

  // ── Step 6: Capture stock AFTER and verify ──────────────────────────────────
  header('Step 6: Verify stock deductions');

  // Verify bar inventory
  console.log(`\n  ${C.bold}Bar Inventory:${C.reset}`);
  if (testDualVariantPair) {
    // Dual-variant: check both 750ml and 180ml
    const stock750After = await prisma.inventoryItem.findUnique({ where: { id: testDualVariantPair.inv750.id }, select: { currentStock: true } });
    const stock180After = await prisma.inventoryItem.findUnique({ where: { id: testDualVariantPair.inv180.id }, select: { currentStock: true } });
    const stock750Before = barStockBefore.get(testDualVariantPair.inv750.id) || 0;
    const stock180Before = barStockBefore.get(testDualVariantPair.inv180.id) || 0;
    const deduct750 = stock750Before - Number(stock750After?.currentStock || 0);
    const deduct180 = stock180Before - Number(stock180After?.currentStock || 0);
    const totalDeducted = deduct750 + deduct180;

    console.log(`    750ml: ${stock750Before} → ${Number(stock750After?.currentStock || 0)} (deducted: ${deduct750}ml)`);
    console.log(`    180ml: ${stock180Before} → ${Number(stock180After?.currentStock || 0)} (deducted: ${deduct180}ml)`);
    console.log(`    Total deducted: ${totalDeducted}ml (expected: ${expectedTotalMl}ml)`);

    assert('Bar: total deduction matches expected ml', totalDeducted === expectedTotalMl,
      `got ${totalDeducted}ml, expected ${expectedTotalMl}ml`);

    // Verify priority: 750ml should be deducted first
    const stock750WasSufficient = stock750Before >= expectedTotalMl;
    if (stock750WasSufficient) {
      assert('Bar: 750ml deducted first (had enough stock)', deduct750 === expectedTotalMl && deduct180 === 0,
        `750ml deducted ${deduct750}, 180ml deducted ${deduct180}`);
    } else {
      assert('Bar: 750ml exhausted, remainder from 180ml',
        deduct750 === stock750Before && deduct180 === (expectedTotalMl - stock750Before),
        `750ml deducted ${deduct750} (was ${stock750Before}), 180ml deducted ${deduct180}`);
    }
  } else {
    // Single variant
    const stockAfter = await prisma.inventoryItem.findUnique({ where: { id: testBarInventory.id }, select: { currentStock: true } });
    const stockBefore = barStockBefore.get(testBarInventory.id) || 0;
    const deducted = stockBefore - Number(stockAfter?.currentStock || 0);
    console.log(`    ${testBarInventory.menuItem?.name}: ${stockBefore} → ${Number(stockAfter?.currentStock || 0)} (deducted: ${deducted}ml)`);
    console.log(`    Expected: ${expectedTotalMl}ml`);
    assert('Bar: deduction matches expected ml', deducted === expectedTotalMl,
      `got ${deducted}ml, expected ${expectedTotalMl}ml`);
  }

  // Verify kitchen inventory
  console.log(`\n  ${C.bold}Kitchen Inventory:${C.reset}`);
  for (const kd of expectedKitchenDeductions) {
    const ingAfter = await prisma.kitchenInventoryItem.findUnique({ where: { id: kd.ingredientId }, select: { currentStock: true, name: true } });
    const stockBefore = kitchenStockBefore.get(kd.ingredientId) || 0;
    const stockAfter = Number(ingAfter?.currentStock || 0);
    const actualDeduction = stockBefore - stockAfter;
    console.log(`    ${kd.name}: ${stockBefore} → ${stockAfter} (deducted: ${actualDeduction} ${kd.unit}, expected: ${kd.expectedDeduction} ${kd.unit})`);
    assert(`Kitchen: ${kd.name} deducted correctly`,
      Math.abs(actualDeduction - kd.expectedDeduction) < 0.001,
      `got ${actualDeduction}, expected ${kd.expectedDeduction}`);
  }

  // Verify order flags
  const orderAfter = await prisma.order.findUnique({ where: { id: order.id }, select: { inventoryDeducted: true, barInventoryDeducted: true } });
  console.log(`\n  Order flags: inventoryDeducted=${orderAfter?.inventoryDeducted}, barInventoryDeducted=${orderAfter?.barInventoryDeducted}`);
  assert('Order: barInventoryDeducted set to true', orderAfter?.barInventoryDeducted === true,
    `got ${orderAfter?.barInventoryDeducted}`);
  assert('Order: inventoryDeducted set to true', orderAfter?.inventoryDeducted === true,
    `got ${orderAfter?.inventoryDeducted}`);

  // ── Step 7: Test idempotency ────────────────────────────────────────────────
  header('Step 7: Test idempotency (call again, should NOT double-deduct)');

  // Reset order flags to simulate a retry
  await prisma.order.update({
    where: { id: order.id },
    data: { inventoryDeducted: false, barInventoryDeducted: false },
  });

  // Capture stock before retry
  const barStockBeforeRetry = new Map<string, number>();
  for (const invId of barInvIds) {
    const inv = await prisma.inventoryItem.findUnique({ where: { id: invId }, select: { currentStock: true } });
    if (inv) barStockBeforeRetry.set(invId, Number(inv.currentStock));
  }
  const kitchenStockBeforeRetry = new Map<string, number>();
  for (const kd of expectedKitchenDeductions) {
    const ing = await prisma.kitchenInventoryItem.findUnique({ where: { id: kd.ingredientId }, select: { currentStock: true } });
    if (ing) kitchenStockBeforeRetry.set(kd.ingredientId, Number(ing.currentStock));
  }

  // Call deduction again
  let retryResult: any;
  try {
    retryResult = await prisma.$transaction(async (tx: any) => {
      return await deductInventoryForOrder(order.id, testRestaurant.id, tx, null);
    }, { timeout: 30000, maxWait: 30000 });
    console.log(`  ${C.green}✅ Retry deduction completed${C.reset}`);
    console.log(`    Bar errors: ${retryResult.barDeductionErrors.length}`);
    console.log(`    Kitchen errors: ${retryResult.kitchenDeductionErrors.length}`);
  } catch (err: any) {
    console.error(`  ${C.red}❌ Retry deduction failed: ${err.message}${C.reset}`);
    throw err;
  }

  // Verify no double-deduction
  console.log(`\n  ${C.bold}Verifying no double-deduction:${C.reset}`);
  let noDoubleDeduct = true;
  for (const invId of barInvIds) {
    const invAfter = await prisma.inventoryItem.findUnique({ where: { id: invId }, select: { currentStock: true, menuItem: { select: { name: true } } } });
    const before = barStockBeforeRetry.get(invId) || 0;
    const after = Number(invAfter?.currentStock || 0);
    const diff = before - after;
    console.log(`    Bar ${invAfter?.menuItem?.name}: ${before} → ${after} (change: ${diff}ml)`);
    if (Math.abs(diff) > 0.001) {
      noDoubleDeduct = false;
    }
  }
  for (const kd of expectedKitchenDeductions) {
    const ingAfter = await prisma.kitchenInventoryItem.findUnique({ where: { id: kd.ingredientId }, select: { currentStock: true, name: true } });
    const before = kitchenStockBeforeRetry.get(kd.ingredientId) || 0;
    const after = Number(ingAfter?.currentStock || 0);
    const diff = before - after;
    console.log(`    Kitchen ${ingAfter?.name}: ${before} → ${after} (change: ${diff} ${kd.unit})`);
    if (Math.abs(diff) > 0.001) {
      noDoubleDeduct = false;
    }
  }
  assert('Idempotency: no double-deduction on retry', noDoubleDeduct,
    'Stock changed on retry — idempotency broken!');

  // ── Step 8: Test dual-variant priority (750ml exhausted → 180ml) ─────────────
  if (testDualVariantPair) {
    header('Step 8: Test dual-variant priority (750ml=0 → all from 180ml)');

    // Set 750ml stock to 0
    const stock750Original = await prisma.inventoryItem.findUnique({ where: { id: testDualVariantPair.inv750.id }, select: { currentStock: true } });
    await prisma.inventoryItem.update({
      where: { id: testDualVariantPair.inv750.id },
      data: { currentStock: 0 },
    });
    console.log(`  Set 750ml stock to 0 (was ${Number(stock750Original?.currentStock || 0)}ml)`);

    // Create a second test order
    const testOrderId2 = `e2e-test2-${Date.now()}`;
    const order2 = await prisma.order.create({
      data: {
        id: testOrderId2,
        restaurantId: testRestaurant.id,
        tableId: table.id,
        status: 'PAID',
        totalAmount: new Prisma.Decimal(liquorPrice * 1),
        paidAt: new Date(),
        inventoryDeducted: false,
        barInventoryDeducted: false,
        items: {
          create: [
            {
              menuItemId: testLiquorMenuItem.id,
              name: testLiquorMenuItem.name,
              price: new Prisma.Decimal(liquorPrice),
              quantity: 1,
              menuType: 'LIQUOR',
              notes: 'E2E test2 - dual variant priority',
            },
          ],
        },
      },
    });

    const stock180Before = await prisma.inventoryItem.findUnique({ where: { id: testDualVariantPair.inv180.id }, select: { currentStock: true } });
    console.log(`  180ml stock before: ${Number(stock180Before?.currentStock || 0)}ml`);

    const expectedMl2 = expectedMlPerUnit * 1;
    console.log(`  Expected deduction: ${expectedMl2}ml from 180ml`);

    try {
      const result2 = await prisma.$transaction(async (tx: any) => {
        return await deductInventoryForOrder(order2.id, testRestaurant.id, tx, null);
      }, { timeout: 30000, maxWait: 30000 });

      const stock750After2 = await prisma.inventoryItem.findUnique({ where: { id: testDualVariantPair.inv750.id }, select: { currentStock: true } });
      const stock180After2 = await prisma.inventoryItem.findUnique({ where: { id: testDualVariantPair.inv180.id }, select: { currentStock: true } });
      const deduct750_2 = 0 - Number(stock750After2?.currentStock || 0); // should be 0 (was 0)
      const deduct180_2 = Number(stock180Before?.currentStock || 0) - Number(stock180After2?.currentStock || 0);

      console.log(`  750ml: 0 → ${Number(stock750After2?.currentStock || 0)} (deducted: ${deduct750_2}ml)`);
      console.log(`  180ml: ${Number(stock180Before?.currentStock || 0)} → ${Number(stock180After2?.currentStock || 0)} (deducted: ${deduct180_2}ml)`);

      assert('Dual-variant: 750ml=0 → all deducted from 180ml',
        deduct180_2 === expectedMl2 && deduct750_2 === 0,
        `180ml deducted ${deduct180_2}, 750ml deducted ${deduct750_2}, expected ${expectedMl2} from 180ml only`);

      // Clean up order2 — restore stock
      await prisma.inventoryItem.update({
        where: { id: testDualVariantPair.inv180.id },
        data: { currentStock: stock180Before?.currentStock || 0 },
      });
      await prisma.orderDeductionLog.deleteMany({ where: { orderId: order2.id } });
      await prisma.barDeductionLog.deleteMany({ where: { orderId: order2.id } });
      await prisma.inventoryTransaction.deleteMany({ where: { orderId: order2.id } });
      await prisma.orderItem.deleteMany({ where: { orderId: order2.id } });
      await prisma.order.delete({ where: { id: order2.id } });
      console.log(`  ${C.dim}Cleaned up order2 and restored 180ml stock${C.reset}`);
    } catch (err: any) {
      console.error(`  ${C.red}❌ Dual-variant test failed: ${err.message}${C.reset}`);
      // Restore 750ml stock
      await prisma.inventoryItem.update({
        where: { id: testDualVariantPair.inv750.id },
        data: { currentStock: stock750Original?.currentStock || 0 },
      });
    }
  }

  // ── Step 9: Cleanup ──────────────────────────────────────────────────────────
  header('Step 9: Cleanup — restore stock, delete test order');

  // Restore bar inventory stock
  for (const [invId, stock] of barStockBefore.entries()) {
    await prisma.inventoryItem.update({
      where: { id: invId },
      data: { currentStock: stock },
    });
    console.log(`  Restored bar inv ${invId} to ${stock}ml`);
  }

  // Restore kitchen inventory stock
  for (const [ingId, stock] of kitchenStockBefore.entries()) {
    await prisma.kitchenInventoryItem.update({
      where: { id: ingId },
      data: { currentStock: stock },
    });
    console.log(`  Restored kitchen ing ${ingId} to ${stock}`);
  }

  // Delete deduction logs, transactions, order items, order
  await prisma.barDeductionLog.deleteMany({ where: { orderId: order.id } });
  await prisma.orderDeductionLog.deleteMany({ where: { orderId: order.id } });
  await prisma.inventoryTransaction.deleteMany({ where: { orderId: order.id } });
  await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
  await prisma.order.delete({ where: { id: order.id } });
  console.log(`  Deleted test order ${order.id}`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  header('Test Summary');
  console.log(`  ${C.green}Passed: ${passCount}${C.reset}`);
  console.log(`  ${C.red}Failed: ${failCount}${C.reset}`);
  console.log('');

  if (failCount > 0) {
    console.log(`${C.red}${C.bold}FAILED TESTS:${C.reset}`);
    for (const r of testResults.filter(r => !r.pass)) {
      console.log(`  ${C.red}✗ ${r.name}: ${r.detail}${C.reset}`);
    }
    process.exit(1);
  } else {
    console.log(`${C.green}${C.bold}✅ ALL TESTS PASSED${C.reset}`);
  }
}

main()
  .catch((err) => {
    console.error(`${C.red}❌ E2E test crashed: ${err.message}${C.reset}`);
    console.error(err.stack);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
