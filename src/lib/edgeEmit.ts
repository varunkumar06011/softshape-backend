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

/**
 * Relay business state (orders, KOTs, table status) from one edge to all other
 * connected edge servers for the same restaurant. This is the cross-edge
 * propagation path: when Edge A syncs an order to cloud, the cloud emits this
 * event so Edge B can upsert the order into its local SQLite and show the
 * table as occupied.
 *
 * The originDeviceId is included so the originating edge can skip its own data
 * (it already has the record in SQLite). Other edges apply the upsert.
 *
 * Tables propagated: order, order_item, kot, kot_item, table (business state).
 */
export function emitEdgeBusinessSync(
  restaurantId: string,
  tableName: string,
  data: any,
  originDeviceId: string | null,
): void {
  try {
    const io = getIo();
    const edgeRoom = `edge:${restaurantId}`;
    io.to(edgeRoom).emit("edge:business_sync", {
      table: tableName,
      row: data,
      originDeviceId: originDeviceId || null,
    });
  } catch {
    // Socket not initialized or no edge servers connected — silent fail
  }
}

/**
 * Tell connected edge servers to run reconciliation + immediate sync push.
 * This re-enqueues dead-lettered, rejected, and missing transaction records
 * and pushes them to the cloud. Used by the admin panel's "Recover Missing"
 * button so it works from any browser (the cloud emits this via the existing
 * socket connection — no direct edge server HTTP access needed).
 *
 * Returns true if the event was emitted to at least one connected edge server,
 * false if no edge server is currently connected.
 */
export function emitTriggerReconcile(restaurantId: string): boolean {
  try {
    const io = getIo();
    const edgeRoom = `edge:${restaurantId}`;

    // Check if any edge server is connected to this restaurant's room.
    // Socket.IO stores rooms in io.sockets.adapter.rooms. If the room doesn't
    // exist or has no members, no edge server will receive the event.
    const room = (io as any).sockets?.adapter?.rooms?.get(edgeRoom);
    const hasEdge = room && room.size > 0;
    if (!hasEdge) {
      logger.warn(`[EdgeEmit] Trigger reconcile — no edge server connected to ${edgeRoom}`);
      return false;
    }

    io.to(edgeRoom).emit("edge:trigger_reconcile");
    logger.info(`[EdgeEmit] Trigger reconcile → edge:${restaurantId} (${room.size} edge(s))`);
    return true;
  } catch {
    return false;
  }
}
