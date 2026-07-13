import fs from "fs";
import { Prisma } from "@prisma/client";
import prisma from "../src/lib/prisma";

type MenuItemWithVariants = Prisma.MenuItemGetPayload<{ include: { category: true; variants: true } }>;

const RESTAURANTS = [
  { id: "cmqy60ci200027dscyj9ubg8h", name: "Vgrand Lounge" },
  { id: "cmr03m0fa00015ot8jh16grhn", name: "Vgrand Family Restaurant" },
];

const CATEGORY_BASE_KEYS = [
  "soups", "starters", "biryani", "fried rice", "noodles", "rice",
  "curries", "indian breads", "tandoori", "ice cream", "milkshakes & lassi",
];

const BAR_CATEGORIES = ["liquor", "cocktails & mocktails"];

const PROTEIN_KEYWORDS: { label: string; patterns: string[] }[] = [
  { label: "Chicken", patterns: ["chicken", "kodi"] },
  { label: "Mutton", patterns: ["mutton", "gosht"] },
  { label: "Egg", patterns: ["egg"] },
  { label: "Prawns", patterns: ["prawn", "royyala"] },
  { label: "Fish", patterns: ["fish"] },
  { label: "Paneer", patterns: ["paneer"] },
  { label: "Veg", patterns: ["veg"] },
];

const NAME_PATTERNS = [
  "chicken", "mutton", "fish", "prawn", "paneer", "aloo", "gobi",
  "manchurian", "schezwan", "65", "kadai", "shahi", "kurma", "korma",
  "malai", "kofta", "mughlai", "afghani", "bajji", "palak", "mushroom",
  "matar", "methi", "dal",
];

function matchCategoryBase(cat: string): string | null {
  const lower = cat.toLowerCase().trim();
  for (const key of CATEGORY_BASE_KEYS) {
    if (lower.includes(key)) return key;
  }
  return null;
}

function isBarCategory(cat: string): boolean {
  const lower = cat.toLowerCase().trim();
  return BAR_CATEGORIES.some((b) => lower.includes(b));
}

function detectProteins(name: string): string[] {
  const n = name.toLowerCase();
  const found: string[] = [];
  for (const pk of PROTEIN_KEYWORDS) {
    if (pk.patterns.some((p) => n.includes(p))) found.push(pk.label);
  }
  return found;
}

function formatPrice(item: MenuItemWithVariants): string {
  const price = item.variants[0]?.price;
  return price !== undefined ? `₹${Number(price)}` : "no price";
}

function hasNamePattern(name: string): boolean {
  const n = name.toLowerCase();
  return NAME_PATTERNS.some((p) => n.includes(p));
}

async function buildReport(restaurantId: string, label: string): Promise<string> {
  let out = `\n========================================\n`;
  out += `  ${label} (${restaurantId})\n`;
  out += `========================================\n`;

  const rawItems = await prisma.menuItem.findMany({
    where: { restaurantId, isDeleted: false, menuType: "FOOD" },
    include: { category: true, variants: true },
    orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
  });

  const items = rawItems.filter((item) => !isBarCategory(item.category?.name ?? ""));
  const totalFoodItems = items.length;
  out += `\nTotal FOOD items: ${totalFoodItems}\n`;

  // Group by category
  const byCategory = new Map<string, MenuItemWithVariants[]>();
  for (const item of items) {
    const catName = item.category?.name ?? "(no category)";
    if (!byCategory.has(catName)) byCategory.set(catName, []);
    byCategory.get(catName)!.push(item);
  }

  // (a) & (b) category coverage
  out += `\n--- (a) Category coverage ---\n`;
  out += `Covered = has a CATEGORY_BASES template today.\n\n`;
  const coveredCategories: { name: string; baseKey: string; count: number }[] = [];
  const uncoveredCategories: { name: string; count: number }[] = [];

  for (const [catName, catItems] of byCategory) {
    const baseKey = matchCategoryBase(catName);
    if (baseKey) {
      coveredCategories.push({ name: catName, baseKey, count: catItems.length });
    } else {
      uncoveredCategories.push({ name: catName, count: catItems.length });
    }
  }

  coveredCategories.sort((a, b) => a.name.localeCompare(b.name));
  uncoveredCategories.sort((a, b) => a.name.localeCompare(b.name));

  out += `COVERED categories (${coveredCategories.length}):\n`;
  for (const c of coveredCategories) {
    out += `  - ${c.name} -> ${c.count} items (base: ${c.baseKey})\n`;
  }

  out += `\nUNCOVERED categories (${uncoveredCategories.length}) — need sign-off before template added:\n`;
  for (const c of uncoveredCategories) {
    out += `  - ${c.name} -> ${c.count} items\n`;
  }

  // (b) detailed list of uncovered category items
  out += `\n--- (b) Items in uncovered categories ---\n`;
  if (uncoveredCategories.length === 0) {
    out += `None.\n`;
  } else {
    for (const c of uncoveredCategories) {
      out += `\n${c.name} (${c.count} items):\n`;
      for (const item of byCategory.get(c.name)!) {
        out += `  - ${item.name} (price: ${formatPrice(item)})\n`;
      }
    }
  }

  // (c) covered categories with protein keywords
  out += `\n--- (c) Protein-keyword counts within covered categories ---\n`;
  for (const c of coveredCategories) {
    const catItems = byCategory.get(c.name)!;
    const proteinBuckets = new Map<string, MenuItemWithVariants[]>();
    const noProteinItems: MenuItemWithVariants[] = [];

    for (const item of catItems) {
      const proteins = detectProteins(item.name);
      if (proteins.length === 0) {
        noProteinItems.push(item);
      } else {
        for (const p of proteins) {
          if (!proteinBuckets.has(p)) proteinBuckets.set(p, []);
          proteinBuckets.get(p)!.push(item);
        }
      }
    }

    if (proteinBuckets.size === 0) continue;
    out += `\n${c.name} (base: ${c.baseKey}, total ${catItems.length}):\n`;
    const sortedProteins = Array.from(proteinBuckets.keys()).sort();
    for (const p of sortedProteins) {
      const bucket = proteinBuckets.get(p)!;
      out += `  ${p} (${bucket.length} items):\n`;
      for (const item of bucket) {
        out += `    - ${item.name}\n`;
      }
    }
    if (noProteinItems.length > 0) {
      out += `  (no protein keyword) (${noProteinItems.length} items):\n`;
      for (const item of noProteinItems.slice(0, 20)) {
        out += `    - ${item.name}\n`;
      }
      if (noProteinItems.length > 20) {
        out += `    ... and ${noProteinItems.length - 20} more\n`;
      }
    }
  }

  // (d) unresolved items - neither category base nor name pattern
  out += `\n--- (d) Unresolved items (no category template AND no name pattern) ---\n`;
  out += `These require manual category/template assignment before any recipe generation.\n\n`;
  let unresolvedCount = 0;
  for (const item of items) {
    const catName = item.category?.name ?? "(no category)";
    const baseKey = matchCategoryBase(catName);
    const hasPattern = hasNamePattern(item.name);
    if (!baseKey && !hasPattern) {
      unresolvedCount++;
      out += `  - ${item.name} [category: ${catName}, price: ${formatPrice(item)}]\n`;
    }
  }
  if (unresolvedCount === 0) out += `None.\n`;
  else out += `\nTotal unresolved: ${unresolvedCount}\n`;

  return out;
}

async function main() {
  let fullReport = "PHASE 1 — FOOD MENU DISCOVERY REPORT\n";
  fullReport += "Scope: Vgrand Lounge + Vgrand Family Restaurant, menuType=FOOD only.\n";
  fullReport += "Bar items are explicitly excluded.\n";
  for (const r of RESTAURANTS) fullReport += await buildReport(r.id, r.name);
  fs.writeFileSync("dev-scripts/phase1_discovery_report.txt", fullReport);
  console.log("Report written to dev-scripts/phase1_discovery_report.txt");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); prisma.$disconnect(); });
