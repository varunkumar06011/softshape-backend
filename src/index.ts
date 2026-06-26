import "dotenv/config";
import * as Sentry from "@sentry/node";
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "production",
  tracesSampleRate: 0.1,
  enabled: !!process.env.SENTRY_DSN,
});

if (!process.env.VERIFICATION_SECRET) {
  console.warn("[Startup] VERIFICATION_SECRET is not set. OTP verification proofs are being signed with JWT_SECRET. Set a separate VERIFICATION_SECRET to avoid invalidating in-progress onboarding if JWT_SECRET is rotated.");
} else if (process.env.VERIFICATION_SECRET === process.env.JWT_SECRET) {
  console.warn("[Startup] VERIFICATION_SECRET is identical to JWT_SECRET. Rotate VERIFICATION_SECRET to a different value so JWT rotation does not invalidate in-progress onboarding OTP proofs.");
}

import { createServer } from "http";
import cors from "cors";
import helmet from "helmet";
import express, { type NextFunction, type Request, type Response } from "express";
import { Server } from "socket.io";
import pinoHttp from "pino-http";
import logger from "./lib/logger";
import menuRouter from "./routes/menu";
import ordersRouter from "./routes/orders";
import sectionsRouter from "./routes/sections";
import tablesRouter from "./routes/tables";
import transactionRoutes from "./routes/transactions";
import barMenuRouter from "./routes/barMenu";
import barTablesRouter from "./routes/barTables";
import barInventoryRouter from "./routes/barInventory";
import printRouter from "./routes/print";
import captainTargetsRouter from "./routes/captainTargets";
import captainAssignmentsRouter from "./routes/captainAssignments";
import payrollRouter from "./routes/payroll";
import kitchenInventoryRouter from "./routes/kitchenInventory";
import analyticsRouter from "./routes/analytics";
import reportsRouter from "./routes/reports";
import venueRouter from "./routes/venue";
import statsRouter from "./routes/stats";
import { onboardRouter } from "./routes/onboard";
import { authRouter } from "./routes/auth";
import { restaurantRouter } from "./routes/restaurant";
import { verificationRouter } from "./routes/verification";
import { superadminRouter } from "./routes/superadmin";
import { publicRouter } from "./routes/public";
import { authenticate, optionalAuth, requireRole } from "./middleware/auth";
import { withTenantContext } from "./middleware/tenantContext";
import { getRecentPrintJobs, markEventIdPrinted } from "./lib/printQueue";
import { assertTenantScope } from "./middleware/tenantScope";
import { assertSubscriptionActive } from "./middleware/subscriptionCheck";
import { verifyToken } from "./lib/auth";
import { resolvePublicRestaurant } from "./lib/resolvePublicRestaurant";
import { verifyTableSignature } from "./lib/tableSignature";
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
  process.exit(1);
});

const DEFAULT_ALLOWED_ORIGINS = [
  "https://softshape-backend.onrender.com",
  "https://softshapeai.vercel.app",
  "https://softshape-ai.vercel.app",
  "https://softshape-ai-demo.vercel.app",
  "https://softshape.ai",
  "https://www.softshape.ai",
  "https://softshape.in",
  "https://www.softshape.in",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:3000",
  "http://localhost:5174",
  "tauri://localhost",
  "https://tauri.localhost",
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
    // Allow any Tauri desktop app origin (tauri://localhost, tauri://app, etc.)
    if (protocol === "tauri:") return true;
    // Allow Tauri app origin on Windows builds that use https://tauri.localhost
    if (protocol === "https:" && hostname === "tauri.localhost") return true;
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
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma", "X-Requested-With", "sentry-trace", "baggage"],
  optionsSuccessStatus: 200,
};

const app = express();
app.set('trust proxy', 1); // Render/Railway reverse proxy — enables accurate req.ip for rate limiting
app.use(helmet({ crossOriginEmbedderPolicy: false }));
const httpServer = createServer(app);

app.use(cors(corsOptions));
// Raw body for Razorpay webhook signature verification (must be before express.json)
app.use("/api/onboard/payment/razorpay-webhook", express.raw({ type: "application/json", limit: "10mb" }));
app.use((req, res, next) => {
  if (req.path === "/api/onboard/payment/razorpay-webhook") {
    return next();
  }
  express.json({ limit: "10mb" })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === "/api/onboard/payment/razorpay-webhook") {
    return next();
  }
  express.urlencoded({ extended: true, limit: "10mb" })(req, res, next);
});
app.use(pinoHttp({
  logger,
  customLogLevel: (_req, res) => res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, restaurantId: (req as any).user?.restaurantId }),
    res: (res) => ({ statusCode: res.statusCode })
  }
}));

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
  keyGenerator: (req: Request) => {
    try {
      const token = req.headers.authorization?.slice(7);
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
        return decoded.restaurantId || req.ip || 'unknown';
      }
    } catch { /* fall through to IP */ }
    return req.ip || 'unknown';
  },
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
    allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma", "X-Requested-With", "sentry-trace", "baggage"],
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

// ── Redis Adapter for Socket.io (opt-in via REDIS_URL) ──────────────────────
const redisUrl = process.env.REDIS_URL;
if (redisUrl) {
  Promise.all([
    import("@socket.io/redis-adapter"),
    import("ioredis"),
  ]).then(([{ createAdapter }, { Redis }]) => {
    const pubClient = new Redis(redisUrl);
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    logger.info("[Socket.io] Redis adapter enabled for horizontal scaling");
  }).catch((err) => {
    logger.warn({ err }, "[Socket.io] Redis adapter failed to initialize");
  });
}

app.use("/api/menu", optionalAuth, menuRouter);
app.use("/api/orders", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, ordersRouter);
app.use("/api/sections", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, sectionsRouter);
app.use("/api/tables", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, tablesRouter);
app.use("/api/transactions", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, transactionRoutes);
app.use("/api/bar/menu", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, barMenuRouter);
app.use("/api/bar/tables", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, barTablesRouter);
app.use("/api/bar/inventory", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, barInventoryRouter);
app.use("/api/print", authenticate, printRouter);
app.use("/api/captain-assignments", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, captainAssignmentsRouter);
app.use("/api/captain-targets", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, captainTargetsRouter);
app.use("/api/payroll", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, payrollRouter);
app.use("/api/inventory/kitchen", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, kitchenInventoryRouter);
app.use("/api/analytics", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, analyticsRouter);
app.use("/api/reports", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, reportsRouter);
app.use("/api/venue", optionalAuth, venueRouter);
app.use("/api/stats", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, statsRouter);
app.use("/api/onboard", onboardRouter);
app.use("/api/auth", authRouter);
app.use("/api/verify", verificationRouter);
app.use("/api/restaurant", authenticate, assertSubscriptionActive, restaurantRouter);
app.use("/api/superadmin", authenticate, superadminRouter);
app.use("/api/public", publicRouter);

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
    // Re-deliver any buffered print jobs from last 3min on PrintStation reconnect
    // Only re-deliver PENDING jobs (PRINTED ones are already done)
    (async () => {
      const buffered = await getRecentPrintJobs(String(restaurantId));
      if (buffered.length > 0) {
        console.log(`[Socket] Re-delivering ${buffered.length} buffered KOT(s) on PrintStation reconnect`);
        buffered.forEach(j => socket.emit('print_job', j.payload));
      }
    })();
  });

  // PrintStation acknowledges a print job was printed — mark eventId as printed in DB
  // Also relay the ack to captains/cashiers so they can stop loading
  socket.on("print:ack", (data: any) => {
    if (data?.eventId) {
      markEventIdPrinted(data.eventId);
      console.log(`[Socket] Print job acknowledged: ${data.eventId}`);
    }
    // Relay to captains/cashiers if requestId and restaurantId are present
    // Verify the socket is actually in the room to prevent spoofing
    if (data && typeof data.restaurantId === "string" && data.requestId) {
      const room = data.restaurantId.trim();
      const socketRooms = Array.from(socket.rooms);
      if (socketRooms.includes(room) || socketRooms.includes(`print:${room}`)) {
        console.log(`[Socket.io] print:ack [${data.requestId}] → room ${room} (status: ${data.status})`);
        io.to(room).emit("kot:printed", { requestId: data.requestId, status: data.status || "success" });
      } else {
        console.warn(`[Socket.io] print:ack blocked — socket ${socket.id} not in room ${room}`);
      }
    }
  });

  // ─── Windows Print Agent socket join ──────────────────────────────────────
  // Agent authenticates with its session token and joins the same print room.
  // This is separate from the browser PrintStation join:print — both can coexist.
  socket.on("agent:join", async (payload: unknown) => {
    if (typeof payload !== "object" || !payload) return;
    const { restaurantId, sessionToken } = payload as { restaurantId?: string; sessionToken?: string };
    if (!restaurantId || !sessionToken) {
      socket.emit("auth:error", { message: "restaurantId and sessionToken required" });
      return;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      socket.emit("auth:error", { message: "JWT_SECRET not configured" });
      return;
    }
    let decoded: any;
    try {
      decoded = jwt.verify(sessionToken, secret);
    } catch {
      socket.emit("auth:error", { message: "Agent session token invalid or expired" });
      return;
    }

    if (decoded.purpose !== "agent-session" || decoded.restaurantId !== restaurantId) {
      socket.emit("auth:error", { message: "Token mismatch" });
      return;
    }

    const room = `print:${restaurantId}`;
    if (!socket.rooms.has(room)) {
      socket.join(room);
      console.log(`[Socket] Windows Agent joined print room: ${room} (${socket.id})`);
    }

    // Re-deliver buffered jobs the agent may have missed while offline
    const buffered = await getRecentPrintJobs(restaurantId);
    if (buffered.length > 0) {
      console.log(`[Socket] Re-delivering ${buffered.length} buffered job(s) to agent`);
      buffered.forEach((j) => socket.emit("print_job", j.payload));
    }

    socket.emit("agent:joined", { restaurantId, room, bufferedCount: buffered.length });
  });

  // ─── Public (customer-facing) socket join ──────────────────────────────
  // Customers don't have JWT tokens. They join a separate public room
  // verified by HMAC signature (slug + tableId + restaurantId + sig).
  socket.on("join:public", async (payload: unknown) => {
    if (typeof payload !== "object" || !payload) return;
    const { slug, tableId, sig } = payload as { slug?: string; tableId?: string; sig?: string };
    if (!slug || !tableId || !sig) {
      socket.emit("auth:error", { message: "slug, tableId, and sig are required" });
      return;
    }

    const resolved = await resolvePublicRestaurant(tableId, slug);
    if (!resolved) {
      socket.emit("auth:error", { message: "Restaurant or table not found" });
      return;
    }

    if (!verifyTableSignature(slug, tableId, resolved.restaurantId, sig)) {
      console.warn(`[Socket.io] ${socket.id} join:public rejected — invalid signature`);
      socket.emit("auth:error", { message: "Invalid table signature" });
      return;
    }

    const room = `public:${resolved.restaurantId}`;
    if (!socket.rooms.has(room)) {
      socket.join(room);
      console.log(`[Socket.io] ${socket.id} joined public room ${room}`);
    }
    socket.emit("public:joined", { restaurantId: resolved.restaurantId, tableId });
  });

  // Customer emits waiter call via public socket — backend relays to staff room
  socket.on("public:waiter:event", async (data: any) => {
    if (!data || typeof data.slug !== "string" || typeof data.tableId !== "string" || !data.type) {
      console.warn(`[Socket.io] public:waiter:event rejected — invalid data from ${socket.id}`);
      return;
    }

    const resolved = await resolvePublicRestaurant(data.tableId, data.slug);
    if (!resolved) {
      console.warn(`[Socket.io] public:waiter:event — restaurant/table not found`);
      return;
    }

    if (!verifyTableSignature(data.slug, data.tableId, resolved.restaurantId, data.sig)) {
      console.warn(`[Socket.io] public:waiter:event — invalid signature from ${socket.id}`);
      return;
    }

    const publicRoom = `public:${resolved.restaurantId}`;
    if (!socket.rooms.has(publicRoom)) {
      console.warn(`[Socket.io] public:waiter:event — sender ${socket.id} not in ${publicRoom}`);
      return;
    }

    // Relay to the STAFF restaurant room using io.to() (not socket.to())
    // because the customer socket is in public:room, not the staff room.
    const table = await prisma.table.findUnique({
      where: { id: data.tableId },
      select: { number: true },
    });

    const payload = {
      ...data.payload,
      tableId: data.tableId,
      tableNumber: table?.number,
      restaurantId: resolved.restaurantId,
    };

    console.log(
      `[Socket.io] public:waiter:event [${data.type}] from ${socket.id} → room ${resolved.restaurantId}`
    );
    io.to(resolved.restaurantId).emit("waiter:event", { type: data.type, payload });
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

app.use(Sentry.expressErrorHandler() as any);
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err, stack: err.stack }, "Unhandled error");
  if (res.headersSent) return next(err);

  // Ensure CORS headers are present on error responses so the browser
  // doesn't mask the real error with a generic NetworkError/CORS block.
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.status(500).json({ error: err.message });
});

const PORT = Number(process.env.PORT) || 3000;

logger.info(`[Startup] NODE_ENV=${process.env.NODE_ENV}`);
logger.info(`[Startup] PORT env=${process.env.PORT} → listening on ${PORT}`);
logger.info(`[Startup] DATABASE_URL set=${Boolean(process.env.DATABASE_URL)}`);
logger.info(`[Startup] CORS allowed origins=${getAllowedOrigins().join(", ")} + https://*.vercel.app`);

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
    { query: `SELECT "lastWaiterCallAt" FROM "Table" LIMIT 0`, name: "Table.lastWaiterCallAt" },
  ];

  for (const check of checks) {
    try {
      await prisma.$queryRawUnsafe(check.query);
      logger.info(`[DB] Schema probe OK — ${check.name} confirmed`);
    } catch (e: any) {
      logger.error(`[DB] FATAL: ${check.name} missing from database.`);
      logger.error('[DB] Run: npx prisma migrate deploy');
      logger.error({ err: e }, '[DB] Raw error');
      process.exit(1); // Fail fast at startup rather than runtime
    }
  }
}

probeDbSchema(); // fire-and-forget; exits process if any column/table is missing

httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`[Startup] Server running on 0.0.0.0:${PORT}`);
  // Auto-seed menu + tables from menu.txt if the DB is empty
  autoSeedIfEmpty(basePrisma).catch((err) => {
    logger.error({ err }, "[Startup] autoSeedIfEmpty error");
  });

  // Keep-alive ping — disabled by default. Set KEEP_ALIVE_INTERVAL_MS=600000 for Render free tier.
  const keepAliveInterval = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 0;
  if (keepAliveInterval > 0) {
    setInterval(() => {
      const url = `http://localhost:${PORT}/health`;
      fetch(url)
        .then((r) => r.json())
        .then(() => logger.info(`[KeepAlive] Self-ping OK at ${new Date().toISOString()}`))
        .catch((err) => logger.warn({ err }, `[KeepAlive] Self-ping failed`));
    }, keepAliveInterval);
    logger.info(`[Startup] Keep-alive self-ping enabled every ${keepAliveInterval}ms`);
  }

  // PrintQueue cleanup — delete rows older than 1 hour every 10 minutes
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - 60 * 60_000);
      await prisma.printQueue.deleteMany({ where: { createdAt: { lt: cutoff } } });
    } catch (err) {
      logger.error({ err }, '[PrintQueue] Cleanup failed');
    }
  }, 10 * 60_000);
});
