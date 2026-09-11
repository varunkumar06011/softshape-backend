// mapping-apply4.js — Split true variants into their own SKUs (user-confirmed).
//   Black Gold Vsop  ≠ Black & Gold      → create 750/375/180 SKUs at 0 stock + relink menus
//   Mansion House Orange ≠ Mansion House → create 750 SKU at 0 stock + relink menus
// Morpheus Xo Rare menus already point at "Morpheous" SKUs (that IS the XO Rare
// stock) — rename them to the clear spelling so the flag noise disappears.
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const RID = "cmqy60ci200027dscyj9ubg8h";

(async () => {
  const items = await prisma.barInventoryItem.findMany({ where: { restaurantId: RID } });
  const menus = await prisma.menuItem.findMany({
    where: { restaurantId: RID, menuType: "LIQUOR", isDeleted: false },
    select: { id: true, name: true },
  });
  const plan = [];

  async function ensureSku(name, brand, category, size) {
    let sku = items.find((i) => i.name === name);
    if (!sku) {
      plan.push(`  create "${name}" (0 stock)`);
      if (!APPLY) sku = { id: null, name, isActive: false }; // stub for dry-run display
      if (APPLY) {
        sku = await prisma.barInventoryItem.create({
          data: { restaurantId: RID, name, brand, category, bottleSizeMl: size },
        });
        items.push(sku);
      }
    } else if (!sku.isActive) {
      plan.push(`  reactivate "${name}"`);
      if (APPLY) await prisma.barInventoryItem.update({ where: { id: sku.id }, data: { isActive: true } });
    }
    return sku;
  }

  // Black Gold Vsop family — menus sell 30/180/375/750; peg pours from the 750
  const bgvSkus = {};
  for (const size of [750, 375, 180]) {
    bgvSkus[size] = await ensureSku(`Black Gold Vsop ${size}ml`, "Black Gold Vsop", "Whisky", size);
  }
  for (const m of menus.filter((m) => /black gold vsop/i.test(m.name))) {
    const ml = (m.name.match(/(\d+)\s*ml/i) || [])[1];
    const size = ml ? parseInt(ml, 10) : 750;
    const sku = bgvSkus[size] || bgvSkus[750];
    plan.push(`  link "${m.name}" -> ${sku ? sku.name : "?"} (deduct ${size < 100 ? 30 : size}ml)`);
    if (APPLY && sku) await prisma.menuItem.update({ where: { id: m.id }, data: { barInventoryItemId: sku.id, deductionMl: size < 100 ? 30 : size } });
  }

  // Mansion House Orange — only a 30ml menu exists -> 750 SKU
  {
    const sku = await ensureSku("Mansion House Orange 750ml", "Mansion House Orange", "Brandy", 750);
    const ms = menus.filter((m) => /mansion house orange/i.test(m.name));
    for (const m of ms) {
      plan.push(`  link "${m.name}" -> Mansion House Orange 750ml`);
      if (APPLY && sku) await prisma.menuItem.update({ where: { id: m.id }, data: { barInventoryItemId: sku.id, deductionMl: 30 } });
    }
  }

  // Rename Morpheous -> Morpheus Xo Rare (it IS the XO Rare stock)
  for (const i of items) {
    if (!/morpheous/i.test(i.name)) continue;
    const size = i.bottleSizeMl;
    const newName = `Morpheus Xo Rare ${size}ml`;
    const clash = items.find((o) => o.id !== i.id && o.name === newName);
    if (clash) { plan.push(`  skip rename "${i.name}" — "${newName}" already exists`); continue; }
    plan.push(`  rename "${i.name}" -> "${newName}" (same stock, clearer name)`);
    if (APPLY) await prisma.barInventoryItem.update({ where: { id: i.id }, data: { name: newName, brand: "Morpheus Xo Rare" } });
    i.name = newName; i.brand = "Morpheus Xo Rare";
  }

  // Plain "Morpheus" menus (not Blue, not "Xo Rare") = the base product = XO Rare.
  // Repoint them off Morpheus Blue onto the Xo Rare family SKUs by size.
  const xor = (s) => items.find((i) => /^morpheus xo rare /i.test(i.name) && i.bottleSizeMl === s && i.isActive);
  for (const m of menus.filter((m) => /morpheus/i.test(m.name) && !/blue/i.test(m.name) && !/xo\s*rare/i.test(m.name))) {
    const ml = (m.name.match(/(\d+)\s*ml/i) || [])[1];
    const size = ml ? parseInt(ml, 10) : 750;
    const sku = xor(size) || xor(750);
    plan.push(`  link "${m.name}" -> ${sku ? sku.name : "?"} (deduct ${size < 100 ? 30 : size}ml)`);
    if (APPLY && sku && sku.id) await prisma.menuItem.update({ where: { id: m.id }, data: { barInventoryItemId: sku.id, deductionMl: size < 100 ? 30 : size } });
  }

  console.log(`\n═══ ROUND-4 (${APPLY ? "APPLY" : "DRY RUN"}) ═══`);
  plan.forEach((p) => console.log(p));
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
