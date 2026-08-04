// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO Singleton Accessor
// ─────────────────────────────────────────────────────────────────────────────
// Provides a module-level singleton for the Socket.IO Server instance so that
// route handlers and lib functions (e.g. printQueue, orders) can emit real-time
// events without receiving the server object via dependency injection.
//
// Usage:
//   1. In index.ts at startup:  setIo(io);   // called once after Server creation
//   2. Anywhere else:            const io = getIo(); io.to(room).emit('event', data);
//
// If getIo() is called before setIo(), it throws — this catches initialization
// order bugs early rather than silently failing on event emission.
// ─────────────────────────────────────────────────────────────────────────────

import type { Server } from "socket.io";

// The singleton Socket.IO server instance — null until setIo() is called at startup
let io: Server | null = null;

// Called once during server bootstrap (index.ts) to register the active Socket.IO server.
// After this call, any module can retrieve the instance via getIo().
export function setIo(instance: Server): void {
  io = instance;
}

// Retrieves the singleton Socket.IO server. Throws if setIo() hasn't been called yet —
// this is intentional to surface initialization-order bugs immediately.
// Use this in route handlers or lib functions that need to emit/broadcast socket events.
export function getIo(): Server {
  if (!io) {
    throw new Error("Socket.io has not been initialized");
  }
  return io;
}
