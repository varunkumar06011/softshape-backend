import express from "express";
import menuRouter from "../routes/menu";
import ordersRouter from "../routes/orders";
import sectionsRouter from "../routes/sections";
import tablesRouter from "../routes/tables";
import transactionRoutes from "../routes/transactions";
import barMenuRouter from "../routes/barMenu";
import barTablesRouter from "../routes/barTables";
import barInventoryRouter from "../routes/barInventory";
import printRouter from "../routes/print";
import captainAssignmentsRouter from "../routes/captainAssignments";
import captainTargetsRouter from "../routes/captainTargets";
import analyticsRouter from "../routes/analytics";
import reportsRouter from "../routes/reports";
import venueRouter from "../routes/venue";
import statsRouter from "../routes/stats";
import { onboardRouter } from "../routes/onboard";
import { authRouter } from "../routes/auth";
import { restaurantRouter } from "../routes/restaurant";
import { authenticate } from "../middleware/auth";

export function createTestApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Mount routes exactly as in production index.ts
  app.use("/api/menu", authenticate, menuRouter);
  app.use("/api/orders", authenticate, ordersRouter);
  app.use("/api/sections", sectionsRouter);
  app.use("/api/tables", authenticate, tablesRouter);
  app.use("/api/transactions", authenticate, transactionRoutes);
  app.use("/api/bar/menu", barMenuRouter);
  app.use("/api/bar/tables", barTablesRouter);
  app.use("/api/bar/inventory", barInventoryRouter);
  app.use("/api/print", authenticate, printRouter);
  app.use("/api/captain-assignments", captainAssignmentsRouter);
  app.use("/api/captain-targets", captainTargetsRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/reports", authenticate, reportsRouter);
  app.use("/api/venue", authenticate, venueRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/onboard", onboardRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/restaurant", restaurantRouter);

  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("[Test Error]", err.message);
    if (res.headersSent) return;
    res.status(500).json({ error: err.message });
  });

  return app;
}
