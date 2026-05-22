import "dotenv/config";
import { createServer } from "http";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { PrismaClient } from "@prisma/client";
import { Server } from "socket.io";
import menuRouter from "./routes/menu";
import tablesRouter from "./routes/tables";
import { setIo } from "./socket";
import { autoSeedIfEmpty } from "./seed";

const prisma = new PrismaClient();

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});

// Required env vars: DATABASE_URL, DIRECT_URL (Supabase). PORT is set by Railway at runtime.
const corsOptions: cors.CorsOptions = {
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
  optionsSuccessStatus: 200,
};

const app = express();
const httpServer = createServer(app);

app.use(cors(corsOptions));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ service: "softshape-backend", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Socket.io Configuration ─────────────────────────────────────────
// Railway's reverse proxy needs specific Socket.io settings to avoid 502:
//  1. addTrailingSlash: false — prevents path mismatch with Railway's proxy
//  2. transports: polling first — Railway proxy handles polling reliably,
//     websocket upgrade can happen after initial polling handshake
//  3. path without trailing slash
const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  },
  // Railway proxy-friendly settings
  addTrailingSlash: false,
  transports: ["polling", "websocket"],
  allowEIO3: true,
  path: "/socket.io",
  pingTimeout: 60000,
  pingInterval: 25000,
  // Allow upgrades from polling to websocket
  allowUpgrades: true,
  // Increase HTTP long-polling timeout for Railway
  httpCompression: true,
});

setIo(io);

app.use("/api/menu", menuRouter);
app.use("/api/tables", tablesRouter);

io.on("connection", (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id} (transport: ${socket.conn.transport.name})`);

  socket.conn.on("upgrade", (transport: { name: string }) => {
    console.log(`[Socket.io] ${socket.id} upgraded to ${transport.name}`);
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

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[Startup] Server running on 0.0.0.0:${PORT}`);
  // Auto-seed menu + tables from menu.txt if the DB is empty
  autoSeedIfEmpty(prisma).catch((err) => {
    console.error("[Startup] autoSeedIfEmpty error:", err);
  });
});
