// ─────────────────────────────────────────────────────────────────────────────
// edgeEmit.ts — Helper to emit config changes to connected edge servers
// ─────────────────────────────────────────────────────────────────────────────
// When a config change happens on the cloud (menu item added, price updated,
// table reconfigured, etc.), this helper emits the change to any connected
// edge servers via Socket.IO.
//
// Usage in route handlers:
//   import { emitConfigChange, emitConfigBatch } from "../lib/edgeEmit";
//
//   // After updating a menu item:
//   emitConfigChange(restaurantId, "menu_item", "upsert", updatedItem);
//
//   // After bulk updating prices:
//   emitConfigBatch(restaurantId, [
//     { table: "menu_item", operation: "upsert", row: item1 },
//     { table: "venue_price", operation: "upsert", row: price1 },
//   ]);
// ─────────────────────────────────────────────────────────────────────────────

import { getIo } from "../socket";
import logger from "./logger";

interface ConfigChange {
  table: string;
  operation: string;
  row: any;
}

/**
 * Emit a single config change to all connected edge servers for a restaurant.
 * The edge server's socketSync module receives this and applies it to local SQLite.
 */
export function emitConfigChange(
  restaurantId: string,
  table: string,
  operation: string,
  row: any,
): void {
  try {
    const io = getIo();
    const edgeRoom = `edge:${restaurantId}`;
    io.to(edgeRoom).emit("edge:config_change", { table, operation, row });
    logger.info(`[EdgeEmit] ${table} ${operation} → edge:${restaurantId}`);
  } catch {
    // Socket not initialized or no edge servers connected — silent fail
  }
}

/**
 * Emit a batch of config changes to all connected edge servers.
 * More efficient than emitting individual changes for bulk operations.
 */
export function emitConfigBatch(restaurantId: string, changes: ConfigChange[]): void {
  if (!changes || changes.length === 0) return;
  try {
    const io = getIo();
    const edgeRoom = `edge:${restaurantId}`;
    io.to(edgeRoom).emit("edge:config_batch", { changes });
    logger.info(`[EdgeEmit] Batch of ${changes.length} changes → edge:${restaurantId}`);
  } catch {
    // Socket not initialized — silent fail
  }
}

/**
 * Tell all connected edge servers to do a full config resync.
 * The edge server will call GET /api/edge/config to reload everything.
 */
export function emitFullResync(restaurantId: string): void {
  try {
    const io = getIo();
    const edgeRoom = `edge:${restaurantId}`;
    io.to(edgeRoom).emit("edge:full_resync");
    logger.info(`[EdgeEmit] Full resync requested → edge:${restaurantId}`);
  } catch {
    // Socket not initialized — silent fail
  }
}

/**
 * Emit a table status update to edge servers.
 * This is a lighter payload than a full config change — only the fields
 * that changed are sent.
 */
export function emitTableUpdate(
  restaurantId: string,
  tableId: string,
  updates: {
    status?: string;
    workflowStatus?: string;
    currentBill?: number;
    captainId?: string;
    guests?: number;
  },
): void {
  try {
    const io = getIo();
    const edgeRoom = `edge:${restaurantId}`;
    io.to(edgeRoom).emit("edge:table_update", {
      table: { id: tableId, ...updates },
    });
  } catch {
    // Socket not initialized — silent fail
  }
}
