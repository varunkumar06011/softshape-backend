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
import statsRouter from "./routes/stats";
import { onboardRouter } from "./routes/onboard";
import { authRouter } from "./routes/auth";
import { restaurantRouter } from "./routes/restaurant";
import { authenticate, optionalAuth, requireRole } from "./middleware/auth";
import { withTenantContext } from "./middleware/tenantContext";
import { assertTenantScope } from "./middleware/tenantScope";
import { verifyToken } from "./lib/auth";
import jwt from "jsonwebtoken";
import { setIo } from "./socket";
import { autoSeedIfEmpty } from "./seed";
import prisma, { basePrisma } from "./lib/prisma";
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
app.set('trust proxy', 1); // Render/Railway reverse proxy — enables accurate req.ip for rate limiting
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

// Tighter limit for order creation only (POST) — prevents retry storms
// Keyed per restaurantId so all captains in one restaurant share a single bucket,
// rather than per-IP which unfairly groups unrelated restaurants on shared NAT.
const orderCreateLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 60,  // 10 captains × ~6 orders/10s = 60; was 30 which caused false positives
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: "Too many orders in a short time, please wait a moment" },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/", apiLimiter);
// Apply order-creation limiter to POST only — PATCH/GET must never be blocked by this guard
app.post("/api/orders", orderCreateLimiter);

app.get("/", (_req, res) => {
  res.json({ service: "softshape-backend", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "connected", ts: Date.now() });
  } catch (err: any) {
    res.status(503).json({ ok: false, db: "disconnected", error: err.message, ts: Date.now() });
  }
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
  pingTimeout: 180000,   // 3 min — extra headroom for slow mobile networks during peak hours
  pingInterval: 25000,   // 25s — slightly faster detection of dead connections
  connectTimeout: 60000, // 60s — allow Railway proxy cold-start handshake to complete
  // Allow upgrades from polling to websocket
  allowUpgrades: true,
  // Increase HTTP long-polling timeout for Railway
  httpCompression: true,
  maxHttpBufferSize: 1e7,
});

setIo(io);

// ── Print Job Buffer for Reconnect Recovery ────────────────────────────────
const recentPrintJobs = new Map<string, Array<{ payload: any; ts: number; eventId: string }>>();
const PRINT_JOB_TTL_MS = 3 * 60_000;  // 3 minutes — covers longer PrintStation reconnections
const printedEventIds = new Set<string>(); // Server-side dedup lock

export function bufferPrintJob(restaurantId: string, payload: any): void {
  if (!recentPrintJobs.has(restaurantId)) recentPrintJobs.set(restaurantId, []);
  const buf = recentPrintJobs.get(restaurantId)!;
  const eventId = payload.eventId || String(Date.now());
  buf.push({ payload, ts: Date.now(), eventId });
  // Trim old entries
  const cutoff = Date.now() - PRINT_JOB_TTL_MS;
  recentPrintJobs.set(restaurantId, buf.filter(j => j.ts >= cutoff));
  // Also trim printedEventIds to prevent unbounded growth
  const allEventIds = [...printedEventIds];
  if (allEventIds.length > 1000) {
    printedEventIds.clear();
    // Keep only recent eventIds from buffer
    for (const buf of recentPrintJobs.values()) {
      for (const job of buf) {
        printedEventIds.add(job.eventId);
      }
    }
  }
}

export function getRecentPrintJobs(restaurantId: string): Array<{ payload: any; ts: number; eventId: string }> {
  const now = Date.now();
  return (recentPrintJobs.get(restaurantId) || []).filter(j => now - j.ts < PRINT_JOB_TTL_MS);
}

export function markEventIdPrinted(eventId: string): void {
  printedEventIds.add(eventId);
}

app.use("/api/menu", optionalAuth, menuRouter);
app.use("/api/orders", authenticate, assertTenantScope, withTenantContext, ordersRouter);
app.use("/api/sections", authenticate, assertTenantScope, withTenantContext, sectionsRouter);
app.use("/api/tables", authenticate, assertTenantScope, withTenantContext, tablesRouter);
app.use("/api/transactions", authenticate, assertTenantScope, withTenantContext, transactionRoutes);
app.use("/api/bar/menu", authenticate, assertTenantScope, withTenantContext, barMenuRouter);
app.use("/api/bar/tables", authenticate, assertTenantScope, withTenantContext, barTablesRouter);
app.use("/api/bar/inventory", authenticate, assertTenantScope, withTenantContext, barInventoryRouter);
app.use("/api/print", optionalAuth, printRouter);
app.use("/api/captain-assignments", authenticate, assertTenantScope, withTenantContext, captainAssignmentsRouter);
app.use("/api/captain-targets", authenticate, assertTenantScope, withTenantContext, captainTargetsRouter);
app.use("/api/analytics", authenticate, assertTenantScope, withTenantContext, analyticsRouter);
app.use("/api/reports", authenticate, assertTenantScope, withTenantContext, reportsRouter);
app.use("/api/venue", optionalAuth, venueRouter);
app.use("/api/stats", authenticate, assertTenantScope, withTenantContext, statsRouter);
app.use("/api/onboard", onboardRouter);
app.use("/api/auth", authRouter);
app.use("/api/restaurant", restaurantRouter);

io.on("connection", (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id} (transport: ${socket.conn.transport.name})`);

  socket.conn.on("upgrade", (transport: { name: string }) => {
    console.log(`[Socket.io] ${socket.id} upgraded to ${transport.name}`);
  });

  socket.on("join", async (restaurantId: unknown) => {
    if (typeof restaurantId !== "string" || !restaurantId.trim()) return;
    const room = restaurantId.trim();

    // Validate JWT from socket handshake auth
    const token = (socket.handshake.auth as any)?.token;
    if (!token) {
      console.warn(`[Socket.io] ${socket.id} join rejected — no token`);
      socket.emit("auth:error", { message: "Authentication required" });
      return;
    }

    let decoded: any;
    try {
      decoded = verifyToken(token);
    } catch {
      console.warn(`[Socket.io] ${socket.id} join rejected — invalid token`);
      socket.emit("auth:error", { message: "Token invalid or expired" });
      return;
    }

    // Validate that the requested room belongs to the authenticated tenant
    if (decoded.restaurantId !== room) {
      console.warn(`[Socket.io] ${socket.id} join rejected — cross-tenant access to ${room}`);
      socket.emit("auth:error", { message: "Access denied to this restaurant room" });
      return;
    }

    // Prevent duplicate room membership on reconnect
    if (socket.rooms.has(room)) {
      console.log(`[Socket.io] ${socket.id} already in room ${room} — skipping duplicate join`);
      return;
    }
    socket.join(room);
    console.log(`[Socket.io] ${socket.id} joined restaurant room ${room}`);
  });

  socket.on("leave", (restaurantId: unknown) => {
    if (typeof restaurantId !== "string" || !restaurantId.trim()) return;
    const room = restaurantId.trim();
    if (socket.rooms.has(room)) {
      socket.leave(room);
      console.log(`[Socket.io] ${socket.id} left restaurant room ${room}`);
    }
  });

  // Dedicated print room — only PrintStation subscribes here.
  // Captain/cashier sockets join the plain restaurant room above but
  // never join this room, so print_job events are delivered exactly once.
  socket.on("join:print", async (restaurantId: unknown) => {
    if (typeof restaurantId !== "string" || !restaurantId.trim()) return;
    const room = `print:${restaurantId.trim()}`;

    // Validate JWT from socket handshake auth
    const token = (socket.handshake.auth as any)?.token;
    if (!token) {
      console.warn(`[Socket.io] ${socket.id} join:print rejected — no token`);
      socket.emit("auth:error", { message: "Authentication required" });
      return;
    }

    let decoded: any;
    try {
      decoded = verifyToken(token);
    } catch {
      console.warn(`[Socket.io] ${socket.id} join:print rejected — invalid token`);
      socket.emit("auth:error", { message: "Token invalid or expired" });
      return;
    }

    // Validate that the requested print room belongs to the authenticated tenant
    if (decoded.restaurantId !== restaurantId.trim()) {
      console.warn(`[Socket.io] ${socket.id} join:print rejected — cross-tenant access to ${room}`);
      socket.emit("auth:error", { message: "Access denied to this print room" });
      return;
    }

    if (socket.rooms.has(room)) {
      console.warn(`[Socket] DUPLICATE join:print attempt for room: ${room} (${socket.id}) — skipped`);
      return;
    }
    socket.join(room);
    console.log(`[Socket] Client joined print room: ${room} (${socket.id})`);
    // Re-deliver any buffered print jobs from last 60s on PrintStation reconnect
    // Filter out eventIds that have already been printed (server-side dedup)
    const buffered = getRecentPrintJobs(String(restaurantId));
    const notYetPrinted = buffered.filter(j => !printedEventIds.has(j.eventId));
    if (notYetPrinted.length > 0) {
      console.log(`[Socket] Re-delivering ${notYetPrinted.length} buffered KOT(s) on PrintStation reconnect`);
      notYetPrinted.forEach(j => socket.emit('print_job', j.payload));
    }
  });

  // PrintStation acknowledges a print job was printed — mark eventId as printed server-side
  // Also relay the ack to captains/cashiers so they can stop loading
  socket.on("print:ack", (data: any) => {
    if (data?.eventId) {
      printedEventIds.add(data.eventId);
      console.log(`[Socket] Print job acknowledged: ${data.eventId}`);
    }
    // Relay to captains/cashiers if requestId and restaurantId are present
    if (data && typeof data.restaurantId === "string" && data.requestId) {
      const room = data.restaurantId.trim();
      console.log(`[Socket.io] print:ack [${data.requestId}] → room ${room} (status: ${data.status})`);
      io.to(room).emit("kot:printed", { requestId: data.requestId, status: data.status || "success" });
    }
  });

  // Relay waiter calls and actions to other sockets in the restaurant room
  socket.on("waiter:event", (data: any) => {
    if (!data || typeof data.restaurantId !== "string" || !data.type) {
      console.warn(`[Socket.io] waiter:event rejected — invalid data from ${socket.id}:`, data);
      return;
    }
    const room = data.restaurantId.trim();

    // Sender must already be in the room via the initial "join" event.
    // No auto-join — prevents PrintStation sockets from being pulled into
    // regular restaurant rooms and receiving unrelated events.
    if (!socket.rooms.has(room)) {
      console.warn(`[Socket.io] waiter:event sender ${socket.id} is NOT in room ${room} — dropping event`);
      return;
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
    { query: `SELECT "isDeleted" FROM "MenuItem" LIMIT 0`, name: "MenuItem.isDeleted" },
    { query: `SELECT "menuType" FROM "MenuItem" LIMIT 0`, name: "MenuItem.menuType" },
    { query: `SELECT "removedFromBill" FROM "OrderItem" LIMIT 0`, name: "OrderItem.removedFromBill" },
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
  autoSeedIfEmpty(basePrisma).catch((err) => {
    console.error("[Startup] autoSeedIfEmpty error:", err);
  });

  // Keep-alive ping for Render free tier — prevents 15-min spin-down during idle gaps
  const keepAliveInterval = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 10 * 60 * 1000; // 10 min default
  if (keepAliveInterval > 0) {
    setInterval(() => {
      const url = `http://localhost:${PORT}/health`;
      fetch(url)
        .then((r) => r.json())
        .then(() => console.log(`[KeepAlive] Self-ping OK at ${new Date().toISOString()}`))
        .catch((err) => console.warn(`[KeepAlive] Self-ping failed:`, err.message));
    }, keepAliveInterval);
    console.log(`[Startup] Keep-alive self-ping enabled every ${keepAliveInterval}ms`);
  }
});
