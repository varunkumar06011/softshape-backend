import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
const AGENT_JWT_SECRET = "dev-only-agent-secret";

async function main() {
  // Find restaurants
  const restaurants = await prisma.outlet.findMany({
    select: { id: true, name: true, restaurantCode: true },
    take: 10,
  });

  console.log("=== Restaurants ===");
  for (const r of restaurants) {
    const tableCount = await prisma.table.count({ where: { restaurantId: r.id } });
    const menuItemCount = await prisma.menuItem.count({ where: { restaurantId: r.id } });
    const orderCount = await prisma.order.count({ where: { restaurantId: r.id } });
    console.log(`  ${r.name} (${r.restaurantCode}): tables=${tableCount}, menuItems=${menuItemCount}, orders=${orderCount}`);
  }

  // Pick the restaurant with the most orders
  let best = null;
  let maxOrders = -1;
  for (const r of restaurants) {
    const orderCount = await prisma.order.count({ where: { restaurantId: r.id } });
    if (orderCount > maxOrders) {
      maxOrders = orderCount;
      best = r;
    }
  }

  if (!best) {
    console.log("No restaurants found");
    return;
  }

  console.log(`\n=== Selected: ${best.name} (${best.restaurantCode}) id=${best.id} orders=${maxOrders} ===`);

  // Generate a setup token
  const setupToken = jwt.sign(
    { restaurantId: best.id, purpose: "agent-setup", restaurantCode: best.restaurantCode },
    AGENT_JWT_SECRET,
    { expiresIn: "1h" }
  );

  // Register the edge server locally (it will forward to cloud)
  const edgeRegisterRes = await fetch("http://localhost:3101/api/edge/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      setupToken,
      backendUrl: "http://localhost:3000",
      restaurantCode: best.restaurantCode,
    }),
  });

  console.log("\nEdge register status:", edgeRegisterRes.status);
  const edgeRegisterData = await edgeRegisterRes.json();
  if (!edgeRegisterRes.ok) {
    console.log("Edge register error:", JSON.stringify(edgeRegisterData));
    return;
  }
  console.log("Edge register success:", JSON.stringify({
    restaurantId: edgeRegisterData.restaurantId,
    restaurantName: edgeRegisterData.restaurantName,
    runtimeToken: edgeRegisterData.runtimeToken?.substring(0, 20) + "...",
  }));

  // Trigger config sync
  const token = edgeRegisterData.runtimeToken;
  console.log("\nTriggering config sync...");
  const syncRes = await fetch("http://localhost:3101/api/edge/config/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  console.log("Config sync status:", syncRes.status);
  const syncData = await syncRes.json();
  console.log("Config sync result:", JSON.stringify(syncData).substring(0, 500));
}

main().catch(console.error).finally(() => prisma.$disconnect());
