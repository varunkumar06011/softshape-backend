// Menu Linking Script — links LIQUOR menu items to BarInventoryItems
// and sets correct deductionMl values.
//
// Usage:
//   node scripts/link-menu-inventory.js              — DRY RUN
//   node scripts/link-menu-inventory.js --apply      — write to DB

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const RESTAURANT_ID = "cmqy60ci200027dscyj9ubg8h";

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeBrand(name) {
  if (!name) return "";
  return name.toLowerCase()
    .replace(/\s*\d+\s*ml\b/gi, "")
    .replace(/\s*(full\s+bottle|bottle|tin|can)\s*/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein distance for fuzzy spelling-variation matching
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]) + 1;
    }
  }
  return dp[m][n];
}

// Known brand aliases (menu name → Excel brand normalized)
const BRAND_ALIASES = {
  "absolut vodka": "absolute vokda",
  "ballantines": "ballaentines",
  "courrier napoleon green": "courier napoleon green",
  "courrier napoleon red": "courier napoleon",
  "hydarabad blue": "hyderabad blue",
  "jamson": "jemson",
  "teacher higland": "teachers",
  "willian lawson": "william lawson",
  "bp": "blenders pride",
  "im whisky": "imperial blue",
  "oc whisky": "officers choice blue",
  "b7 whisky": "sterling b7",
  "b10 whisky": "sterling b10",
  "mc vsop brandy": "mc brandy vsop",
  "mc wishky": "mc whisky",
  "magic moments green": "magic moments vodka green apple",
  "magic moments orange": "magic moments vodka orange",
  "magic moments or": "magic moments vodka orange",
  "kyron brandy": "kyron premium",
  "morpheus xo rare brandy": "morpheous",
  "smirnoff orange vodka": "smrinoff",
  "royal green premium": "royal stag",
  "black and white": "black white",
  "britesh wh": "british whiky",
  "british empire whisky": "british whiky",
  "british whisky": "british whiky",
  "o c elegant whisky": "officers choice supreme",
  "oab": "old admiral",
  "whytehall": "whytal brandy",
  "vat69": "vat 69",
};

function parseMlFromName(name) {
  if (!name) return null;
  const m = name.match(/(\d+)\s*ml\b/i);
  return m ? parseInt(m[1], 10) : null;
}

// Serving sizes that trigger the bottle picker (peg sizes)
const PEG_SIZES = new Set([30, 60, 90, 180, 375]);
// Full bottle sizes (no picker needed — deduct the full bottle)
const FULL_BOTTLE_SIZES = new Set([650, 750]);

async function main() {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`Menu Linking — Vgrand Lounge`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`${"=".repeat(80)}\n`);

  // Load all active inventory items
  const invItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: true },
    select: { id: true, name: true, brand: true, category: true, bottleSizeMl: true },
  });

  // Build lookup: normalized brand + size → inventory item
  const invByNorm = new Map();
  for (const item of invItems) {
    const norm = normalizeBrand(item.brand || item.name);
    const key = `${norm}::${item.bottleSizeMl}`;
    if (!invByNorm.has(key)) invByNorm.set(key, []);
    invByNorm.get(key).push(item);
  }

  // Also build brand-only lookup (for peg sizes — any bottle of same brand)
  const invByBrand = new Map();
  for (const item of invItems) {
    const norm = normalizeBrand(item.brand || item.name);
    if (!invByBrand.has(norm)) invByBrand.set(norm, []);
    invByBrand.get(norm).push(item);
  }

  // Load all LIQUOR menu items
  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId: RESTAURANT_ID, menuType: "LIQUOR", isDeleted: false },
    select: { id: true, name: true, barInventoryItemId: true, deductionMl: true },
    orderBy: { name: "asc" },
  });
  console.log(`Menu items (LIQUOR, not deleted): ${menuItems.length}`);
  console.log(`Active inventory items: ${invItems.length}\n`);

  const actions = {
    alreadyLinked: [],    // already has a valid link
    brokenLink: [],       // linked to inactive/deleted item → needs relink
    linkedNow: [],        // newly linked (exact match)
    ambiguous: [],        // multiple candidates → needs manual selection
    noMatch: [],          // no inventory item found
    deductionFixed: [],   // link OK but deductionMl was wrong/null
  };

  // Load inactive inventory items for broken link check
  const inactiveItems = await prisma.barInventoryItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isActive: false },
    select: { id: true, name: true },
  });
  const inactiveIds = new Set(inactiveItems.map(i => i.id));

  // Build active inv item lookup by id (for deduction logic)
  const invById = new Map(invItems.map(i => [i.id, i]));

  // Determine the correct deductionMl for a menu item
  function getCorrectDeductionMl(menuItem, sizeMl, invItem) {
    // If size is in the name, use it
    if (sizeMl) return sizeMl;
    // No size in name — determine based on inventory category
    if (!invItem) return 30; // default peg
    const cat = invItem.category;
    if (cat === "Beer") return 650;
    if (cat === "Breezer") return 500;
    if (cat === "Wine") return 750; // full bottle by default
    // All liquor categories: default to 30ml peg
    return 30;
  }

  for (const mi of menuItems) {
    const sizeMl = parseMlFromName(mi.name);
    const normBrand = normalizeBrand(mi.name);
    const linkedInv = mi.barInventoryItemId ? invById.get(mi.barInventoryItemId) : null;
    const expectedDeductionMl = getCorrectDeductionMl(mi, sizeMl, linkedInv);

    // Check existing link
    if (mi.barInventoryItemId) {
      if (inactiveIds.has(mi.barInventoryItemId)) {
        // Broken link — points to deactivated item
        actions.brokenLink.push({ menuItem: mi, oldInvId: mi.barInventoryItemId, sizeMl, normBrand });
      } else {
        // Valid link — only fix deductionMl if it's null/unset
        // (don't override existing values — admin may have set them deliberately)
        if (mi.deductionMl === null) {
          actions.deductionFixed.push({ menuItem: mi, oldDeduction: mi.deductionMl, newDeduction: expectedDeductionMl });
        }
        actions.alreadyLinked.push(mi);
        continue;
      }
    }

    // Try to find a match
    // For full bottle sizes (650, 750): match by brand + exact size
    // For peg sizes (30, 60, 90, 180, 375): match by brand + exact size (the bottle of that size)
    // If no exact size match, try brand-only match (any bottle of same brand)

    if (!sizeMl) {
      // No size in name — try brand-only match
      const candidates = invByBrand.get(normBrand) || [];
      if (candidates.length === 1) {
        const deduct = getCorrectDeductionMl(mi, null, candidates[0]);
        actions.linkedNow.push({ menuItem: mi, invItem: candidates[0], deductionMl: deduct, matchType: "brand-only" });
      } else if (candidates.length > 1) {
        actions.ambiguous.push({ menuItem: mi, candidates, matchType: "brand-only" });
      } else {
        // No exact brand match — try fuzzy substring match
        const fuzzyMatches = [];
        for (const [invNorm, invItems] of invByBrand.entries()) {
          if (!invNorm) continue;
          if (invNorm.length >= 3 && (normBrand.includes(invNorm) || invNorm.includes(normBrand))) {
            fuzzyMatches.push(...invItems);
          }
        }
        if (fuzzyMatches.length === 1) {
          const deduct = getCorrectDeductionMl(mi, null, fuzzyMatches[0]);
          actions.linkedNow.push({ menuItem: mi, invItem: fuzzyMatches[0], deductionMl: deduct, matchType: "fuzzy-brand-only" });
        } else if (fuzzyMatches.length > 1) {
          actions.ambiguous.push({ menuItem: mi, candidates: fuzzyMatches, matchType: "fuzzy-brand-only" });
        } else {
          // Try brand alias mapping
          const alias = BRAND_ALIASES[normBrand];
          if (alias) {
            const aliasMatches = invByBrand.get(alias) || [];
            if (aliasMatches.length >= 1) {
              const defaultBottle = aliasMatches.find(b => b.bottleSizeMl === 750) || aliasMatches[0];
              const deduct = getCorrectDeductionMl(mi, null, defaultBottle);
              actions.linkedNow.push({ menuItem: mi, invItem: defaultBottle, deductionMl: deduct, matchType: "alias" });
            } else {
              actions.noMatch.push({ menuItem: mi, reason: "no brand match (alias not found)" });
            }
          } else {
            actions.noMatch.push({ menuItem: mi, reason: "no brand match" });
          }
        }
      }
      continue;
    }

    // Try exact brand + size match
    const key = `${normBrand}::${sizeMl}`;
    const exactMatches = invByNorm.get(key) || [];

    if (exactMatches.length === 1) {
      actions.linkedNow.push({ menuItem: mi, invItem: exactMatches[0], deductionMl: sizeMl, matchType: "exact" });
    } else if (exactMatches.length > 1) {
      actions.ambiguous.push({ menuItem: mi, candidates: exactMatches, matchType: "exact" });
    } else {
      // No exact size match — try brand-only (any bottle of same brand)
      const brandMatches = invByBrand.get(normBrand) || [];
      if (brandMatches.length >= 1) {
        // For peg sizes, link to the 750ml bottle (or first available) of same brand
        // The bottle picker will let the operator choose which bottle to pour from
        const defaultBottle = brandMatches.find(b => b.bottleSizeMl === 750) || brandMatches[0];
        actions.linkedNow.push({ menuItem: mi, invItem: defaultBottle, deductionMl: sizeMl, matchType: "brand-default" });
      } else {
        // No exact brand match — try fuzzy substring match
        // Excel brands are often shorter than menu names (e.g., "8PM" vs "8PM Premium Black")
        const fuzzyMatches = [];
        for (const [invNorm, invItems] of invByBrand.entries()) {
          if (!invNorm) continue;
          // Check if either is a substring of the other (with min length to avoid false positives)
          if (invNorm.length >= 3 && (normBrand.includes(invNorm) || invNorm.includes(normBrand))) {
            fuzzyMatches.push(...invItems);
          }
        }
        if (fuzzyMatches.length >= 1) {
          const defaultBottle = fuzzyMatches.find(b => b.bottleSizeMl === 750) || fuzzyMatches[0];
          actions.linkedNow.push({ menuItem: mi, invItem: defaultBottle, deductionMl: sizeMl, matchType: "fuzzy" });
        } else {
          // Try brand alias mapping
          const alias = BRAND_ALIASES[normBrand];
          if (alias) {
            const aliasMatches = invByBrand.get(alias) || [];
            if (aliasMatches.length >= 1) {
              const defaultBottle = aliasMatches.find(b => b.bottleSizeMl === 750) || aliasMatches[0];
              actions.linkedNow.push({ menuItem: mi, invItem: defaultBottle, deductionMl: sizeMl, matchType: "alias" });
            } else {
              actions.noMatch.push({ menuItem: mi, reason: `no match for "${normBrand}" (alias not found)` });
            }
          } else {
            // Try Levenshtein distance matching (close spelling variations)
            let bestMatch = null;
            let bestDist = Infinity;
            for (const [invNorm, invItems] of invByBrand.entries()) {
              if (!invNorm || invNorm.length < 3) continue;
              const dist = levenshtein(normBrand, invNorm);
              const maxDist = Math.max(1, Math.floor(Math.max(normBrand.length, invNorm.length) * 0.25));
              if (dist <= maxDist && dist < bestDist) {
                bestDist = dist;
                bestMatch = invItems;
              }
            }
            if (bestMatch && bestMatch.length >= 1) {
              const defaultBottle = bestMatch.find(b => b.bottleSizeMl === 750) || bestMatch[0];
              actions.linkedNow.push({ menuItem: mi, invItem: defaultBottle, deductionMl: sizeMl, matchType: "levenshtein" });
            } else {
              actions.noMatch.push({ menuItem: mi, reason: `no match for "${normBrand}"` });
            }
          }
        }
      }
    }
  }

  // Print report
  console.log(`${"─".repeat(80)}`);
  console.log(`ACTION SUMMARY`);
  console.log(`${"─".repeat(80)}`);
  console.log(`  Already linked (valid):     ${actions.alreadyLinked.length}`);
  console.log(`  Broken link (relink):       ${actions.brokenLink.length}`);
  console.log(`  Newly linked:               ${actions.linkedNow.length}`);
  console.log(`  Ambiguous (manual):         ${actions.ambiguous.length}`);
  console.log(`  No match:                   ${actions.noMatch.length}`);
  console.log(`  Deduction fix needed:       ${actions.deductionFixed.length}`);
  console.log();

  if (actions.brokenLink.length > 0) {
    console.log(`\nBROKEN LINKS (point to deactivated items):`);
    for (const b of actions.brokenLink) {
      const oldName = inactiveItems.find(i => i.id === b.oldInvId)?.name || "?";
      console.log(`  "${b.menuItem.name}" → was linked to inactive "${oldName}"`);
    }
  }

  if (actions.linkedNow.length > 0) {
    console.log(`\nNEWLY LINKED:`);
    for (const l of actions.linkedNow) {
      console.log(`  "${l.menuItem.name}" → "${l.invItem.name}" (${l.matchType}, deduct ${l.deductionMl}ml)`);
    }
  }

  if (actions.deductionFixed.length > 0) {
    console.log(`\nDEDUCTION FIXES:`);
    for (const d of actions.deductionFixed) {
      console.log(`  "${d.menuItem.name}" | deductionMl: ${d.oldDeduction} → ${d.newDeduction}`);
    }
  }

  if (actions.ambiguous.length > 0) {
    console.log(`\nAMBIGUOUS (multiple candidates — needs manual selection):`);
    for (const a of actions.ambiguous) {
      console.log(`  "${a.menuItem.name}" (${a.matchType}):`);
      for (const c of a.candidates) {
        console.log(`    → "${c.name}" (size=${c.bottleSizeMl}ml, id=${c.id.slice(-8)})`);
      }
    }
  }

  if (actions.noMatch.length > 0) {
    console.log(`\nNO MATCH:`);
    for (const n of actions.noMatch) {
      console.log(`  "${n.menuItem.name}" — ${n.reason}`);
    }
  }

  if (!APPLY) {
    console.log(`\n${"=".repeat(80)}\nDRY RUN — no changes. Run with --apply to execute.\n${"=".repeat(80)}`);
    await prisma.$disconnect();
    return;
  }

  // APPLY
  console.log(`\n${"=".repeat(80)}\nAPPLYING...\n${"=".repeat(80)}`);
  let linked = 0, fixed = 0, relinked = 0;
  const errors = [];

  // Relink broken links + newly linked
  for (const l of [...actions.linkedNow, ...actions.brokenLink.map(b => {
    // Try to find a new match for broken links
    const sizeMl = b.sizeMl;
    const normBrand = b.normBrand;
    if (sizeMl) {
      const exact = (invByNorm.get(`${normBrand}::${sizeMl}`) || [])[0];
      if (exact) return { menuItem: b.menuItem, invItem: exact, deductionMl: sizeMl, matchType: "relink-exact" };
    }
    const brand = (invByBrand.get(normBrand) || []);
    const def = brand.find(b => b.bottleSizeMl === 750) || brand[0];
    if (def) return { menuItem: b.menuItem, invItem: def, deductionMl: sizeMl || 30, matchType: "relink-brand" };
    return null;
  })].filter(Boolean)) {
    try {
      await prisma.menuItem.update({
        where: { id: l.menuItem.id },
        data: { barInventoryItemId: l.invItem.id, deductionMl: l.deductionMl },
      });
      if (l.matchType?.startsWith("relink")) relinked++; else linked++;
    } catch (e) { errors.push(`LINK ${l.menuItem.name}: ${e.message}`); }
  }

  // Fix deductions on already-linked items
  for (const d of actions.deductionFixed) {
    try {
      await prisma.menuItem.update({
        where: { id: d.menuItem.id },
        data: { deductionMl: d.newDeduction },
      });
      fixed++;
    } catch (e) { errors.push(`DEDUCT ${d.menuItem.name}: ${e.message}`); }
  }

  console.log(`\nAPPLY COMPLETE`);
  console.log(`  Newly linked:    ${linked}`);
  console.log(`  Relinked:        ${relinked}`);
  console.log(`  Deductions fixed: ${fixed}`);
  if (errors.length > 0) { console.log(`  Errors: ${errors.length}`); for (const e of errors) console.log(`    ${e}`); }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error("FATAL:", e.message); await prisma.$disconnect(); process.exit(1); });
