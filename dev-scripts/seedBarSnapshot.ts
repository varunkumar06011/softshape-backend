// ─────────────────────────────────────────────────────────────────────────────
// Seed Bar Inventory Snapshot from Physical Count (sheet dated 24.08.2026)
// ─────────────────────────────────────────────────────────────────────────────
// IMAGE CLOSING → SYSTEM OPENING STOCK
// Then applies today's (24.08.2026 IST) already-recorded transaction movements
// so currentStock reflects settled bills up to now. New PAID bills continue
// auto-deducting through the existing cashier/settle flow.
//
// Sheet format: CLOSING column = full bottles ("4+5" = 9), right margin = ml
// in the open bottle. Total ml = bottles × bottleSize + open ml.
//
// Run dry:   npx ts-node --compiler-options '{"module":"CommonJS"}' dev-scripts/seedBarSnapshot.ts
// Apply:     set APPLY = true below, then run again.
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h"; // Vgrand Lounge
const SNAPSHOT_DATE = "2026-08-24";

// IST business-day window for "today's settled bills till now"
const DAY_START = new Date("2026-08-24T00:00:00.000+05:30");
const DAY_END = new Date("2026-08-25T00:00:00.000+05:30");

// ⚠️  false = dry run (no DB writes). true = apply changes.
const APPLY = true;

interface SnapItem {
  itemId: string;
  itemName: string;   // DB name (display only)
  closingMl: number;  // total physical closing in ml
  source: string;     // how the value was read from the sheet
  flag?: string;      // uncertainty note
}

// ── Extracted from the two sheet photos ─────────────────────────────────────
const SNAPSHOT_ITEMS: SnapItem[] = [
  // === BEERS (closing in full bottles) ===
  { itemId: "cms9798sz000yt2gpjwp1dt5w", itemName: "British Empire Strong Beer", closingMl: 15 * 650, source: "BRITISH ULTRA closing 15", flag: "Name mapped: sheet 'BRITISH ULTRA' → DB 'British Empire Strong Beer'" },
  { itemId: "cms978zx9000et2gpm9a13hfy", itemName: "Budweiser Magnum Beer", closingMl: 33 * 650, source: "BUD MAGNUM 650 closing 33" },
  { itemId: "cms979b6h0012t2gpap8qvyem", itemName: "Budweiser Tin Beer", closingMl: 6 * 500, source: "BUDWISER TIN closing 5+1=6" },
  { itemId: "cms979dyw0016t2gpw16qzxtw", itemName: "Karjura Beer", closingMl: 5 * 650, source: "KARJURA BEER closing 5" },
  { itemId: "cms9791i4000it2gptvye5nyh", itemName: "Kf Lite Beer", closingMl: 15 * 650, source: "K F LITE closing 15" },
  { itemId: "cms9793ek000mt2gp1ciw6p4v", itemName: "Kf Storm Beer", closingMl: 37 * 650, source: "KF STORM 650ML closing 37" },
  { itemId: "cms978wod0006t2gpf12a9902", itemName: "Kf Strong Beer", closingMl: 58 * 650, source: "K F STRONG 650ML closing 57+1=58" },
  { itemId: "cms978yht000at2gptg4ur5c0", itemName: "Kf Ultra Beer", closingMl: 62 * 650, source: "K F ULTRA LAGER 650ML closing 62" },
  { itemId: "cms9794wz000qt2gpmipwzzui", itemName: "Stok Lite Beer", closingMl: 20 * 650, source: "STOCK LITE BEER closing 20" },

  // === BREEZER ===
  { itemId: "cmrdzuuo8000p4hyc9gc3cwjy", itemName: "Breezer Platinum Tangy", closingMl: 9 * 500, source: "BREEZER ORANGE closing 4+5=9", flag: "Name mapped: sheet 'BREEZER ORANGE' → DB 'Breezer Platinum Tangy'" },

  // === BRANDY (bottles × 750 + open-bottle ml from margin) ===
  { itemId: "cmrdzuv40000r4hych3e3f8ee", itemName: "Black Gold Vsop", closingMl: 600, source: "BLACK GOLD VSOP closing '-', margin 600ml" },
  { itemId: "cmrdzuvjt000t4hycg37di21y", itemName: "Courrier Napoleon Green", closingMl: 4 * 750 + 310, source: "COURIER NAPOLEON closing 4, margin 310ml", flag: "Sheet does not say Green or Red — assigned to Green, Red left untouched" },
  { itemId: "cmrdzuwfq000x4hycjsuaglc7", itemName: "Kyron Brandy 30ml", closingMl: 7 * 750 + 420, source: "KYRON PREMIUM closing 3+4=7, margin 420ml", flag: "Closing read as 3+4=7 bottles" },
  { itemId: "cmrdzuwze000z4hyca006n1wb", itemName: "Mansion House 180ml", closingMl: 11 * 180 + 670, source: "MANSION HOUSE XO 180ML closing 6+5=11, margin 670ml", flag: "Margin 670ml exceeds one 180ml bottle — treated as total loose ml across open bottles" },
  { itemId: "cmrdzuy0h00114hyclflzsd0m", itemName: "Mansion House 750ml", closingMl: 9 * 750 + 210, source: "MANSION HOUSE XO 750ML closing 4+5=9, margin 210ml" },
  { itemId: "cmrdzuz1i00134hycxcttsdt6", itemName: "Mc Brandy", closingMl: 1 * 375 + 30, source: "MC BRANDY 375ML closing 1, margin 30ml", flag: "Sheet says 375ML but DB bottleSize=750 — ml value used directly" },
  { itemId: "cmrdzv1c200194hycdcvlud9s", itemName: "Mc Vsop Brandy", closingMl: 150, source: "MC VSOP closing '-', margin 150ml" },
  { itemId: "cmrdzuzzm00154hycvvilgad4", itemName: "Morpheus Blue Brandy", closingMl: 30, source: "MORPHEUS BLUE closing '-', margin 30ml", flag: "Sheet also has MORPHEUS XO RARE (2+2 btl, 100ml open = 3100ml) — no DB item, NOT applied" },

  // === RUM ===
  { itemId: "cmrdzv1rs001b4hycl7uv1s8c", itemName: "Old Monk Rum", closingMl: 610, source: "OLD MONK RUM closing '-', margin 610ml" },

  // === VODKA ===
  { itemId: "cmrdzv27i001d4hyc82unja4r", itemName: "Absolut Vodka", closingMl: 2 * 750 + 120, source: "Absolut Vodka 750 closing 2, margin 120ml" },
  { itemId: "cmrdzv3ix001j4hyccwy54uyv", itemName: "Magic Moments Green", closingMl: 4 * 750 + 420, source: "Magic Moments Green closing 4, margin 420ml", flag: "Margin may read 420 or 490 — used 420" },
  { itemId: "cmrdzv335001h4hycn65g80wr", itemName: "Magic Moments Orange", closingMl: 4 * 750 + 420, source: "Magic Moments Orange closing 4, margin 420ml" },
  { itemId: "cmrdzv2nd001f4hycfm1h58vx", itemName: "Smirnoff Orange Vodka 30ml", closingMl: 1 * 750 + 150, source: "Smirn Off Orange Twist closing 1, margin 150ml" },

  // === WHISKY ===
  { itemId: "cmrdzv3yr001l4hyc7oty9ces", itemName: "100 Pipers 30ml", closingMl: 5 * 750 + 270, source: "100 PIPERS closing 4+1=5, margin 270ml" },
  { itemId: "cmrdzv4ee001n4hycg5y6zyh5", itemName: "Antiquity Blue", closingMl: 2 * 750 + 180, source: "A Q BLUE closing 2, margin 180ml", flag: "Name mapped: sheet 'A Q BLUE' → DB 'Antiquity Blue'" },
  { itemId: "cmrdzv4ua001p4hyca6dqb137", itemName: "Ballantines", closingMl: 2 * 750 + 450, source: "BALLANTINES closing 2, margin 450ml" },
  { itemId: "cmrdzv5a2001r4hycx72s72ky", itemName: "Black And White", closingMl: 580, source: "BLACK AND WHITE closing '-', margin 580ml" },
  { itemId: "cmrdzv5px001t4hyc8x8icse4", itemName: "Black Dog 180ml", closingMl: 8 * 180, source: "BLACK DOG RESERVE 180ML closing 8, margin '-'" },
  { itemId: "cmrdzv65u001v4hyc7lcbaqfh", itemName: "Black Dog 750ml", closingMl: 3 * 750 + 140, source: "BLACK DOG RESERVE 750ML closing 3, margin 140ml", flag: "Margin read as 140 — could be smudged" },
  { itemId: "cmrdzv6ll001x4hycmx5yvnc8", itemName: "Black Label", closingMl: 4 * 750 + 570, source: "BLACK LABEL closing 4, margin 570ml" },
  { itemId: "cmrdzv71a001z4hyc7ai97nhh", itemName: "Blenders Pride 30ml", closingMl: 4 * 750 + 330, source: "BLENDERS PRIDE closing 3+1=4, margin 330ml" },
  { itemId: "cmrdzv7h300214hyc8jxtwymq", itemName: "Chivas Regal", closingMl: 2 * 750 + 300, source: "CHIVAS REGAL closing 2, margin 300ml" },
  { itemId: "cmrdzv7wy00234hyc7gnn8aoq", itemName: "Imperial Blue", closingMl: 4 * 750 + 510, source: "IMPERIAL BLUE closing 3+1=4, margin 510ml" },
  { itemId: "cmrdzvbf9002j4hycle6cb04m", itemName: "Jamson", closingMl: 1 * 750 + 580, source: "JAMSON closing 1, margin 580ml" },
  { itemId: "cmrdzv98f00294hycmgronyzs", itemName: "Legacy Whisky", closingMl: 4 * 750 + 40, source: "LEGACY closing 4, margin 40ml" },
  { itemId: "cmrdzv8sj00274hycys5egcuc", itemName: "Mc Whisky", closingMl: 4 * 750, source: "MC WHISKY closing 4, margin unreadable", flag: "Margin unreadable — counted full bottles only" },
  { itemId: "cmrdzv9o8002b4hyct62j0yor", itemName: "Red Label", closingMl: 4 * 750 + 640, source: "RED LABEL closing 2+2=4, margin 640ml" },
  { itemId: "cmrdzva42002d4hyccequ7lnm", itemName: "Royal Challenge", closingMl: 9 * 750 + 510, source: "ROYAL CHALLENGE closing 4+5=9, margin 510ml" },
  { itemId: "cmrdzvajs002f4hycrwm25fdd", itemName: "Royal Stag 30ml", closingMl: 4 * 750 + 180, source: "ROYAL STAG BLENDED closing 3+1=4, margin 180ml", flag: "Name mapped: sheet 'ROYAL STAG BLENDED' → DB 'Royal Stag 30ml'" },
  { itemId: "cmrdzvazi002h4hyc2c4u6ujs", itemName: "Royal Stag Barrel", closingMl: 1 * 750 + 30, source: "ROYAL STAG BARREL closing 1, margin 30ml" },
  { itemId: "cmrdzvccc002n4hycp54g1kn2", itemName: "Signature", closingMl: 190, source: "SIGANTURE closing '-', margin 190ml" },
  { itemId: "cmrdzvcs7002p4hyc5ml9i9yn", itemName: "Sterling B10 30ml", closingMl: 2 * 750 + 210, source: "STERLING RESERVE B10 closing 2, margin 210ml" },
  { itemId: "cmrdzvdo3002t4hycecoqgdhb", itemName: "Sterling B7 30ml", closingMl: 2 * 750 + 640, source: "STERLING RESERVE B7 closing 2, margin 640ml" },
  { itemId: "cmrdzvd83002r4hycjbhwvftz", itemName: "Teacher Higland", closingMl: 2 * 750 + 420, source: "TEACHER HIGLAND closing 1+1=2, margin 420ml" },
  { itemId: "cmrdzv8cr00254hycdfwat4t1", itemName: "Vat 69", closingMl: 3 * 750 + 720, source: "VAT 69 closing 3, margin 720ml", flag: "Margin read as 720 — could belong to adjacent row" },
  { itemId: "cmrdzvbw2002l4hyc14bwcxox", itemName: "Willian Lawson", closingMl: 220, source: "WILLIAN LAWSON closing '-', margin 220ml" },

  // === SOFT DRINKS (rotated section, closing in bottles) ===
  { itemId: "cmrdzvk93003n4hyctvgb4yfu", itemName: "Thums Up 250ML", closingMl: 12 * 250, source: "Thumsup 250ml closing 8+1+3=12", flag: "Rotated section — read as 8+1+3=12" },
  { itemId: "cmrdzvixu003h4hycgg0p7eib", itemName: "Sprite 250ml", closingMl: 23 * 250, source: "Sprite 250ml closing 9+1+4+9=23", flag: "Rotated section — handwriting partially unclear (9+1+4+9)" },
  { itemId: "cmrdzvjdi003j4hycwgkjc88w", itemName: "Sprite 600ml", closingMl: 1 * 600, source: "Sprite 600ml closing 1" },
  { itemId: "cmrdzvii1003f4hycrrkdt4gj", itemName: "Limca 250ml", closingMl: 6 * 250, source: "Limca 250ml closing 6", flag: "Rotated section — read as 6" },
  { itemId: "cms776epb0001g5ms9i6jjtfu", itemName: "Water Bottle 1ltr", closingMl: 69 * 1000, source: "Kinley Water Bottle 1ltr closing 69", flag: "Rotated section — read as 69" },
  { itemId: "cmrdzvhmi003b4hycujad8hrm", itemName: "Rimzim Cooldrink", closingMl: 7 * 250, source: "RIM ZIM closing 7" },
  { itemId: "cmrdzvh6m00394hycgmjgyv6d", itemName: "Pulpy Orange 250ml", closingMl: 42 * 250, source: "Pulpy 250ml closing 14+28=42", flag: "Rotated section — read as 14+28=42" },
  { itemId: "cmrdzvgaw00354hycweft1h92", itemName: "Soda 750ml", closingMl: 4 * 750, source: "Kinley Soda 750ml closing 4", flag: "Rotated section — read as 4" },
  { itemId: "cmrdzvfv200334hycyx7qpoi1", itemName: "Soda 250ml", closingMl: 84 * 250, source: "Kinley Soda 250ml closing 28+53+3=84", flag: "Rotated section — read as 28+53+3=84" },
  { itemId: "cmrdzvffb00314hycoie0xhlu", itemName: "Fanta 250ml", closingMl: 23 * 250, source: "Fanta 250ml closing 23" },
  { itemId: "cmrdzvezo002z4hyccisil88l", itemName: "Coca Cola 250ml", closingMl: 23 * 250, source: "Coca Cola 250ml closing 23" },

  // === WINE ===
  { itemId: "cmrdzvejt002x4hyccyrxu2uv", itemName: "Elite Wine", closingMl: 2 * 750 + 270, source: "ELITE WINE closing 2, margin 270ml", flag: "Margin read as 270" },
  { itemId: "cmrdzve40002v4hycfc5uurfn", itemName: "Kyra Wine", closingMl: 9 * 375, source: "Kyra wine 375ML closing 9", flag: "Sheet says 375ML but DB bottleSize=750 — ml value used directly; circled 1260 not used" },
];

// Items on the sheet with NO matching DB row (report only):
const UNMAPPED_SHEET_ITEMS = [
  "BRITISH WHISKY 750ML — closing 2 btl + 240ml = 1740ml",
  "DEWARS — closing 0 btl + 380ml = 380ml",
  "CLOVIS XO BRANDY 750ML — closing 4 btl + 510ml = 3510ml",
  "MORPHEUS XO RARE 750ML — closing 2+2=4 btl + 100ml = 3100ml",
  "MONSTER — closing 11 cans",
];

async function main() {
  console.log("========================================");
  console.log("Bar Inventory Snapshot Seeder");
  console.log(`Outlet: ${RESTAURANT_ID} (Vgrand Lounge)`);
  console.log(`Baseline date: ${SNAPSHOT_DATE} (IST business day)`);
  console.log(`Mode: ${APPLY ? "APPLY (will modify DB)" : "DRY RUN"}`);
  console.log("========================================\n");

  // Pull today's already-recorded movements so settled bills up to now
  // are reflected on top of the physical baseline.
  const itemIds = SNAPSHOT_ITEMS.map((s) => s.itemId);
  const todayTxns = await prisma.inventoryTransaction.findMany({
    where: {
      restaurantId: RESTAURANT_ID,
      itemId: { in: itemIds },
      transactionDate: { gte: DAY_START, lt: DAY_END },
    },
    select: { itemId: true, type: true, quantityChange: true },
  });

  const netToday = new Map<string, number>();
  for (const t of todayTxns) {
    netToday.set(t.itemId, (netToday.get(t.itemId) || 0) + Number(t.quantityChange));
  }

  console.log("Item                               Baseline ml   Today net   New current   Source");
  console.log("-".repeat(120));
  let applied = 0;
  let errors = 0;

  for (const s of SNAPSHOT_ITEMS) {
    const movement = Math.round((netToday.get(s.itemId) || 0) * 100) / 100;
    const newCurrent = Math.round((s.closingMl + movement) * 100) / 100;

    console.log(
      `${s.itemName.slice(0, 32).padEnd(33)}${String(s.closingMl).padStart(11)}${String(movement).padStart(12)}${String(newCurrent).padStart(13)}   ${s.source}${s.flag ? "  ⚠ " + s.flag : ""}`
    );

    if (!APPLY) continue;

    try {
      const existing = await prisma.inventoryItem.findFirst({
        where: { id: s.itemId, restaurantId: RESTAURANT_ID },
        select: { id: true, currentStock: true },
      });
      if (!existing) {
        console.log(`   ✗ NOT FOUND in DB: ${s.itemName}`);
        errors++;
        continue;
      }

      const previousStock = Number(existing.currentStock);
      const adjustmentDelta = Math.round((newCurrent - previousStock) * 100) / 100;

      await prisma.$transaction(async (tx) => {
        await tx.inventoryItem.updateMany({
          where: { id: s.itemId, restaurantId: RESTAURANT_ID },
          data: {
            openingStock: new Prisma.Decimal(s.closingMl),
            currentStock: new Prisma.Decimal(newCurrent),
            updatedAt: new Date(),
          },
        });

        if (Math.abs(adjustmentDelta) > 0.01) {
          await tx.inventoryTransaction.create({
            data: {
              restaurantId: RESTAURANT_ID,
              itemId: s.itemId,
              type: "ADJUSTMENT",
              quantityChange: new Prisma.Decimal(adjustmentDelta),
              stockBefore: new Prisma.Decimal(previousStock),
              stockAfter: new Prisma.Decimal(newCurrent),
              notes: `Physical snapshot ${SNAPSHOT_DATE}: baseline ${s.closingMl}ml (${s.source}) + today's recorded movement ${movement}ml`,
              createdBy: "SeedScript",
            },
          });
        }

        await tx.dailyInventorySnapshot.upsert({
          where: {
            restaurantId_snapshotDate_itemId: {
              restaurantId: RESTAURANT_ID,
              snapshotDate: SNAPSHOT_DATE,
              itemId: s.itemId,
            },
          },
          create: {
            restaurantId: RESTAURANT_ID,
            itemId: s.itemId,
            snapshotDate: SNAPSHOT_DATE,
            itemName: s.itemName,
            openingStock: new Prisma.Decimal(s.closingMl),
            purchased: new Prisma.Decimal(0),
            sold: new Prisma.Decimal(0),
            wastage: new Prisma.Decimal(0),
            adjusted: new Prisma.Decimal(adjustmentDelta),
            closingStock: new Prisma.Decimal(newCurrent),
          },
          update: {
            openingStock: new Prisma.Decimal(s.closingMl),
            closingStock: new Prisma.Decimal(newCurrent),
          },
        });
      });
      applied++;
    } catch (err: any) {
      console.log(`   ✗ ERROR: ${s.itemName} — ${err.message}`);
      errors++;
    }
  }

  console.log("-".repeat(120));
  console.log("\nSheet items with NO DB match (not applied — create the items first if needed):");
  UNMAPPED_SHEET_ITEMS.forEach((u) => console.log(`  - ${u}`));

  console.log("\nDB items NOT on the sheet (left untouched):");
  console.log("  - Budweiser Beer, Kalyani Beer, Stok Strong Beer, Mansion House 30ml,");
  console.log("    Morpheus 30ml, Absolut Vodka 30ml, Maaza 250ml, Courrier Napoleon Red, Thums Up 650ml (closing '-')");

  if (!APPLY) {
    console.log("\nDRY RUN — no changes made. Review the table above, then set APPLY = true and re-run.");
  } else {
    console.log(`\nApplied: ${applied} | Errors: ${errors}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
