/**
 * testApiResponse.ts
 * Calls the /api/venue/all-prices endpoint to see what it returns
 */

import fetch from "node-fetch";

async function main() {
  const API_BASE = "http://localhost:3001"; // Change to your Render URL if needed

  console.log("[Test] Calling /api/venue/all-prices...\n");

  try {
    const res = await fetch(`${API_BASE}/api/venue/all-prices`);
    const data = await res.json();

    console.log("Response status:", res.status);
    console.log("Response keys:", Object.keys(data));
    console.log("\nSample data:");
    for (const venueId of Object.keys(data).slice(0, 3)) {
      const prices = data[venueId];
      const itemIds = Object.keys(prices);
      console.log(`  ${venueId}: ${itemIds.length} items`);
      if (itemIds.length > 0) {
        console.log(`    First item: ${itemIds[0]} -> ₹${prices[itemIds[0]]}`);
      }
    }
  } catch (err) {
    console.error("[Test] Error:", err);
  }
}

main();
