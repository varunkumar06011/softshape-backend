import "dotenv/config";
import { createServer } from "http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import menuRouter from "./routes/menu";
import tablesRouter from "./routes/tables";
import { setIo } from "./socket";

// Required env vars: DATABASE_URL, PORT, FRONTEND_URL
const app = express();
const httpServer = createServer(app);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE"],
    credentials: false,
  },
  transports: ["polling", "websocket"],
  allowEIO3: true,
  path: "/socket.io/",
  pingTimeout: 60000,
  pingInterval: 25000,
});

setIo(io);

app.use(cors());
app.use(express.json());

app.use("/api/menu", menuRouter);
app.use("/api/tables", tablesRouter);

io.on("connection", (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);
  socket.on("disconnect", () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

httpServer.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
