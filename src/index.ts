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

const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST", "PATCH", "DELETE"],
  },
});

setIo(io);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/menu", menuRouter);
app.use("/api/tables", tablesRouter);

io.on("connection", (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);
  socket.on("disconnect", () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
