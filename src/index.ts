// ─────────────────────────────────────────────────────────────────────────────
// SoftShape AI Backend — Express Server Entry Point
// ─────────────────────────────────────────────────────────────────────────────
// This is the main server file that bootstraps the entire backend application.
// It sets up:
//   1. Environment variables (dotenv)
//   2. Sentry error tracking
//   3. Express app with CORS, helmet, body parsing, and request logging
//   4. Rate limiting (general API, order creation, auth brute-force protection)
//   5. Health check endpoints
//   6. Socket.IO real-time server (staff rooms, print rooms, public customer rooms)
//   7. All REST API route registrations with middleware chains
//   8. Global error handler with CORS headers on errors
//   9. DB schema probe at startup (fails fast if migrations are missing)
//  10. Auto-seed for dev environments
//  11. Keep-alive self-ping (optional, for Render free tier)
//  12. Periodic cleanup of PrintQueue and ProcessedRequest records
//
// The server listens on PORT (env var, defaults to 3000) and binds to 0.0.0.0
// for container/cloud compatibility (Render, Railway, Docker).
// ─────────────────────────────────────────────────────────────────────────────

// Load environment variables from .env file into process.env
import "dotenv/config";
import logger from "./lib/logger";
import * as Sentry from "@sentry/node";

// Initialize Sentry error tracking — only active if SENTRY_DSN is set.
// tracesSampleRate: 0.1 means 10% of transactions are sampled for performance monitoring.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "production",
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
  enabled: !!process.env.SENTRY_DSN,
  integrations: [
    Sentry.expressIntegration(),
  ],
});

// Warn if VERIFICATION_SECRET is missing or same as JWT_SECRET.
// VERIFICATION_SECRET is used to sign OTP verification proofs during onboarding.
// If it equals JWT_SECRET, rotating JWT_SECRET would invalidate in-progress onboarding OTPs.
if (!process.env.VERIFICATION_SECRET) {
  logger.warn("[Startup] VERIFICATION_SECRET is not set. OTP verification proofs are being signed with JWT_SECRET. Set a separate VERIFICATION_SECRET to avoid invalidating in-progress onboarding if JWT_SECRET is rotated.");
} else if (process.env.VERIFICATION_SECRET === process.env.JWT_SECRET) {
  logger.warn("[Startup] VERIFICATION_SECRET is identical to JWT_SECRET. Rotate VERIFICATION_SECRET to a different value so JWT rotation does not invalidate in-progress onboarding OTP proofs.");
}

// ── Core framework imports ──────────────────────────────────────────────────
import { createServer } from "http";
import cors from "cors";
import helmet from "helmet";
import express, { type NextFunction, type Request, type Response } from "express";
import { Server } from "socket.io";
import pinoHttp from "pino-http";

// ── Route imports — each router handles a specific API domain ────────────────
import menuRouter from "./routes/menu";                    // Menu items, categories, variants
import ordersRouter from "./routes/orders";                // Order creation, KOT, billing, payments
import sectionsRouter from "./routes/sections";            // Table sections/floors within a venue
import tablesRouter from "./routes/tables";                // Table CRUD, status changes, QR codes
import transactionRoutes from "./routes/transactions";    // Payment transactions, settlements
import barMenuRouter from "./routes/barMenu";              // Bar-specific menu management
import barTablesRouter from "./routes/barTables";          // Bar-specific table management
import barInventoryRouter from "./routes/barInventory";    // Bar inventory tracking
import printRouter from "./routes/print";                  // Print job dispatch to PrintStation/Agent
import captainTargetsRouter from "./routes/captainTargets";       // Sales target assignment for captains
import captainAssignmentsRouter from "./routes/captainAssignments"; // Table-to-captain assignments
import payrollRouter from "./routes/payroll";              // Employee payroll calculation
import expendituresRouter from "./routes/expenditures";    // Cash payment expenditures
import ledgerCategoriesRouter from "./routes/ledgerCategories"; // User-creatable ledger categories
import openingBalanceRouter from "./routes/openingBalance";     // One-time opening balance snapshot
import vendorsRouter from "./routes/vendors";                   // Vendor management
import purchaseOrdersRouter from "./routes/purchaseOrders";     // Purchase orders with payments
import cogsRouter from "./routes/cogs";                         // COGS (Cost of Goods Sold)
import fixedAssetsRouter from "./routes/fixedAssets";             // Fixed asset register + depreciation
import liabilitiesRouter from "./routes/liabilities";             // Liabilities ledger (loans, AP, payroll payable)
import equityRouter from "./routes/equity";                       // Owner's equity adjustments + summary
import auditLogRouter from "./routes/auditLog";                   // Tenant-scoped audit trail (read-only)
import xReportRouter from "./routes/xReport";               // Cashier X Report
import dailyBalanceSheetRouter from "./routes/dailyBalanceSheet"; // Daily Balance Sheet
import kitchenInventoryRouter from "./routes/kitchenInventory";   // Kitchen inventory management
import kitchenPrepRouter from "./routes/kitchenPrep";      // Bulk kitchen prep planner
import attendanceRouter from "./routes/attendance";        // Staff attendance tracking
import analyticsRouter from "./routes/analytics";          // Sales analytics, item performance
import reportsRouter from "./routes/reports";              // Report generation (daily, period, etc.)
import spireAgentRouter from "./routes/spireAgent";        // Spire AI agent for restaurant owners
import venueRouter from "./routes/venue";                  // Venue/floor management
import statsRouter from "./routes/stats";                  // Dashboard statistics
import { venuesRouter } from "./routes/venues";            // Multi-venue CRUD
import { onboardRouter } from "./routes/onboard";          // Restaurant onboarding wizard (multi-step)
import { authRouter } from "./routes/auth";                // Authentication (login, PIN, password reset)
import { restaurantRouter } from "./routes/restaurant";    // Restaurant settings management
import { verificationRouter } from "./routes/verification"; // OTP verification (email/phone)
import { superadminRouter } from "./routes/superadmin";    // Superadmin platform management
import { publicRouter } from "./routes/public";            // Public-facing endpoints (QR menu, customer)
import edgeRouter from "./routes/edge";                    // Edge server sync (orders, config changes)
import otaRouter from "./routes/ota";                      // OTA web bundle updates for Android apps

// ── Middleware imports ───────────────────────────────────────────────────────
import { authenticate, optionalAuth, requireRole } from "./middleware/auth";
import { withTenantContext } from "./middleware/tenantContext";
import { resolveKitchenRestaurantId } from "./lib/tenantContext";
import { assertTenantScope } from "./middleware/tenantScope";
import { assertSubscriptionActive } from "./middleware/subscriptionCheck";

// ── Lib imports ──────────────────────────────────────────────────────────────
import { getRecentPrintJobs, markEventIdPrinted, markEventIdFailed } from "./lib/printQueue";
import { verifyToken } from "./lib/auth";
import { resolvePublicRestaurant } from "./lib/resolvePublicRestaurant";
import { verifyTableSignature } from "./lib/tableSignature";
import jwt from "jsonwebtoken";
import { verifyAgentToken } from "./lib/agentToken";
import { setIo } from "./socket";
import { autoSeedIfEmpty } from "./seed";
import prisma, { basePrisma } from "./lib/prisma";
import rateLimit from "express-rate-limit";
import { isCacheReady, getRedisClient } from "./lib/cache";
import RedisStore from "rate-limit-redis";
import { autoSettleBillingRequestedOrders } from "./services/orderService";


// ── Process-level error handlers — catch unhandled errors to prevent silent crashes ──
// uncaughtException: synchronous errors that weren't caught by try/catch anywhere.
// These indicate a corrupted state — exit so the process manager can restart cleanly.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "[FATAL] uncaughtException:");
  process.exit(1);
});

// unhandledRejection: async promise rejections without .catch() handlers.
// Log but do NOT exit — a single unawaited promise in a background interval or
// socket handler should not take down the entire server for all tenants.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "[WARNING] unhandledRejection (non-fatal):");
});

// ── CORS Configuration ──────────────────────────────────────────────────────
// Defines which origins are allowed to make cross-origin requests to the API.
// Includes production domains (softshape.ai, .in, Vercel previews), local dev
// ports, Tauri desktop app origins, and Capacitor Android app origins.
// Additional origins can be configured via CORS_ORIGIN or ALLOWED_ORIGINS env vars
// (comma-separated list).
const DEFAULT_ALLOWED_ORIGINS = [
  "https://api.softshape.in",
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
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:3000",
  "http://localhost:5174",
  "tauri://localhost",
  "https://tauri.localhost",
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
];

// Returns the full list of allowed CORS origins: defaults + any configured via env.
// Deduplicates using Set. Called once at startup for logging and on every request for validation.
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

// Checks whether a given origin string is allowed.
// 1. First checks the explicit allowlist (DEFAULT_ALLOWED_ORIGINS + env-configured)
// 2. Then checks protocol-based patterns:
//    - tauri: protocol → any Tauri desktop app
//    - capacitor: protocol → Android app
//    - https://tauri.localhost → Windows Tauri builds
//    - https://localhost → Capacitor Android on HTTPS
//    - https://*.vercel.app → any Vercel preview deployment
function isAllowedOrigin(origin: string): boolean {
  if (getAllowedOrigins().includes(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    // Allow any Tauri desktop app origin (tauri://localhost, tauri://app, etc.)
    if (protocol === "tauri:") return true;
    // Allow Capacitor Android app origin (capacitor://localhost)
    if (protocol === "capacitor:") return true;
    // Allow Tauri app origin on Windows builds that use https://tauri.localhost
    if (protocol === "https:" && hostname === "tauri.localhost") return true;
    // Allow Capacitor Android on https://localhost scheme
    if (protocol === "https:" && hostname === "localhost") return true;
    return protocol === "https:" && hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

// CORS origin validator function used by both Express CORS and Socket.IO CORS.
// Returns true if origin is allowed, throws an Error in the callback if blocked.
// Requests with no Origin header (server-to-server, curl) are always allowed.
const corsOrigin: cors.CorsOptions["origin"] = (origin, callback) => {
  if (!origin || isAllowedOrigin(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`CORS blocked origin: ${origin}`));
};

// Full CORS options object — shared between Express middleware and Socket.IO.
// credentials: true allows cookies/auth headers in cross-origin requests.
// Required env vars: DATABASE_URL, DIRECT_URL (Supabase). PORT is set by Render at runtime.
const corsOptions: cors.CorsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma", "X-Requested-With", "sentry-trace", "baggage"],
  optionsSuccessStatus: 200,
};

// ── Express App Initialization & Middleware Stack ───────────────────────────
// trust proxy: 1 — Render/Railway use reverse proxies; this ensures req.ip
// reflects the real client IP (not the proxy IP) for accurate rate limiting.
const app = express();
app.set('trust proxy', 1); // Render/Railway reverse proxy — enables accurate req.ip for rate limiting

// Helmet sets security headers (CSP, X-Frame-Options, etc.).
// crossOriginEmbedderPolicy is disabled to allow cross-origin resource loading.
app.use(helmet({ crossOriginEmbedderPolicy: false }));

// Create the HTTP server that both Express and Socket.IO will use.
const httpServer = createServer(app);

// Enable CORS with the configured options
app.use(cors(corsOptions));

// ── Body Parsing ─────────────────────────────────────────────────────────────
// Razorpay webhook needs the RAW body for signature verification, so it gets
// express.raw() before express.json() intercepts it. All other routes use JSON.
// Raw body for Razorpay webhook signature verification (must be before express.json)
app.use("/api/onboard/payment/razorpay-webhook", express.raw({ type: "application/json", limit: "10mb" }));
// Skip JSON parsing for the Razorpay webhook route (raw body already consumed)
app.use((req, res, next) => {
  if (req.path === "/api/onboard/payment/razorpay-webhook") {
    return next();
  }
  express.json({ limit: "10mb" })(req, res, next);
});
// Skip URL-encoded parsing for the Razorpay webhook route
app.use((req, res, next) => {
  if (req.path === "/api/onboard/payment/razorpay-webhook") {
    return next();
  }
  express.urlencoded({ extended: true, limit: "10mb" })(req, res, next);
});

// ── HTTP Request Logging (pino-http) ─────────────────────────────────────────
// Logs every HTTP request with method, URL, restaurantId, and status code.
// Log level is based on response status: 5xx=error, 4xx=warn, else info.
app.use(pinoHttp({
  logger,
  customLogLevel: (_req, res) => res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, restaurantId: (req as any).user?.restaurantId }),
    res: (res) => ({ statusCode: res.statusCode })
  }
}));

// ── Rate Limiters ───────────────────────────────────────────────────────────
// Three tiers of rate limiting protect against different attack vectors:
//   1. General API: 300 req/min per IP — covers all /api/ routes
//   2. Order creation: 60 req/10s per restaurant — prevents retry storms from captains
//   3. Auth: 10 login attempts / 15 min per email+IP — brute-force protection
// When Redis is configured, rate-limit-redis store is used for multi-instance sync.
// Prerequisite: npm install rate-limit-redis

const redisClient = getRedisClient();
// Use Redis-backed rate limiting only when explicitly enabled. By default use memory store
// to avoid burning through the Upstash request limit on every /api/ request.
const useRedisRateLimit = process.env.REDIS_RATE_LIMIT === 'true';
const redisStoreOpts = useRedisRateLimit && redisClient ? {
  store: new RedisStore({ sendCommand: (...args: any[]) => (redisClient as any).call(...args) }),
} : {};

// General API rate limit — 2000 requests per minute per IP or per user.
// For authenticated requests we key by JWT userId so all users behind a shared
// proxy/NAT don't share one bucket. Unauthenticated requests still fall back to IP.
// A restaurant with 10 captains all actively using the app generates ~60 req/min max.
// Set to 2000 to accommodate heavy admin panel batch operations (e.g. bulk item edits,
// Cloudinary URL repair sends PATCH requests in batches of 5 for many items).
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
  keyGenerator: (req: Request) => {
    try {
      const token = req.headers.authorization?.slice(7);
      if (token) {
        const decoded = jwt.decode(token) as any;
        if (decoded?.userId) return decoded.userId;
      }
    } catch (err) {
      logger.warn({ ip: req.ip }, "[RateLimiter] JWT decode failed, falling back to IP-based rate limit");
    }
    return req.ip || 'unknown';
  },
  skip: (req: Request) => req.path === "/health", // never rate-limit health checks
  ...redisStoreOpts,
});

// Order creation rate limiter — tighter than general API to prevent retry storms.
// Keyed per restaurantId (extracted from JWT) so all captains in one restaurant share
// a single bucket, rather than per-IP which unfairly groups unrelated restaurants on shared NAT.
// 60 orders per 10 seconds = 10 captains × ~6 orders/10s max.
const orderCreateLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 60,  // 10 captains × ~6 orders/10s = 60; was 30 which caused false positives
  keyGenerator: (req: Request) => {
    try {
      const token = req.headers.authorization?.slice(7);
      if (token) {
        const decoded = jwt.decode(token) as any;
        return decoded?.restaurantId || req.ip || 'unknown';
      }
    } catch (err) {
      logger.warn({ ip: req.ip }, "[RateLimiter] JWT decode failed, falling back to IP-based rate limit");
    }
    return req.ip || 'unknown';
  },
  message: { error: "Too many orders in a short time, please wait a moment" },
  standardHeaders: true,
  legacyHeaders: false,
  ...redisStoreOpts,
});

// Auth login brute-force protection — 10 attempts per 15 minutes per email+IP.
// Keyed by email+IP so a single attacker can't lock out legitimate users at the same IP.
const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    return email ? `${email}:${req.ip}` : req.ip || 'unknown';
  },
  message: { error: 'Too many login attempts, please wait 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  ...redisStoreOpts,
});

// Forgot-password rate limit — 5 requests per 15 minutes per email+IP.
// Prevents email-flooding attacks on the password reset endpoint.
const authForgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req: Request) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    return email ? `${email}:${req.ip}` : req.ip || 'unknown';
  },
  message: { error: 'Too many password-reset requests, please wait 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  ...redisStoreOpts,
});

// Reset-password rate limit — 5 attempts per 15 minutes per IP.
// Prevents brute-forcing the reset token.
const authResetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  message: { error: 'Too many reset attempts, please wait 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  ...redisStoreOpts,
});

// Spire AI agent rate limit — 30 requests per minute per restaurant.
// Keyed by restaurantId from the JWT so all users in one outlet share a bucket.
// Uses a fresh RedisStore instance because rate-limit-redis does not allow sharing
// a Store across multiple limiters.
const spireLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: Request) => {
    try {
      const token = req.headers.authorization?.slice(7);
      if (token) {
        const decoded = jwt.decode(token) as any;
        if (decoded?.restaurantId) return decoded.restaurantId;
      }
    } catch (err) {
      logger.warn({ ip: req.ip }, '[RateLimiter] Spire JWT decode failed, falling back to IP');
    }
    return req.ip || 'unknown';
  },
  message: { error: 'Spire request limit reached. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  ...(useRedisRateLimit && redisClient ? { store: new RedisStore({ sendCommand: (...args: any[]) => (redisClient as any).call(...args) }) } : {}),
});

// ── Apply rate limiters to routes ────────────────────────────────────────────
app.use("/api/", apiLimiter);
// Apply order-creation limiter to POST only — PATCH/GET must never be blocked by this guard
app.post("/api/orders", orderCreateLimiter);
app.post("/api/spire/ask", spireLimiter);
app.post("/api/auth/login", authLoginLimiter);
app.post("/api/auth/verify-password", authLoginLimiter);
app.post("/api/auth/forgot-password", authForgotPasswordLimiter);
app.post("/api/auth/reset-password", authResetPasswordLimiter);

// ── Health Check Endpoints ───────────────────────────────────────────────────
// GET / — basic service info (no auth required)
app.get("/", (_req, res) => {
  res.json({ service: "softshape-backend", status: "ok", build: "v7.0.0" });
});

// GET /health — lightweight health check for Render/Railway uptime monitoring.
// Returns 503 if the DB schema probe failed at startup, otherwise 200.
app.get("/health", (_req, res) => {
  if (schemaProbeFailed) {
    res.status(503).json({ status: "degraded", schemaProbeFailed: true, timestamp: new Date().toISOString() });
  } else {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  }
});

// GET /api/health — deep health check that tests the database connection.
// Returns 200 with db: "connected" if the DB query succeeds, 503 if it fails.
app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const redisOk = isCacheReady();
    res.json({ ok: true, db: "connected", redis: redisOk ? "connected" : "not_configured", ts: Date.now() });
  } catch (err: any) {
    res.status(503).json({ ok: false, db: "disconnected", error: err.message, ts: Date.now() });
  }
});

// ─── Socket.io Configuration ─────────────────────────────────────────
// Socket.IO provides real-time communication for:
//   - Staff (captains/cashiers): join restaurant room, receive waiter calls, KOT print status
//   - PrintStation: join print room, receive print_job events, send print:ack
//   - Windows Print Agent: join print room via agent token, receive print_job events
//   - Public (customers): join public room via HMAC signature, call waiter, view menu
//
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

// Register the Socket.IO instance in the singleton accessor so route handlers can emit events.
setIo(io);

// ── Redis Adapter for Socket.io (opt-in via REDIS_URL) ──────────────────────
// When REDIS_URL is set, Socket.IO uses Redis pub/sub for multi-instance scaling.
// This allows multiple backend instances to broadcast events to all connected clients.
// Without Redis, events only reach clients connected to the same instance.
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

// ── REST API Route Registrations ────────────────────────────────────────────
// Each route is mounted under /api/<path> with a middleware chain:
//   optionalAuth    — parses JWT if present, but doesn't require it
//   authenticate    — requires a valid JWT (401 if missing/invalid)
//   assertTenantScope — ensures the user only accesses their own tenant's data
//   assertSubscriptionActive — checks the restaurant's subscription is active (not expired)
//   withTenantContext — loads restaurant/outlet/org data into req for downstream handlers
//
// Routes without authenticate: menu (optional auth for public menu), onboard, auth, verify, public, print
app.use("/api/menu", optionalAuth, menuRouter);
app.use("/api/orders", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, ordersRouter);
app.use("/api/sections", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, sectionsRouter);
app.use("/api/tables", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, tablesRouter);
app.use("/api/transactions", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, transactionRoutes);
app.use("/api/bar/menu", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, barMenuRouter);
app.use("/api/bar/tables", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, barTablesRouter);
app.use("/api/bar/inventory", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, barInventoryRouter);
app.use("/api/print", printRouter);
app.use("/api/captain-assignments", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, captainAssignmentsRouter);
app.use("/api/captain-targets", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, captainTargetsRouter);
app.use("/api/payroll", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, payrollRouter);
app.use("/api/expenditures", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, expendituresRouter);
app.use("/api/vouchers", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, expendituresRouter);
app.use("/api/ledger-categories", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, ledgerCategoriesRouter);
app.use("/api/opening-balance", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, openingBalanceRouter);
app.use("/api/vendors", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, vendorsRouter);
app.use("/api/purchase-orders", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, purchaseOrdersRouter);
app.use("/api/xreports", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, xReportRouter);
app.use("/api/balance-sheet", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, dailyBalanceSheetRouter);
app.use("/api/attendance", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, attendanceRouter);
app.use("/api/inventory/kitchen", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, kitchenInventoryRouter);
app.use("/api/cogs", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, cogsRouter);
app.use("/api/fixed-assets", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, fixedAssetsRouter);
app.use("/api/liabilities", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, liabilitiesRouter);
app.use("/api/equity", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, equityRouter);
app.use("/api/audit-log", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, auditLogRouter);
app.use("/api/kitchen-prep", optionalAuth, kitchenPrepRouter);
app.use("/api/analytics", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, analyticsRouter);
app.use("/api/reports", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, reportsRouter);
app.use("/api/spire", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, spireAgentRouter);
app.use("/api/venue", optionalAuth, withTenantContext, venueRouter);
app.use("/api/venues", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, venuesRouter);
app.use("/api/stats", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, statsRouter);
app.use("/api/onboard", onboardRouter);
app.use("/api/auth", authRouter);
app.use("/api/verify", verificationRouter);
app.use("/api/restaurant", authenticate, assertTenantScope, assertSubscriptionActive, withTenantContext, restaurantRouter);
app.use("/api/superadmin", superadminRouter);
app.use("/api/public", publicRouter);
// Edge server routes — sync receiver, config download, changes endpoint
// The /register endpoint handles its own token verification (no authenticate middleware).
// All other edge routes require authenticate (JWT) for tenant validation.
app.use("/api/edge", edgeRouter);

// OTA web bundle updates — public endpoint, no auth required.
// Android apps check this on startup for JS bundle updates.
app.use("/api/ota", otaRouter);

// ── Desktop App Auto-Updater Endpoint ────────────────────────────────────────
// Tauri v1 updater calls: GET /api/updates/:app/:target/:current_version
// :app = admin | cashier | print-agent
// :target = windows-x86_64 | darwin-x86_64 | darwin-aarch64 | linux-x86_64
// Returns 200 with update manifest if a newer version exists, 204 if up-to-date.
app.get("/api/updates/:app/:target/:current_version", async (req, res) => {
  try {
    const { app: appName, target, current_version } = req.params;
    const LATEST_VERSION = process.env.DESKTOP_APP_LATEST_VERSION || "1.2.7";
    const DOWNLOAD_BASE = process.env.DESKTOP_APP_DOWNLOAD_URL || "https://github.com/varunkumar06011/softshape-print-agent/releases/download";

    // Compare versions (semver)
    const parseVer = (v: string) => v.split('.').map(Number);
    const [curMajor, curMinor, curPatch] = parseVer(current_version);
    const [newMajor, newMinor, newPatch] = parseVer(LATEST_VERSION);

    const isNewer = (newMajor > curMajor) ||
      (newMajor === curMajor && newMinor > curMinor) ||
      (newMajor === curMajor && newMinor === curMinor && newPatch > curPatch);

    if (!isNewer) {
      return res.status(204).send();
    }

    // Map Tauri platform target to file extension
    const platformExtMap: Record<string, string> = {
      'windows-x86_64': '-setup.exe',
      'darwin-x86_64': '.app.tar.gz',
      'darwin-aarch64': '.app.tar.gz',
      'linux-x86_64': '.AppImage',
    };
    const ext = platformExtMap[target] || '-setup.exe';

    // Platform-specific signature env var names per app:
    // e.g. ADMIN_DESKTOP_APP_SIGNATURE_WINDOWS, CASHIER_DESKTOP_APP_SIGNATURE_WINDOWS
    const appPrefix = appName.toUpperCase().replace(/-/g, '_');
    const platformSuffixMap: Record<string, string> = {
      'windows-x86_64': 'WINDOWS',
      'darwin-x86_64': 'MACOS',
      'darwin-aarch64': 'MACOS_ARM',
      'linux-x86_64': 'LINUX',
    };
    const platformSuffix = platformSuffixMap[target] || 'WINDOWS';

    // Try app+platform-specific signature first, then app-generic, then global
    const signature =
      process.env[`${appPrefix}_DESKTOP_APP_SIGNATURE_${platformSuffix}`] ||
      process.env[`${appPrefix}_DESKTOP_APP_SIGNATURE`] ||
      process.env[`DESKTOP_APP_SIGNATURE_${platformSuffix}`] ||
      process.env.DESKTOP_APP_SIGNATURE || "";

    // Build download URL: {base}/v{version}/{app}-{platform}{ext}
    // e.g. https://github.com/.../releases/download/v1.2.7/admin-windows-setup.exe
    const url = `${DOWNLOAD_BASE}/v${LATEST_VERSION}/${appName}-${target}${ext}`;

    // Return Tauri v1 updater manifest
    res.json({
      version: LATEST_VERSION,
      notes: `SoftShape ${appName} update to v${LATEST_VERSION}`,
      pub_date: new Date().toISOString(),
      platforms: {
        [target]: {
          signature,
          url,
        },
      },
    });
  } catch (err: any) {
    logger.error({ err }, '[Updates] Error serving update manifest');
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

// ── Socket.IO Connection Handler ─────────────────────────────────────────────
// Called once per client connection. Handles room joins, event relay, and disconnection.
// Rooms are tenant-scoped: each restaurant gets its own room keyed by restaurantId.
io.on("connection", (socket) => {
  logger.info(`[Socket.io] Client connected: ${socket.id} (transport: ${socket.conn.transport.name})`);

  socket.conn.on("upgrade", (transport: { name: string }) => {
    logger.info(`[Socket.io] ${socket.id} upgraded to ${transport.name}`);
  });

  // ── 'join' event — staff (captain/cashier/admin) joins their restaurant room ──
  // Validates JWT from socket handshake auth, checks the requested room matches
  // the authenticated tenant, and joins the socket to the room.
  // This room receives waiter:event and kot:printed broadcasts.
  socket.on("join", async (restaurantId: unknown) => {
    if (typeof restaurantId !== "string" || !restaurantId.trim()) return;
    const room = restaurantId.trim();

    // Validate JWT from socket handshake auth
    const token = (socket.handshake.auth as any)?.token;
    if (!token) {
      logger.warn(`[Socket.io] ${socket.id} join rejected — no token`);
      socket.emit("auth:error", { message: "Authentication required" });
      return;
    }

    let decoded: any;
    try {
      decoded = verifyToken(token);
    } catch {
      logger.warn(`[Socket.io] ${socket.id} join rejected — invalid token`);
      socket.emit("auth:error", { message: "Token invalid or expired" });
      return;
    }

    // Validate that the requested room belongs to the authenticated tenant
    // Use activeRestaurantId (the switched-to outlet) instead of restaurantId (home outlet)
    const effectiveRestaurantId = decoded.activeRestaurantId || decoded.restaurantId;
    if (effectiveRestaurantId !== room) {
      logger.warn(`[Socket.io] ${socket.id} join rejected — cross-tenant access to ${room}`);
      socket.emit("auth:error", { message: "Access denied to this restaurant room" });
      return;
    }

    // Prevent duplicate room membership on reconnect
    if (socket.rooms.has(room)) {
      logger.info(`[Socket.io] ${socket.id} already in room ${room} — skipping duplicate join`);
      return;
    }
    socket.join(room);
    logger.info(`[Socket.io] ${socket.id} joined restaurant room ${room}`);
  });

  // ── 'leave' event — staff leaves a restaurant room (e.g. on logout/switch) ──
  socket.on("leave", (restaurantId: unknown) => {
    if (typeof restaurantId !== "string" || !restaurantId.trim()) return;
    const room = restaurantId.trim();
    if (socket.rooms.has(room)) {
      socket.leave(room);
      logger.info(`[Socket.io] ${socket.id} left restaurant room ${room}`);
    }
  });

  // ── 'join:kitchen' event — staff joins the shared kitchen room for low-stock alerts ──
  socket.on("join:kitchen", async (kitchenId: unknown) => {
    if (typeof kitchenId !== "string" || !kitchenId.trim()) return;
    const room = `kitchen:${kitchenId.trim()}`;

    // Validate JWT from socket handshake auth
    const token = (socket.handshake.auth as any)?.token;
    if (!token) {
      logger.warn(`[Socket.io] ${socket.id} join:kitchen rejected — no token`);
      socket.emit("auth:error", { message: "Authentication required" });
      return;
    }

    let decoded: any;
    try {
      decoded = verifyToken(token);
    } catch {
      logger.warn(`[Socket.io] ${socket.id} join:kitchen rejected — invalid token`);
      socket.emit("auth:error", { message: "Token invalid or expired" });
      return;
    }

    // Validate that the requested kitchen belongs to the authenticated tenant
    const effectiveRestaurantId = decoded.activeRestaurantId || decoded.restaurantId;
    const resolvedKitchenId = await resolveKitchenRestaurantId(effectiveRestaurantId);
    if (resolvedKitchenId !== kitchenId.trim()) {
      logger.warn(`[Socket.io] ${socket.id} join:kitchen rejected — kitchen ${kitchenId} does not belong to tenant`);
      socket.emit("auth:error", { message: "Access denied to this kitchen room" });
      return;
    }

    // Prevent duplicate room membership on reconnect
    if (socket.rooms.has(room)) {
      logger.info(`[Socket.io] ${socket.id} already in kitchen room ${room} — skipping duplicate join`);
      return;
    }
    socket.join(room);
    logger.info(`[Socket.io] ${socket.id} joined kitchen room ${room}`);
  });

  // ── 'join:print' event — PrintStation joins the dedicated print room ──
  // Print rooms are separate from staff rooms so print_job events are delivered
  // exactly once (only PrintStation subscribes here, not captains/cashiers).
  // On join, any buffered PENDING print jobs from the last 3 minutes are re-delivered
  // to handle PrintStation reconnect after network interruption.
  // Dedicated print room — only PrintStation subscribes here.
  // Captain/cashier sockets join the plain restaurant room above but
  // never join this room, so print_job events are delivered exactly once.
  socket.on("join:print", async (restaurantId: unknown) => {
    if (typeof restaurantId !== "string" || !restaurantId.trim()) return;
    const room = `print:${restaurantId.trim()}`;

    // Validate JWT from socket handshake auth
    const token = (socket.handshake.auth as any)?.token;
    if (!token) {
      logger.warn(`[Socket.io] ${socket.id} join:print rejected — no token`);
      socket.emit("auth:error", { message: "Authentication required" });
      return;
    }

    let decoded: any;
    try {
      decoded = verifyToken(token);
    } catch {
      logger.warn(`[Socket.io] ${socket.id} join:print rejected — invalid token`);
      socket.emit("auth:error", { message: "Token invalid or expired" });
      return;
    }

    // Validate that the requested print room belongs to the authenticated tenant
    // Use activeRestaurantId (the switched-to outlet) instead of restaurantId (home outlet)
    const effectivePrintRestaurantId = decoded.activeRestaurantId || decoded.restaurantId;
    if (effectivePrintRestaurantId !== restaurantId.trim()) {
      logger.warn(`[Socket.io] ${socket.id} join:print rejected — cross-tenant access to ${room}`);
      socket.emit("auth:error", { message: "Access denied to this print room" });
      return;
    }

    if (socket.rooms.has(room)) {
      logger.warn(`[Socket] DUPLICATE join:print attempt for room: ${room} (${socket.id}) — skipped`);
      return;
    }
    socket.join(room);
    logger.info(`[Socket] Client joined print room: ${room} (${socket.id})`);
    // Re-deliver any buffered print jobs from last 3min on PrintStation reconnect
    // Only re-deliver PENDING jobs (PRINTED ones are already done)
    (async () => {
      const buffered = await getRecentPrintJobs(String(restaurantId));
      if (buffered.length > 0) {
        logger.info(`[Socket] Re-delivering ${buffered.length} buffered KOT(s) on PrintStation reconnect`);
        buffered.forEach(j => socket.emit('print_job', j.payload));
      }
    })();
  });

  // ── 'print:ack' event — PrintStation acknowledges a print job ──
  // Marks the job as PRINTED or FAILED in the PrintQueue DB.
  // Also relays the ack to the staff restaurant room so captains/cashiers
  // can stop their loading spinners and show success/failure UI.
  // Verifies the socket is actually in the room to prevent ack spoofing.
  // PrintStation acknowledges a print job was printed — mark eventId as printed in DB
  // Also relay the ack to captains/cashiers so they can stop loading
  socket.on("print:ack", (data: any) => {
    if (data?.eventId) {
      if (data.status === "failed") {
        markEventIdFailed(data.eventId, data.error);
        logger.info(`[Socket] Print job FAILED: ${data.eventId} — ${data.error || 'unknown'}`);
      } else {
        markEventIdPrinted(data.eventId);
        logger.info(`[Socket] Print job acknowledged: ${data.eventId}`);
      }
    }
    // Relay to captains/cashiers if requestId and restaurantId are present
    // Verify the socket is actually in the room to prevent spoofing
    if (data && typeof data.restaurantId === "string" && data.requestId) {
      const room = data.restaurantId.trim();
      const socketRooms = Array.from(socket.rooms);
      if (socketRooms.includes(room) || socketRooms.includes(`print:${room}`)) {
        logger.info(`[Socket.io] print:ack [${data.requestId}] → room ${room} (status: ${data.status})`);
        const allowedStatuses = ["success", "failed", "pending", "timeout"];
        const status = allowedStatuses.includes(data.status) ? data.status : "success";
        io.to(room).emit("kot:printed", { requestId: data.requestId, status });
      } else {
        logger.warn(`[Socket.io] print:ack blocked — socket ${socket.id} not in room ${room}`);
      }
    }
  });

  // ── 'agent:join' event — Windows Print Agent joins the print room ──
  // Agent authenticates with its session token (not a JWT) and joins the same
  // print room as PrintStation. Both can coexist — jobs are delivered to all
  // sockets in the print room. Buffered PENDING jobs are re-delivered on join.
  // ─── Windows Print Agent socket join ──────────────────────────────────────
  // Agent authenticates with its session token and joins the same print room.
  // This is separate from the browser PrintStation join:print — both can coexist.
  socket.on("agent:join", async (payload: unknown) => {
    if (typeof payload !== "object" || !payload) return;
    const { restaurantId, sessionToken, stations, printerNames } = payload as { restaurantId?: string; sessionToken?: string; stations?: string[]; printerNames?: string[] };
    if (!restaurantId || !sessionToken) {
      socket.emit("auth:error", { message: "restaurantId and sessionToken required" });
      return;
    }

    let decoded: any;
    try {
      decoded = verifyAgentToken(sessionToken);
    } catch {
      socket.emit("auth:error", { message: "Agent session token invalid or expired" });
      return;
    }

    if (decoded.purpose !== "agent-session" || decoded.restaurantId !== restaurantId) {
      socket.emit("auth:error", { message: "Token mismatch" });
      return;
    }

    // Join the general print room for backward compatibility and buffered job re-delivery
    const room = `print:${restaurantId}`;
    if (!socket.rooms.has(room)) {
      socket.join(room);
      logger.info(`[Socket] Windows Agent joined print room: ${room} (${socket.id})`);
    }

    // Join printer-specific rooms for targeted delivery (avoids broadcasting to all agents)
    // Rooms: print:<restaurantId>:<type> (e.g. KOT, BAR_KOT, FINAL_BILL)
    //        print:<restaurantId>:<printerName> (e.g. "Kitchen Printer", "Bar Printer")
    if (Array.isArray(stations)) {
      for (const st of stations) {
        const stRoom = `print:${restaurantId}:${st}`;
        if (!socket.rooms.has(stRoom)) {
          socket.join(stRoom);
          logger.info(`[Socket] Agent joined station room: ${stRoom} (${socket.id})`);
        }
      }
    }
    if (Array.isArray(printerNames)) {
      for (const pn of printerNames) {
        const pnRoom = `print:${restaurantId}:${pn}`;
        if (!socket.rooms.has(pnRoom)) {
          socket.join(pnRoom);
          logger.info(`[Socket] Agent joined printer room: ${pnRoom} (${socket.id})`);
        }
      }
    }

    // Re-deliver buffered jobs the agent may have missed while offline
    const buffered = await getRecentPrintJobs(restaurantId);
    if (buffered.length > 0) {
      logger.info(`[Socket] Re-delivering ${buffered.length} buffered job(s) to agent`);
      buffered.forEach((j) => socket.emit("print_job", j.payload));
    }

    socket.emit("agent:joined", { restaurantId, room, bufferedCount: buffered.length });
  });

  // ── 'join:public' event — customer joins a public room via QR code ──
  // Customers don't have JWT tokens. They authenticate with an HMAC signature
  // computed from (slug + tableId + restaurantId). The signature is embedded in
  // the QR code URL and verified server-side to prevent unauthorized access.
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
      logger.warn(`[Socket.io] ${socket.id} join:public rejected — invalid signature`);
      socket.emit("auth:error", { message: "Invalid table signature" });
      return;
    }

    const room = `public:${resolved.restaurantId}`;
    if (!socket.rooms.has(room)) {
      socket.join(room);
      logger.info(`[Socket.io] ${socket.id} joined public room ${room}`);
    }
    socket.emit("public:joined", { restaurantId: resolved.restaurantId, tableId });
  });

  // ── 'public:waiter:event' — customer calls a waiter via public socket ──
  // Verifies the customer's HMAC signature, checks they're in the public room,
  // then relays the event to the STAFF restaurant room using io.to() (not socket.to()
  // because the customer socket is in public:room, not the staff room).
  // Includes the table number from DB for display to staff.
  // Customer emits waiter call via public socket — backend relays to staff room
  socket.on("public:waiter:event", async (data: any) => {
    if (!data || typeof data.slug !== "string" || typeof data.tableId !== "string" || !data.type) {
      logger.warn(`[Socket.io] public:waiter:event rejected — invalid data from ${socket.id}`);
      return;
    }

    const resolved = await resolvePublicRestaurant(data.tableId, data.slug);
    if (!resolved) {
      logger.warn(`[Socket.io] public:waiter:event — restaurant/table not found`);
      return;
    }

    if (!verifyTableSignature(data.slug, data.tableId, resolved.restaurantId, data.sig)) {
      logger.warn(`[Socket.io] public:waiter:event — invalid signature from ${socket.id}`);
      return;
    }

    const publicRoom = `public:${resolved.restaurantId}`;
    if (!socket.rooms.has(publicRoom)) {
      logger.warn(`[Socket.io] public:waiter:event — sender ${socket.id} not in ${publicRoom}`);
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

    logger.info(
      `[Socket.io] public:waiter:event [${data.type}] from ${socket.id} → room ${resolved.restaurantId}`
    );
    io.to(resolved.restaurantId).emit("waiter:event", { type: data.type, payload });
  });

  // ── 'waiter:event' — staff-to-staff real-time event relay ──
  // Captains/cashiers emit waiter calls, table status changes, etc. to other
  // staff in the same restaurant room. The sender must already be in the room
  // (via 'join' event) — no auto-join to prevent PrintStation sockets from
  // being pulled into regular restaurant rooms.
  // Relay waiter calls and actions to other sockets in the restaurant room
  socket.on("waiter:event", (data: any) => {
    if (!data || typeof data.restaurantId !== "string" || !data.type) {
      logger.warn(`[Socket.io] waiter:event rejected — invalid data from ${socket.id}:`, data);
      return;
    }
    const room = data.restaurantId.trim();

    // Sender must already be in the room via the initial "join" event.
    // No auto-join — prevents PrintStation sockets from being pulled into
    // regular restaurant rooms and receiving unrelated events.
    if (!socket.rooms.has(room)) {
      logger.warn(`[Socket.io] waiter:event sender ${socket.id} is NOT in room ${room} — dropping event`);
      return;
    }

    // Count how many OTHER sockets are in this room to aid debugging
    const roomSockets = io.sockets.adapter.rooms.get(room);
    const recipientCount = roomSockets ? roomSockets.size - 1 : 0; // exclude sender

    logger.info(
      `[Socket.io] waiter:event [${data.type}] from ${socket.id} → room ${room} ` +
      `(${recipientCount} recipient(s), payload: ${JSON.stringify(data.payload)})`
    );

    socket.to(room).emit("waiter:event", { type: data.type, payload: data.payload });
  });

  // ── 'edge:register' event — Edge server connects and joins edge room ──
  // Edge server authenticates with its session token and joins a dedicated
  // edge room. Cloud emits config changes to this room for real-time sync.
  socket.on("edge:register", async (payload: unknown) => {
    if (typeof payload !== "object" || !payload) return;
    const { restaurantId, sessionToken, edgeVersion } = payload as {
      restaurantId?: string;
      sessionToken?: string;
      edgeVersion?: string;
    };

    if (!restaurantId || !sessionToken) {
      socket.emit("auth:error", { message: "restaurantId and sessionToken required" });
      return;
    }

    let decoded: any;
    try {
      decoded = verifyToken(sessionToken);
    } catch {
      socket.emit("auth:error", { message: "Edge session token invalid or expired" });
      return;
    }

    const effectiveRestaurantId = decoded.activeRestaurantId || decoded.restaurantId;
    if (effectiveRestaurantId !== restaurantId) {
      socket.emit("auth:error", { message: "Token does not match restaurant" });
      return;
    }

    const edgeRoom = `edge:${restaurantId}`;
    if (!socket.rooms.has(edgeRoom)) {
      socket.join(edgeRoom);
      logger.info(`[Socket.io] Edge server ${socket.id} joined edge room ${edgeRoom} (v${edgeVersion || "unknown"})`);
    }
    socket.emit("edge:registered", { restaurantId, room: edgeRoom });
  });

  // ── 'edge:heartbeat' event — Edge server sends periodic heartbeat ──
  // Cloud acknowledges to confirm the connection is healthy.
  socket.on("edge:heartbeat", (data: any) => {
    if (!data || typeof data.restaurantId !== "string") return;
    const edgeRoom = `edge:${data.restaurantId}`;
    if (socket.rooms.has(edgeRoom)) {
      socket.emit("edge:heartbeat_ack", { timestamp: Date.now() });
    }
  });

  // ── 'disconnect' event — log client disconnection ──
  socket.on("disconnect", () => {
    logger.info(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

// ── Global Error Handler ────────────────────────────────────────────────────
// Sentry's error handler runs first to capture exceptions in Sentry.
// Then our custom handler logs the error and returns a 500 JSON response.
// CORS headers are manually set on error responses to prevent the browser from
// masking the real error with a generic NetworkError/CORS block.
app.use(Sentry.expressErrorHandler() as any);
app.use((err: Error & { code?: string }, req: Request, res: Response, next: NextFunction) => {
  // Capture Prisma errors with extra context for debugging
  if (err.code && err.code.startsWith('P')) {
    Sentry.captureException(err, {
      tags: { prismaCode: err.code, restaurantId: (req as any).user?.restaurantId },
      extra: { route: req.path, method: req.method },
    });
  }
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

// ── Server Startup ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;

logger.info(`[Startup] NODE_ENV=${process.env.NODE_ENV}`);
logger.info(`[Startup] PORT env=${process.env.PORT} → listening on ${PORT}`);
logger.info(`[Startup] DATABASE_URL set=${Boolean(process.env.DATABASE_URL)}`);
logger.info(`[Startup] CORS allowed origins=${getAllowedOrigins().join(", ")} + https://*.vercel.app`);

// ── DB Schema Probe ─────────────────────────────────────────────────────────
// At startup, probes the database for expected columns and tables to catch
// schema/migration drift immediately. If any probe fails, the server logs a
// FATAL error, initiates graceful shutdown (closes HTTP server), and exits.
// This prevents the server from running with a partially-migrated database.
let schemaProbeFailed = false;

// Runs all schema probes sequentially. If any fails, sets schemaProbeFailed=true
// and initiates graceful shutdown. Each probe checks a specific column or table.
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
    // New Venue/Floor/PriceProfile/TaxProfile schema probes
    { query: `SELECT 1 FROM "Venue" LIMIT 0`, name: "Venue table" },
    { query: `SELECT 1 FROM "Floor" LIMIT 0`, name: "Floor table" },
    { query: `SELECT 1 FROM "PriceProfile" LIMIT 0`, name: "PriceProfile table" },
    { query: `SELECT 1 FROM "PriceProfileItem" LIMIT 0`, name: "PriceProfileItem table" },
    { query: `SELECT 1 FROM "TaxProfile" LIMIT 0`, name: "TaxProfile table" },
    { query: `SELECT "venueId" FROM "Section" LIMIT 0`, name: "Section.venueId" },
    { query: `SELECT "floorId" FROM "Section" LIMIT 0`, name: "Section.floorId" },
    { query: `SELECT "venueId" FROM "User" LIMIT 0`, name: "User.venueId" },
    { query: `SELECT "venuesMigrated" FROM "Outlet" LIMIT 0`, name: "Outlet.venuesMigrated" },
  ];

  for (const check of checks) {
    try {
      await prisma.$queryRawUnsafe(check.query);
      logger.info(`[DB] Schema probe OK — ${check.name} confirmed`);
    } catch (e: any) {
      logger.warn(`[DB] WARNING: ${check.name} missing from database — running in degraded mode.`);
      logger.warn('[DB] Run: npx prisma migrate deploy to fix this.');
      logger.warn({ err: e }, '[DB] Raw error');
      schemaProbeFailed = true;
      // Continue running in degraded mode — health endpoint reports schemaProbeFailed=true
      // so monitoring (Render/Railway uptime checks) can alert and restart after migration.
      // Do NOT process.exit — crashing production because one optional column is missing
      // on an old tenant causes downtime for all tenants.
      return;
    }
  }
}

// Fire-and-forget the schema probe — sets schemaProbeFailed=true if any check fails.
// Server continues in degraded mode; health endpoint reports the failure for monitoring.
probeDbSchema();

// ── Start Listening ───────────────────────────────────────────────────────────
// Binds to 0.0.0.0 for container/cloud compatibility. On successful listen:
//   1. Runs autoSeedIfEmpty() for dev environments
//   2. Starts keep-alive self-ping if KEEP_ALIVE_INTERVAL_MS is set (Render free tier)
//   3. Starts periodic cleanup of PrintQueue and ProcessedRequest records
httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`[Startup] Server running on 0.0.0.0:${PORT}`);
  // Auto-seed menu + tables from menu.txt if the DB is empty (dev only)
  autoSeedIfEmpty(basePrisma).catch((err) => {
    logger.error({ err }, "[Startup] autoSeedIfEmpty error");
  });

  // ── Keep-alive self-ping (optional) ──────────────────────────────────────
  // Prevents Render free tier from spinning down the server after 15 min idle.
  // Set KEEP_ALIVE_INTERVAL_MS=600000 (10 min) in env to enable.
  // Disabled by default (interval = 0).
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

  // ── Periodic Cleanup (every 10 minutes) ───────────────────────────────────
  // 1. PrintQueue: delete PRINTED rows older than 1 hour, PENDING/FAILED older than 24 hours
  // 2. ProcessedRequest: prune idempotency records older than 7 days
  // This prevents the DB from growing indefinitely with stale records.
  // When Redis is configured, a distributed lock ensures only one instance runs cleanup.
  // Fail-open: if Redis is down or not configured, cleanup runs on every instance (safe — deleteMany is idempotent).
  setInterval(async () => {
    const redis = getRedisClient();
    let acquiredLock = true;
    const lockKey = 'cleanup:lock';
    try {
      if (redis) {
        // Try to acquire a lock with 9-minute TTL (slightly less than interval to prevent overlap)
        const result = await redis.set(lockKey, '1', 'EX', 540, 'NX');
        acquiredLock = result === 'OK';
      }

      if (!acquiredLock) return;

      const now = Date.now();
      await prisma.printQueue.deleteMany({
        where: {
          OR: [
            { status: 'PRINTED', createdAt: { lt: new Date(now - 60 * 60_000) } },
            { status: { in: ['PENDING', 'FAILED'] }, createdAt: { lt: new Date(now - 24 * 60 * 60_000) } },
          ],
        },
      });

      // Prune ProcessedRequest records older than 7 days
      const pruned = await prisma.processedRequest.deleteMany({
        where: { createdAt: { lt: new Date(now - 7 * 24 * 60 * 60_000) } },
      });
      if (pruned.count > 0) {
        logger.info(`[ProcessedRequest] Pruned ${pruned.count} old idempotency records`);
      }
    } catch (err) {
      logger.error({ err }, '[PrintQueue] Cleanup failed');
    } finally {
      // Release the lock so the next interval on any instance can acquire it immediately
      if (redis && acquiredLock) {
        try { await redis.del(lockKey); } catch { /* non-fatal */ }
      }
    }
  }, 10 * 60_000);

  // ── Stale PRINTED Job Reconciliation (every 60 seconds) ─────────────────────
  // Finds print jobs marked PRINTED more than 90 seconds ago where no agent is
  // currently connected to the restaurant's print room. These are jobs where the
  // agent may have crashed after the optimistic ACK but before the actual print
  // completed. Reverts them to PENDING so they get re-delivered on next reconnect.
  setInterval(async () => {
    try {
      const staleJobs = await prisma.printQueue.findMany({
        where: {
          status: 'PRINTED',
          printedAt: { lt: new Date(Date.now() - 90_000) },
        },
        select: { id: true, eventId: true, restaurantId: true },
      });

      for (const job of staleJobs) {
        const room = `print:${job.restaurantId}`;
        const connectedSockets = await (io as any).adapter.sockets(new Set([room]));
        if (connectedSockets.size === 0) {
          await prisma.printQueue.update({
            where: { id: job.id },
            data: { status: 'PENDING', printedAt: null },
          });
          logger.info(`[PrintQueue] Reverted stale PRINTED job ${job.eventId} to PENDING — no agent connected`);
        }
      }
    } catch (err) {
      logger.error({ err }, '[PrintQueue] Stale PRINTED reconciliation failed');
    }
  }, 60_000);

  // ── Periodic Auto-Settle Stuck BILLING_REQUESTED Orders (every 5 minutes) ──
  // Finds orders stuck in BILLING_REQUESTED for more than 24 hours and
  // auto-settles them with CASH payment using backend-calculated totals.
  // This is a safety net — the primary fix is that settleOrderService no longer
  // rejects on total mismatch. But if anything else causes a settlement to fail
  // silently, this ensures the order still becomes a transaction with items
  // included in analytics. The 24-hour threshold avoids interfering with
  // active billing flows where the cashier is still processing payment.
  // Additionally, auto-settle is skipped during operating hours (6 AM–midnight IST)
  // to prevent bills from settling while the restaurant is still open for business.
  setInterval(async () => {
    try {
      // Skip auto-settle during operating hours (6:00 AM – 11:59 PM IST)
      const nowIst = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
      const istHour = new Date(nowIst).getHours();
      if (istHour >= 6 && istHour < 24) {
        // Restaurant is operating — don't auto-settle
        return;
      }

      const restaurants = await prisma.outlet.findMany({
        select: { id: true },
      });
      for (const r of restaurants) {
        try {
          const result = await autoSettleBillingRequestedOrders(r.id, 'CASH', 24 * 60);
          if (result.settled.length > 0) {
            logger.info(`[AutoSettle] Restaurant ${r.id}: settled ${result.settled.length} stuck orders`);
          }
          if (result.failed.length > 0) {
            logger.warn(`[AutoSettle] Restaurant ${r.id}: ${result.failed.length} orders failed to auto-settle`);
          }
        } catch (err: any) {
          // Don't let one restaurant's failure stop others
          logger.error({ err }, `[AutoSettle] Error for restaurant ${r.id}:`, err.message);
        }
      }
    } catch (err: any) {
      logger.error({ err }, '[AutoSettle] Periodic check failed:', err.message);
    }
  }, 5 * 60_000);

  // ── Periodic Auto-Expire Specials (every 5 minutes) ────────────────────────
  // Finds menu items flagged as isSpecial where specialExpiresAt < now and
  // specialActive is still true, and sets specialActive = false.
  // This ensures expired specials are deactivated server-side even if no
  // client is actively checking. Uses Redis distributed lock when available.
  setInterval(async () => {
    const redis = getRedisClient();
    let acquiredLock = true;
    const lockKey = 'specials:expire:lock';
    try {
      if (redis) {
        const result = await redis.set(lockKey, '1', 'EX', 270, 'NX');
        acquiredLock = result === 'OK';
      }
      if (!acquiredLock) return;

      const now = new Date();
      const expired = await basePrisma.menuItem.updateMany({
        where: {
          isSpecial: true,
          specialActive: true,
          specialExpiresAt: { lt: now },
        },
        data: { specialActive: false },
      });

      if (expired.count > 0) {
        logger.info(`[AutoExpire] Deactivated ${expired.count} expired special(s)`);
      }
    } catch (err) {
      logger.error({ err }, '[AutoExpire] Failed to auto-expire specials');
    } finally {
      if (redis && acquiredLock) {
        try { await redis.del(lockKey); } catch { /* non-fatal */ }
      }
    }
  }, 5 * 60_000);
});
