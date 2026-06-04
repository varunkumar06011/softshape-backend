import "dotenv/config";
import { createServer } from "http";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { Server } from "socket.io";
import menuRouter from "./routes/menu";
import ordersRouter from "./routes/orders";
import sectionsRouter from "./routes/sections";
import tablesRouter from "./routes/tables";
import transactionRoutes from "./routes/transactions";
import barMenuRouter from "./routes/barMenu";
import barTablesRouter from "./routes/barTables";
import barInventoryRouter from "./routes/barInventory";
import printRouter from "./routes/print";
import captainAssignmentsRouter from "./routes/captainAssignments";
import captainTargetsRouter from "./routes/captainTargets";
import analyticsRouter from "./routes/analytics";
import reportsRouter from "./routes/reports";
import venueRouter from "./routes/venue";
import { setIo } from "./socket";
import { autoSeedIfEmpty } from "./seed";
import prisma from "./lib/prisma";
import rateLimit from "express-rate-limit";


process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});

const DEFAULT_ALLOWED_ORIGINS = [
  "https://softshape-backend.onrender.com",
  "https://softshapeai.vercel.app",
  "https://softshape-ai.vercel.app",
  "https://softshape-ai-demo.vercel.app",
  "https://softshape.ai",
  "https://www.softshape.ai",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://localhost:5174",
];

function getAllowedOrigins(): string[] {
  const configured = process.env.CORS_ORIGIN ?? process.env.ALLOWED_ORIGINS ?? "";
  return Array.from(
    new Set([
      ...DEFAULT_ALLOWED_ORIGINS,
      ...configured
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ])
  );
}

function isAllowedOrigin(origin: string): boolean {
  if (getAllowedOrigins().includes(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === "https:" && hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

const corsOrigin: cors.CorsOptions["origin"] = (origin, callback) => {
  if (!origin || isAllowedOrigin(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`CORS blocked origin: ${origin}`));
};

// Required env vars: DATABASE_URL, DIRECT_URL (Supabase). PORT is set by Render at runtime.
const corsOptions: cors.CorsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma", "X-Requested-With"],
  optionsSuccessStatus: 200,
};

const app = express();
const httpServer = createServer(app);

app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// General API rate limit — 300 requests per minute per IP
// A restaurant with 10 captains all actively using the app generates ~60 req/min max
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
  skip: (req: Request) => req.path === "/health", // never rate-limit health checks
});

// Tighter limit for order creation — prevents retry storms
const orderCreateLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 30,
  message: { error: "Too many orders in a short time, please wait a moment" },
});

app.use("/api/", apiLimiter);
app.use("/api/orders", orderCreateLimiter); // only applies to POST /api/orders

app.get("/", (_req, res) => {
  res.json({ service: "softshape-backend", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ─── Socket.io Configuration ─────────────────────────────────────────
// Railway's reverse proxy needs specific Socket.io settings to avoid 502:
//  1. addTrailingSlash: false — prevents path mismatch with Railway's proxy
//  2. transports: polling first — Railway proxy handles polling reliably,
//     websocket upgrade can happen after initial polling handshake
//  3. path without trailing slash
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma", "X-Requested-With"],
  },
  // Railway proxy-friendly settings
  addTrailingSlash: false,
  transports: ["websocket", "polling"],
  allowEIO3: true,
  path: "/socket.io",
  pingTimeout: 60000,
  pingInterval: 25000,
  // Allow upgrades from polling to websocket
  allowUpgrades: true,
  // Increase HTTP long-polling timeout for Railway
  httpCompression: true,
  maxHttpBufferSize: 1e7,
});

setIo(io);

app.use("/api/menu", menuRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/sections", sectionsRouter);
app.use("/api/tables", tablesRouter);
app.use("/api/transactions", transactionRoutes);
app.use("/api/bar/menu", barMenuRouter);
app.use("/api/bar/tables", barTablesRouter);
app.use("/api/bar/inventory", barInventoryRouter);
app.use("/api/print", printRouter);
app.use("/api/captain-assignments", captainAssignmentsRouter);
app.use("/api/captain-targets", captainTargetsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/venue", venueRouter);

io.on("connection", (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id} (transport: ${socket.conn.transport.name})`);

  socket.conn.on("upgrade", (transport: { name: string }) => {
    console.log(`[Socket.io] ${socket.id} upgraded to ${transport.name}`);
  });

  socket.on("join", (restaurantId: unknown) => {
    if (typeof restaurantId !== "string" || !restaurantId.trim()) return;
    const room = restaurantId.trim();
    // Prevent duplicate room membership on reconnect
    if (socket.rooms.has(room)) {
      console.log(`[Socket.io] ${socket.id} already in room ${room} — skipping duplicate join`);
      return;
    }
    socket.join(room);
    console.log(`[Socket.io] ${socket.id} joined restaurant room ${room}`);
  });

  // Dedicated print room — only PrintStation subscribes here.
  // Captain/cashier sockets join the plain restaurant room above but
  // never join this room, so print_job events are delivered exactly once.
  socket.on("join:print", (restaurantId: unknown) => {
    if (typeof restaurantId !== "string" || !restaurantId.trim()) return;
    const room = `print:${restaurantId.trim()}`;
    if (socket.rooms.has(room)) {
      console.log(`[Socket.io] ${socket.id} already in print room ${room} — skipping`);
      return;
    }
    socket.join(room);
    console.log(`[Socket.io] ${socket.id} joined print room ${room}`);
  });

  // Relay waiter calls and actions to other sockets in the restaurant room
  socket.on("waiter:event", (data: any) => {
    if (!data || typeof data.restaurantId !== "string" || !data.type) {
      console.warn(`[Socket.io] waiter:event rejected — invalid data from ${socket.id}:`, data);
      return;
    }
    const room = data.restaurantId.trim();

    // Auto-join sender to room if not already a member (handles race conditions)
    if (!socket.rooms.has(room)) {
      console.warn(`[Socket.io] waiter:event sender ${socket.id} was NOT in room ${room} — auto-joining`);
      socket.join(room);
    }

    // Count how many OTHER sockets are in this room to aid debugging
    const roomSockets = io.sockets.adapter.rooms.get(room);
    const recipientCount = roomSockets ? roomSockets.size - 1 : 0; // exclude sender

    console.log(
      `[Socket.io] waiter:event [${data.type}] from ${socket.id} → room ${room} ` +
      `(${recipientCount} recipient(s), payload: ${JSON.stringify(data.payload)})`
    );

    socket.to(room).emit("waiter:event", { type: data.type, payload: data.payload });
  });

  socket.on("disconnect", () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  console.error("[Error]", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message });
});

const PORT = Number(process.env.PORT) || 3000;

console.log(`[Startup] NODE_ENV=${process.env.NODE_ENV}`);
console.log(`[Startup] PORT env=${process.env.PORT} → listening on ${PORT}`);
console.log(`[Startup] DATABASE_URL set=${Boolean(process.env.DATABASE_URL)}`);
console.log(`[Startup] CORS allowed origins=${getAllowedOrigins().join(", ")} + https://*.vercel.app`);

// Startup DB column probe — catches schema/migration drift immediately at boot
async function probeDbSchema() {
  const checks = [
    { query: `SELECT "unit" FROM "MenuItem" LIMIT 0`, name: "MenuItem.unit" },
    { query: `SELECT "sectionTag" FROM "Table" LIMIT 0`, name: "Table.sectionTag" },
    { query: `SELECT "inventoryDeducted" FROM "Order" LIMIT 0`, name: "Order.inventoryDeducted" },
    { query: `SELECT 1 FROM "VenuePrice" LIMIT 0`, name: "VenuePrice table" },
  ];

  for (const check of checks) {
    try {
      await prisma.$queryRawUnsafe(check.query);
      console.log(`[DB] Schema probe OK — ${check.name} confirmed`);
    } catch (e: any) {
      console.error(`[DB] FATAL: ${check.name} missing from database.`);
      console.error('[DB] Run: npx prisma migrate deploy');
      console.error('[DB] Raw error:', e.message);
      process.exit(1); // Fail fast at startup rather than runtime
    }
  }
}

probeDbSchema(); // fire-and-forget; exits process if any column/table is missing

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[Startup] Server running on 0.0.0.0:${PORT}`);
  // Auto-seed menu + tables from menu.txt if the DB is empty
  autoSeedIfEmpty(prisma).catch((err) => {
    console.error("[Startup] autoSeedIfEmpty error:", err);
  });
});
