/**
 * debugNameMatching.ts
 * Checks how CSV names match to DB menu items
 */

import prisma from "../lib/prisma";
import * as fs from "fs";
import * as path from "path";

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const CSV_PATH = path.resolve(__dirname, "../../../Softshapeai/RATES BAR (1) - Sheet1 (2).csv");
  const raw = fs.readFileSync(CSV_PATH, "utf-8");
  const rows = raw.split(/\r?\n/).map(line => line.split(","));

  const headerRowIdx = rows.findIndex(r => r.some(c => c.toLowerCase().includes("bar ac hall")));
  const dataRows = rows.slice(headerRowIdx + 1).filter(r => (r[1] || "").trim().length > 0);

  const BAR_ID = "bar-001";
  const dbItems = await prisma.menuItem.findMany({
    where: { restaurantId: BAR_ID, isDeleted: false },
    select: { id: true, name: true },
  });

  const nameMap = new Map<string, string>();
  for (const item of dbItems) {
    const key = norm(item.name);
    if (!nameMap.has(key)) nameMap.set(key, item.id);
  }

  console.log("[Debug] First 10 CSV rows and their DB matches:\n");
  for (let i = 0; i < Math.min(10, dataRows.length); i++) {
    const csvName = (dataRows[i][1] || "").trim();
    const dbId = nameMap.get(norm(csvName));
    const dbItem = dbItems.find(item => item.id === dbId);
    console.log(`CSV: "${csvName}"`);
    console.log(`  Matched DB ID: ${dbId || 'NONE'}`);
    console.log(`  DB Item: ${dbItem?.name || 'NONE'}`);
    console.log();
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error("[Debug] Fatal error:", err);
  process.exit(1);
});
