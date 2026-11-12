// ─────────────────────────────────────────────────────────────────────────────
// Guard: venue prices are written in ONE place (ADR-0008)
// ─────────────────────────────────────────────────────────────────────────────
// A billing PC bills from VenuePrice; the admin panel reads PriceProfileItem.
// Writing one without the other is exactly what made the KOT/table/bill show
// different prices. New code must call lib/priceResolver (setVenueItemPrice /
// mirrorPriceListToVenues) instead of writing these tables directly.
// If this test fails: route your write through priceResolver — do not just add
// your file to the list below.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "..");

// Existing, reviewed writers. Each one also keeps VenuePrice in step.
const ALLOWED = new Set([
  "lib/priceResolver.ts",   // the helpers themselves
  "routes/edge.ts",         // prices sent up by a billing PC (writes both)
  "routes/menu.ts",         // bulk import → mirrorImportedPrices
  "routes/venues.ts",       // price-list editor → mirrorPriceListToVenues
  "routes/onboard.ts",      // new outlet: first price lists
  "routes/restaurant.ts",   // new outlet: default price list
]);

const WRITE = /\b(priceProfileItem|venuePrice)\.(upsert|create|createMany|update|updateMany|delete|deleteMany)\s*\(/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|js)$/.test(e.name) && !/\.test\.(ts|js)$/.test(e.name) ? [p] : [];
  });
}

describe("venue price writes", () => {
  it("only go through lib/priceResolver (or the reviewed files)", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      if (ALLOWED.has(rel)) continue;
      fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (WRITE.test(line) && !line.trim().startsWith("//")) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `Write prices via lib/priceResolver:\n${offenders.join("\n")}`).toEqual([]);
  });
});
