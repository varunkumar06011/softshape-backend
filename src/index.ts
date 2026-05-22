import "dotenv/config";
import { createServer } from "http";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { Server } from "socket.io";
import menuRouter from "./routes/menu";
import tablesRouter from "./routes/tables";
import { setIo } from "./socket";

// Required env vars: DATABASE_URL, PORT, FRONTEND_URL
const allowedOrigins = [
  "https://softshape-ai-demo.vercel.app",
  "https://softshape-ai.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4173",
];

const app = express();
const httpServer = createServer(app);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      console.warn(`[CORS] Blocked origin: ${origin}`);
      return callback(new Error(`CORS blocked: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ service: "softshape-backend", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    credentials: true,
  },
  transports: ["polling", "websocket"],
  allowEIO3: true,
  path: "/socket.io/",
  pingTimeout: 60000,
  pingInterval: 25000,
});

setIo(io);

app.use("/api/menu", menuRouter);
app.use("/api/tables", tablesRouter);

io.on("connection", (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);
  socket.on("disconnect", () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  console.error("[Error]", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;

console.log(`[Startup] PORT env var is: ${process.env.PORT}`);
console.log(`[Startup] Listening on: ${PORT}`);

httpServer.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
